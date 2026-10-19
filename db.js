// ============================================================
// db.js — Conexão e acesso ao banco SQLite (substitui os JSON)
// Banco: database_futuros.sqlite (na raiz do projeto)
//
// Duas tabelas:
//  - active_slots  : posições abertas no momento (ex etf_portfolio.json)
//  - trade_history : operações já fechadas, p/ os relatórios
//
// O pacote sqlite3 é assíncrono/callback. Aqui envelopamos as três
// operações básicas (run/get/all) em Promises p/ usar async/await.
// ============================================================
// Fuso horário: garante America/Sao_Paulo mesmo se db.js for carregado
// isolado (ex.: scripts de migração). O modificador 'localtime' do
// SQLite usa o TZ deste processo para converter epoch -> data local.
process.env.TZ = 'America/Sao_Paulo';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// ARQUIVO DO BANCO — ÚNICO no sistema (consolidação de 2026-07-27).
//
// O default era `database.sqlite`, o banco do Spot, e a env DB_FILE
// existia só para o motor de Futuros escapar dele durante a transição.
// Com o Spot desativado a relação se inverte: o banco de Futuros é O
// banco, e o default aponta direto para ele. Um esquecimento de env
// deixava de ser inofensivo — abriria o arquivo do Spot e o robô
// operaria contra active_slots/trade_history de um mercado que não
// existe mais.
const DB_FILE = process.env.DB_FILE
  ? path.resolve(__dirname, process.env.DB_FILE)
  : path.join(__dirname, 'database_futuros.sqlite');

const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error(`[DB] Falha ao abrir ${DB_FILE}:`, err.message);
    return;
  }
  console.log(`[DB] Conectado em ${DB_FILE}`);

  // ----------------------------------------------------------
  // PRAGMAS DE CONCORRÊNCIA (2026-07-28)
  // ----------------------------------------------------------
  // Este arquivo é aberto por DOIS processos: `camada1-radar` (server.js,
  // que escreve) e `camada2-gatilho` (camada2_monitor.js, READONLY). O
  // WAL já estava ligado no header do arquivo, mas o busy_timeout NUNCA
  // foi declarado do lado do ESCRITOR — ficava no default de 1000ms do
  // node-sqlite3. Um segundo é pouco: basta um checkpoint do WAL coincidir
  // com a gravação de um slot para a escrita voltar SQLITE_BUSY, e a
  // gravação que falha é justamente a de `active_slots` logo depois de
  // uma ordem REAL ter sido preenchida — posição aberta na corretora sem
  // linha no banco, que a auditoria depois enxerga como órfã.
  //
  // 15s é o mesmo valor usado pela Camada 2, para os dois lados esperarem
  // igual. `synchronous = NORMAL` é o modo recomendado com WAL: mantém a
  // durabilidade contra queda de PROCESSO (que é o risco real aqui —
  // restart do PM2) e só abre mão da durabilidade contra queda de
  // ENERGIA, em troca de não fazer fsync a cada commit.
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 15000');
  db.run('PRAGMA synchronous = NORMAL');
  // Checkpoint automático a cada ~1000 páginas (≈4 MB de WAL). Explícito
  // porque um WAL que cresce sem parar degrada TODA leitura do banco.
  db.run('PRAGMA wal_autocheckpoint = 1000', (e) => {
    if (e) console.error('[DB] Falha ao aplicar PRAGMAs de concorrência:', e.message);
    else console.log('[DB] PRAGMAs: WAL · busy_timeout 15s · synchronous NORMAL · autocheckpoint 1000');
  });
});

// ------------------------------------------------------------
// Wrappers Promise
// ------------------------------------------------------------
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this); // this.lastID / this.changes
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// ------------------------------------------------------------
// Inicialização: cria as tabelas se não existirem
// ------------------------------------------------------------
async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS active_slots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol        TEXT    NOT NULL,
      buy_price     REAL    NOT NULL,
      quantity      REAL    NOT NULL,
      invested_usdt REAL    NOT NULL,
      buy_time      INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS trade_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol        TEXT    NOT NULL,
      buy_price     REAL    NOT NULL,
      sell_price    REAL    NOT NULL,
      quantity      REAL    NOT NULL,
      invested_usdt REAL    NOT NULL,
      pnl_usdt      REAL    NOT NULL,
      pnl_percent   REAL    NOT NULL,
      buy_time      INTEGER NOT NULL,
      sell_time     INTEGER NOT NULL,
      close_reason  TEXT    NOT NULL
    )
  `);

  // ----------------------------------------------------------
  // daily_snapshots: banca total (USDT) capturada às 00:00 de cada
  // dia. Base do cálculo de % do PnL Diário (juros compostos):
  // % = PnL do dia / initial_balance.
  // ----------------------------------------------------------
  await run(`
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      date            TEXT PRIMARY KEY,
      initial_balance REAL NOT NULL
    )
  `);

  // ----------------------------------------------------------
  // Migração segura: coluna alerta_recuperacao em active_slots.
  // Flag do "Modo Fuga" do Take Profit Dinâmico (0/1, default 0).
  // ALTER TABLE envolto em try/catch: se a coluna já existir, o
  // SQLite lança "duplicate column name" e nós ignoramos. Assim a
  // próxima inicialização não quebra independentemente do estado.
  // ----------------------------------------------------------
  try {
    await run(
      `ALTER TABLE active_slots ADD COLUMN alerta_recuperacao INTEGER NOT NULL DEFAULT 0`
    );
    console.log('[DB] Coluna alerta_recuperacao criada em active_slots');
  } catch (err) {
    if (/duplicate column name/i.test(err.message)) {
      console.log('[DB] Coluna alerta_recuperacao já existe (ok)');
    } else {
      console.error('[DB] Falha ao migrar alerta_recuperacao:', err.message);
    }
  }

  // ----------------------------------------------------------
  // Migração segura: gestão de risco ESTRUTURAL (2026-07-06).
  //   stop_price     : preço do Stop Loss estrutural (fundo - 0.2%,
  //                    com teto de risco -5%). 0 = sem stop calculado.
  //   peak_price     : topo máximo alcançado após ativar o trailing.
  //   trailing_ativo : 1 quando o Perseguidor de Lucro (+2%) ligou.
  // ----------------------------------------------------------
  const colunasRisco = [
    ['stop_price', 'REAL NOT NULL DEFAULT 0'],
    ['peak_price', 'REAL NOT NULL DEFAULT 0'],
    ['trailing_ativo', 'INTEGER NOT NULL DEFAULT 0'],
    // Dossiê da Ordem: texto puro explicando o porquê da compra (gatilho,
    // força de volume/variação, análise da porta e defesa/Stop Loss).
    // Gerado no momento da compra (comprarSlot) e exibido no painel.
    ['dossie_texto', "TEXT NOT NULL DEFAULT ''"],
    // Tipo de Execução da COMPRA (motor [ENTRADA], 2026-07-20): conta
    // como a ordem entrou — LIMITE (preencheu no bestAsk), MERCADO
    // (fallback após 12s), MISTA (parcial na limite + resto a mercado)
    // ou MERCADO_DIRETO (limite inviável: book mudo/minNotional/recusa).
    // Vazio = slot aberto antes desta migração (histórico legado).
    ['exec_tipo', "TEXT NOT NULL DEFAULT ''"],
    // Detalhe legível da execução (preços, tempo, split das pernas).
    ['exec_detalhe', "TEXT NOT NULL DEFAULT ''"]
  ];
  for (const [coluna, tipo] of colunasRisco) {
    try {
      await run(`ALTER TABLE active_slots ADD COLUMN ${coluna} ${tipo}`);
      console.log(`[DB] Coluna ${coluna} criada em active_slots`);
    } catch (err) {
      if (/duplicate column name/i.test(err.message)) {
        console.log(`[DB] Coluna ${coluna} já existe (ok)`);
      } else {
        console.error(`[DB] Falha ao migrar ${coluna}:`, err.message);
      }
    }
  }

  // ----------------------------------------------------------
  // Migração segura: Dossiê da Ordem também no histórico fechado.
  // Quando um slot é arquivado (TP/SL/MANUAL/EOD) o texto do dossiê
  // é carregado de active_slots -> trade_history, para o botão "Ver
  // Análise" também funcionar nas ordens do calendário/histórico.
  // ----------------------------------------------------------
  try {
    await run(
      `ALTER TABLE trade_history ADD COLUMN dossie_texto TEXT NOT NULL DEFAULT ''`
    );
    console.log('[DB] Coluna dossie_texto criada em trade_history');
  } catch (err) {
    if (/duplicate column name/i.test(err.message)) {
      console.log('[DB] Coluna dossie_texto (trade_history) já existe (ok)');
    } else {
      console.error('[DB] Falha ao migrar dossie_texto (trade_history):', err.message);
    }
  }

  // ----------------------------------------------------------
  // Migração segura: Tipo de Execução também no histórico fechado.
  // Mesmo caminho do dossiê — copiado de active_slots no arquivamento
  // para o modal do calendário continuar contando a história da ordem
  // depois que ela fecha.
  // ----------------------------------------------------------
  for (const [coluna, tipo] of [
    ['exec_tipo', "TEXT NOT NULL DEFAULT ''"],
    ['exec_detalhe', "TEXT NOT NULL DEFAULT ''"]
  ]) {
    try {
      await run(`ALTER TABLE trade_history ADD COLUMN ${coluna} ${tipo}`);
      console.log(`[DB] Coluna ${coluna} criada em trade_history`);
    } catch (err) {
      if (/duplicate column name/i.test(err.message)) {
        console.log(`[DB] Coluna ${coluna} (trade_history) já existe (ok)`);
      } else {
        console.error(`[DB] Falha ao migrar ${coluna} (trade_history):`, err.message);
      }
    }
  }

  // ----------------------------------------------------------
  // Migração segura: IDENTIDADE DA ORDEM (2026-07-25).
  // buy_order_id  (active_slots + trade_history) e sell_order_id
  // (trade_history) guardam os orderId REAIS devolvidos pela Binance.
  // Formato: lista separada por vírgula — uma entrada pode ter DUAS
  // pernas (limite parcial + mercado), e a saída pode ter a ordem
  // principal + a varredura de resíduo.
  //
  // MOTIVO: a auditoria de taxas casava fills do myTrades só por JANELA
  // DE TEMPO (±5 min). Duas operações do mesmo símbolo dentro da janela
  // roubavam os fills uma da outra — foi o que produziu PnL impossível
  // (#409 BANK +99,5% / #410 BANK −49,8% em 25/07). Com o orderId
  // gravado, cada fill pertence a exatamente um registro.
  // Vazio ('') = linha anterior a esta migração: cai no casamento por
  // tempo DISJUNTO (ver auditarTaxasHistorico no server.js).
  // ----------------------------------------------------------
  for (const [tabela, coluna] of [
    ['active_slots', 'buy_order_id'],
    ['trade_history', 'buy_order_id'],
    ['trade_history', 'sell_order_id']
  ]) {
    try {
      await run(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} TEXT NOT NULL DEFAULT ''`);
      console.log(`[DB] Coluna ${coluna} criada em ${tabela}`);
    } catch (err) {
      if (/duplicate column name/i.test(err.message)) {
        console.log(`[DB] Coluna ${coluna} (${tabela}) já existe (ok)`);
      } else {
        console.error(`[DB] Falha ao migrar ${coluna} (${tabela}):`, err.message);
      }
    }
  }

  // ----------------------------------------------------------
  // SINCRONIZAÇÃO PELO HISTÓRICO DA CORRETORA (2026-07-27).
  //
  //   direcao  : 'LONG' | 'SHORT'. Em Futuros a posição tem SINAL, e até
  //              aqui o banco era herança do Spot — onde toda linha era
  //              implicitamente uma compra. Sem esta coluna não há como
  //              representar um SHORT fechado no lucro (preço de saída
  //              MENOR que o de entrada), e o PnL do histórico sairia com
  //              o sinal trocado. Default 'LONG': é o que todo registro
  //              anterior a esta migração de fato é (comprarSlot abria
  //              'LONG' fixo).
  //   status   : 'ABERTA' em active_slots; 'FECHADA_COM_LUCRO' /
  //              'FECHADA_COM_PREJUIZO' / 'FECHADA_ZERADA' em
  //              trade_history. Redundante com o sinal do pnl_usdt de
  //              propósito: é o campo que a sincronização compara para
  //              decidir se precisa reescrever a linha.
  //   ciclo_id : CHAVE DE IDEMPOTÊNCIA. Formato `SYMBOL:<tradeId>`, onde
  //              tradeId é o id Binance do PRIMEIRO fill de entrada do
  //              ciclo. É imutável e único na corretora, então rodar a
  //              sincronização 100 vezes produz exatamente as mesmas
  //              linhas. Vazio = registro escrito pelo motor antes desta
  //              migração (ou ainda não casado com a corretora).
  // ----------------------------------------------------------
  for (const [tabela, coluna, tipo] of [
    ['active_slots',  'direcao',  "TEXT NOT NULL DEFAULT 'LONG'"],
    ['active_slots',  'status',   "TEXT NOT NULL DEFAULT 'ABERTA'"],
    ['active_slots',  'ciclo_id', "TEXT NOT NULL DEFAULT ''"],
    ['trade_history', 'direcao',  "TEXT NOT NULL DEFAULT 'LONG'"],
    ['trade_history', 'status',   "TEXT NOT NULL DEFAULT ''"],
    ['trade_history', 'ciclo_id', "TEXT NOT NULL DEFAULT ''"]
  ]) {
    try {
      await run(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
      console.log(`[DB] Coluna ${coluna} criada em ${tabela}`);
    } catch (err) {
      if (/duplicate column name/i.test(err.message)) {
        console.log(`[DB] Coluna ${coluna} (${tabela}) já existe (ok)`);
      } else {
        console.error(`[DB] Falha ao migrar ${coluna} (${tabela}):`, err.message);
      }
    }
  }

  // Backfill do status das linhas antigas: sem isto o histórico legado
  // aparece com status vazio no painel enquanto o pnl já diz tudo.
  try {
    const r = await run(
      `UPDATE trade_history
          SET status = CASE
                         WHEN pnl_usdt > 0 THEN 'FECHADA_COM_LUCRO'
                         WHEN pnl_usdt < 0 THEN 'FECHADA_COM_PREJUIZO'
                         ELSE 'FECHADA_ZERADA'
                       END
        WHERE status = ''`
    );
    if (r && r.changes) console.log(`[DB] status preenchido em ${r.changes} linha(s) legada(s) de trade_history`);
  } catch (err) {
    console.error('[DB] Falha no backfill de status:', err.message);
  }

  // ÍNDICE ÚNICO PARCIAL em trade_history(ciclo_id). É a trava real da
  // idempotência: mesmo que dois processos (boot + tick de 15 min)
  // rodem a sincronização ao mesmo tempo, o banco recusa a segunda
  // inserção do mesmo ciclo. O `WHERE ciclo_id <> ''` é obrigatório —
  // sem ele, as centenas de linhas legadas com ciclo_id vazio colidiriam
  // entre si e o índice nem seria criado.
  try {
    await run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_history_ciclo
         ON trade_history (ciclo_id) WHERE ciclo_id <> ''`
    );
    console.log('[DB] Índice único parcial trade_history(ciclo_id) pronto (idempotência da sincronização)');
  } catch (err) {
    console.error(
      '[DB] NÃO foi possível criar o índice único trade_history(ciclo_id) — ' +
      `provável ciclo_id duplicado já gravado: ${err.message}`
    );
  }

  // ----------------------------------------------------------
  // TRAVA DE ENTRADA DUPLA (2026-07-25): índice ÚNICO em
  // active_slots.symbol. O bot nunca deve ter dois slots abertos do
  // mesmo par — era essa duplicidade que fazia a saída de um registro
  // vender o lote do outro e embaralhar o bookkeeping.
  // A criação FALHA se já existir duplicidade no banco: nesse caso o
  // erro é logado e o índice fica de fora (o bot segue operando com a
  // guarda de aplicação em comprarSlot).
  // ----------------------------------------------------------
  try {
    await run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_active_slots_symbol
         ON active_slots (symbol)`
    );
    console.log('[DB] Índice único active_slots(symbol) pronto (bloqueia entrada dupla)');
  } catch (err) {
    console.error(
      '[DB] NÃO foi possível criar o índice único active_slots(symbol) — ' +
      `provável duplicidade já no banco: ${err.message}`
    );
  }

  console.log('[DB] Tabelas active_slots e trade_history prontas');
}

// ============================================================
// active_slots — ordens abertas
// ============================================================

// Insere uma posição aberta.
// pos: { symbol, buyPrice, quantity, investedUSDT, buyTime, stopPrice?,
//        dossieTexto?, buyOrderId? }
// stopPrice   = Stop Loss estrutural calculado na abertura (0 se ausente).
// dossieTexto = Dossiê da Ordem (texto puro do porquê da compra; '' se ausente).
// buyOrderId  = orderId(s) REAIS da compra, separados por vírgula quando a
//               entrada teve duas pernas (limite parcial + mercado). É a
//               chave que amarra os fills do myTrades a ESTE registro.
// direcao = 'LONG' | 'SHORT' (default 'LONG': era o único caso do motor).
// cicloId = chave de idempotência vinda do histórico da corretora ('' quando
//           o slot nasceu de uma entrada local e ainda não foi casado).
function insertActiveSlot(pos) {
  return run(
    `INSERT INTO active_slots
       (symbol, buy_price, quantity, invested_usdt, buy_time, stop_price, peak_price, trailing_ativo, dossie_texto, exec_tipo, exec_detalhe, buy_order_id, direcao, status, ciclo_id)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'ABERTA', ?)`,
    [
      pos.symbol, pos.buyPrice, pos.quantity, pos.investedUSDT, pos.buyTime,
      pos.stopPrice || 0, pos.dossieTexto || '',
      pos.execTipo || '', pos.execDetalhe || '',
      pos.buyOrderId || '',
      pos.direcao || 'LONG',
      pos.cicloId || ''
    ]
  );
}

// Todas as posições abertas (mais antiga primeiro)
function getActiveSlots() {
  return all(`SELECT * FROM active_slots ORDER BY buy_time ASC`);
}

// Uma posição aberta pelo símbolo (a mais recente, se houver duplicidade)
function getActiveSlotBySymbol(symbol) {
  return get(
    `SELECT * FROM active_slots WHERE symbol = ? ORDER BY buy_time DESC LIMIT 1`,
    [symbol]
  );
}

// Posições abertas cujo buy_time cai numa data (AAAA-MM-DD).
// Data derivada em horário LOCAL (America/Sao_Paulo) via 'localtime'.
function getActiveSlotsByDate(date) {
  return all(
    `SELECT * FROM active_slots
      WHERE date(buy_time / 1000, 'unixepoch', 'localtime') = ?
      ORDER BY buy_time ASC`,
    [date]
  );
}

// Atualiza o preço de compra REAL (média ponderada da corretora) e o
// investido de um slot ativo. Usado pela sincronização /api/sync-history.
function updateActiveSlotExecucao(id, buyPrice, investedUSDT) {
  return run(
    `UPDATE active_slots SET buy_price = ?, invested_usdt = ? WHERE id = ?`,
    [buyPrice, investedUSDT, id]
  );
}

// Liga/desliga a flag alerta_recuperacao de um slot (Modo Fuga do TP).
function setAlertaRecuperacao(id, ativo) {
  return run(
    `UPDATE active_slots SET alerta_recuperacao = ? WHERE id = ?`,
    [ativo ? 1 : 0, id]
  );
}

// Trailing Stop (Perseguidor de Lucro): atualiza o topo alcançado e a
// flag de ativação de um slot. Chamado pelo monitorPortfolio a cada 15s.
function updateSlotTrailing(id, peakPrice, trailingAtivo) {
  return run(
    `UPDATE active_slots SET peak_price = ?, trailing_ativo = ? WHERE id = ?`,
    [peakPrice, trailingAtivo ? 1 : 0, id]
  );
}

// Atualiza o Stop Loss estrutural de um slot (recalibração eventual).
function updateSlotStop(id, stopPrice) {
  return run(
    `UPDATE active_slots SET stop_price = ? WHERE id = ?`,
    [stopPrice, id]
  );
}

// ------------------------------------------------------------
// Sincronização pelo histórico da corretora (sincronizarHistoricoFuturos).
// Reescreve o slot com a execução REAL: preço médio dos fills, quantidade
// líquida ainda aberta, margem, direção e o ciclo_id que amarra a linha ao
// histórico da Binance. NÃO toca em stop_price/peak_price/trailing_ativo:
// esses são estado do motor local, não da corretora — sobrescrevê-los
// apagaria o trailing no meio de uma posição viva.
// ------------------------------------------------------------
function updateActiveSlotSync(id, s) {
  return run(
    `UPDATE active_slots
        SET buy_price = ?, quantity = ?, invested_usdt = ?, buy_time = ?,
            direcao = ?, status = 'ABERTA', ciclo_id = ?, buy_order_id = ?
      WHERE id = ?`,
    [
      s.buyPrice, s.quantity, s.investedUSDT, s.buyTime,
      s.direcao || 'LONG', s.cicloId || '', s.buyOrderId || '',
      id
    ]
  );
}

// Slot aberto por ciclo_id (chave da corretora). Vazio nunca casa.
function getActiveSlotByCicloId(cicloId) {
  if (!cicloId) return Promise.resolve(undefined);
  return get(`SELECT * FROM active_slots WHERE ciclo_id = ? LIMIT 1`, [cicloId]);
}

// Remove posição aberta pelo id
function deleteActiveSlot(id) {
  return run(`DELETE FROM active_slots WHERE id = ?`, [id]);
}

// Remove todas as posições abertas de um símbolo
function deleteActiveSlotBySymbol(symbol) {
  return run(`DELETE FROM active_slots WHERE symbol = ?`, [symbol]);
}

// Soma investida das posições abertas
async function getActiveTotalInvested() {
  const row = await get(
    `SELECT COALESCE(SUM(invested_usdt), 0) AS total FROM active_slots`
  );
  return row ? row.total : 0;
}

// ============================================================
// trade_history — operações fechadas
// ============================================================

// Insere uma operação fechada.
// t: { symbol, buyPrice, sellPrice, quantity, investedUSDT,
//      pnlUSDT, pnlPercent, buyTime, sellTime, closeReason, dossieTexto?,
//      buyOrderId?, sellOrderId? }
// dossieTexto = Dossiê herdado do slot arquivado ('' se ausente).
// buyOrderId / sellOrderId = orderId(s) reais da corretora (lista separada
//   por vírgula). É por eles que a auditoria de taxas casa os fills — sem
//   isso duas operações do mesmo símbolo na mesma janela de 5 min roubam
//   os fills uma da outra.
// direcao / status / cicloId: ver a migração de 2026-07-27 em initDb.
// status é derivado do PnL quando não vier explícito, para nenhuma linha
// nova nascer com o campo vazio.
function statusPorPnl(pnlUSDT) {
  const v = Number(pnlUSDT) || 0;
  if (v > 0) return 'FECHADA_COM_LUCRO';
  if (v < 0) return 'FECHADA_COM_PREJUIZO';
  return 'FECHADA_ZERADA';
}

function insertTradeHistory(t) {
  return run(
    `INSERT INTO trade_history
      (symbol, buy_price, sell_price, quantity, invested_usdt,
       pnl_usdt, pnl_percent, buy_time, sell_time, close_reason, dossie_texto,
       exec_tipo, exec_detalhe, buy_order_id, sell_order_id,
       direcao, status, ciclo_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t.symbol, t.buyPrice, t.sellPrice, t.quantity, t.investedUSDT,
      t.pnlUSDT, t.pnlPercent, t.buyTime, t.sellTime, t.closeReason,
      t.dossieTexto || '',
      t.execTipo || '', t.execDetalhe || '',
      t.buyOrderId || '', t.sellOrderId || '',
      t.direcao || 'LONG',
      t.status || statusPorPnl(t.pnlUSDT),
      t.cicloId || ''
    ]
  );
}

// ------------------------------------------------------------
// Sincronização: a linha fechada vista pela corretora.
// ------------------------------------------------------------

// Trade fechado por ciclo_id. É a primeira consulta da sincronização:
// se achar, a operação JÁ foi importada e o caminho é UPDATE, não INSERT.
function getTradeHistoryByCicloId(cicloId) {
  if (!cicloId) return Promise.resolve(undefined);
  return get(`SELECT * FROM trade_history WHERE ciclo_id = ? LIMIT 1`, [cicloId]);
}

// Candidatos a casamento para um ciclo ainda sem ciclo_id: mesma moeda,
// fechada dentro da janela de tolerância. Usado para ADOTAR a linha que o
// próprio motor gravou, em vez de duplicá-la.
function getTradeHistoryCandidatos(symbol, deMs, ateMs) {
  return all(
    `SELECT * FROM trade_history
      WHERE symbol = ? AND sell_time BETWEEN ? AND ?
      ORDER BY sell_time ASC`,
    [symbol, deMs, ateMs]
  );
}

// Sobrescreve uma linha fechada com o que a corretora registrou.
// close_reason só é trocado quando o chamador manda um valor: o motor
// local sabe o motivo real ('Trailing Stop', 'Radar Reverso') melhor que
// a inferência por tipo de ordem.
function updateTradeHistorySync(id, t) {
  return run(
    `UPDATE trade_history
        SET buy_price = ?, sell_price = ?, quantity = ?, invested_usdt = ?,
            pnl_usdt = ?, pnl_percent = ?, buy_time = ?, sell_time = ?,
            direcao = ?, status = ?, ciclo_id = ?,
            close_reason = COALESCE(NULLIF(?, ''), close_reason),
            buy_order_id  = CASE WHEN ? <> '' THEN ? ELSE buy_order_id  END,
            sell_order_id = CASE WHEN ? <> '' THEN ? ELSE sell_order_id END
      WHERE id = ?`,
    [
      t.buyPrice, t.sellPrice, t.quantity, t.investedUSDT,
      t.pnlUSDT, t.pnlPercent, t.buyTime, t.sellTime,
      t.direcao || 'LONG', t.status || statusPorPnl(t.pnlUSDT), t.cicloId || '',
      t.closeReason || '',
      t.buyOrderId || '', t.buyOrderId || '',
      t.sellOrderId || '', t.sellOrderId || '',
      id
    ]
  );
}

// Grava/backfill dos orderId de um trade já fechado. Usado pela auditoria
// quando ela consegue identificar com segurança as ordens de uma linha
// legada: da rodada seguinte em diante o casamento passa a ser exato.
function updateTradeHistoryOrderIds(id, buyOrderId, sellOrderId) {
  return run(
    `UPDATE trade_history SET buy_order_id = ?, sell_order_id = ? WHERE id = ?`,
    [buyOrderId || '', sellOrderId || '', id]
  );
}

// Datas distintas (AAAA-MM-DD) com operações fechadas, mais recente 1º.
// Deriva a data do sell_time (epoch ms) em horário local.
async function getHistoryDates() {
  // sell_time está em ms -> /1000. 'localtime' converte p/ data local
  // (America/Sao_Paulo), evitando que trades após 21h local caiam no
  // dia seguinte (virada UTC = 21h em Brasília).
  const rows = await all(
    `SELECT DISTINCT date(sell_time / 1000, 'unixepoch', 'localtime') AS dia
       FROM trade_history
      ORDER BY dia DESC`
  );
  return rows.map((r) => r.dia).filter(Boolean);
}

// Operações fechadas a partir de um epoch ms (auditoria dos últimos N dias)
function getHistorySince(sinceMs) {
  return all(
    `SELECT * FROM trade_history WHERE sell_time >= ? ORDER BY sell_time ASC`,
    [sinceMs]
  );
}

// Sobrescreve um trade fechado com os dados REAIS de execução da
// corretora (preços médios, investido e PnL recalculado com taxas).
function updateTradeHistoryExecucao(id, t) {
  return run(
    `UPDATE trade_history
        SET buy_price = ?, sell_price = ?, invested_usdt = ?,
            pnl_usdt = ?, pnl_percent = ?
      WHERE id = ?`,
    [t.buyPrice, t.sellPrice, t.investedUSDT, t.pnlUSDT, t.pnlPercent, id]
  );
}

// Operações fechadas de um dia específico (AAAA-MM-DD)
function getHistoryByDate(date) {
  return all(
    `SELECT * FROM trade_history
      WHERE date(sell_time / 1000, 'unixepoch', 'localtime') = ?
      ORDER BY sell_time ASC`,
    [date]
  );
}

// ============================================================
// daily_snapshots — banca inicial de cada dia (base do PnL %)
// ============================================================

// Grava/atualiza o snapshot da banca de uma data (AAAA-MM-DD).
// INSERT OR REPLACE: o cron das 00:00 é a foto oficial e pode
// sobrescrever uma captura de boot feita minutos antes.
function upsertDailySnapshot(date, initialBalance) {
  return run(
    `INSERT OR REPLACE INTO daily_snapshots (date, initial_balance)
     VALUES (?, ?)`,
    [date, initialBalance]
  );
}

// Snapshot de uma data específica (ou undefined se não existir)
function getDailySnapshot(date) {
  return get(`SELECT * FROM daily_snapshots WHERE date = ?`, [date]);
}

// Snapshot mais antigo a partir de uma data (inclusive). Usado como
// base da % dos períodos semana/mês/total no dashboard.
function getEarliestSnapshotSince(date) {
  return get(
    `SELECT * FROM daily_snapshots WHERE date >= ? ORDER BY date ASC LIMIT 1`,
    [date]
  );
}

// Soma do PnL fechado (trade_history) de uma data local (AAAA-MM-DD)
async function getPnlFechadoDoDia(date) {
  const row = await get(
    `SELECT COALESCE(SUM(pnl_usdt), 0) AS pnl
       FROM trade_history
      WHERE date(sell_time / 1000, 'unixepoch', 'localtime') = ?`,
    [date]
  );
  return row ? row.pnl : 0;
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb,
  // active_slots
  insertActiveSlot,
  getActiveSlots,
  getActiveSlotBySymbol,
  getActiveSlotsByDate,
  updateActiveSlotExecucao,
  updateActiveSlotSync,
  getActiveSlotByCicloId,
  setAlertaRecuperacao,
  updateSlotTrailing,
  updateSlotStop,
  deleteActiveSlot,
  deleteActiveSlotBySymbol,
  getActiveTotalInvested,
  // trade_history
  insertTradeHistory,
  getHistoryDates,
  getHistoryByDate,
  getHistorySince,
  updateTradeHistoryExecucao,
  updateTradeHistoryOrderIds,
  getTradeHistoryByCicloId,
  getTradeHistoryCandidatos,
  updateTradeHistorySync,
  statusPorPnl,
  getPnlFechadoDoDia,
  // daily_snapshots
  upsertDailySnapshot,
  getDailySnapshot,
  getEarliestSnapshotSince
};
