// ============================================================
// rag_memory.js — Memória RAG e Aprendizado Contínuo para Trades
// Banco: database_futuros.sqlite (tabela: trades_rag)
// ============================================================

const db = require('../db');

async function initRagDb() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS trades_rag (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      leverage INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'TENDENCIA', -- 'TENDENCIA' | 'ARMADILHA_CONTRARIA'
      score_total INTEGER NOT NULL,
      rsi_15m REAL,
      rsi_1m REAL,
      ema_status TEXT,
      sar_status TEXT,
      vol_ratio REAL,
      funding_rate REAL,
      book_ratio REAL,
      fibo_pos TEXT,
      patterns TEXT,
      ai_thesis TEXT,
      entry_time INTEGER NOT NULL,
      entry_price REAL,
      exit_time INTEGER,
      exit_price REAL,
      exit_reason TEXT, -- 'TP' | 'SL' | 'TRAILING' | 'CYCLE_END'
      roi_pct REAL,
      pnl_usdt REAL,
      result TEXT, -- 'WIN' | 'LOSS' | 'BREAKEVEN'
      post_mortem TEXT
    )
  `);

  await db.run(`CREATE INDEX IF NOT EXISTS idx_trades_rag_symbol ON trades_rag(symbol)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_trades_rag_entry_time ON trades_rag(entry_time)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_trades_rag_result ON trades_rag(result)`);
  console.log('[RAG] Tabela trades_rag inicializada com sucesso.');
}

// Salva o snapshot completo no momento da entrada
async function salvarEntradaRAG(entryData) {
  try {
    const {
      cycleId = 0,
      symbol,
      side,
      leverage,
      mode = 'TENDENCIA',
      scoreTotal = 0,
      dadosMercado = {},
      aiThesis = '',
      entryPrice = 0,
      rsi15m,
      rsi1m,
      emaStatus,
      sarStatus,
      volRatio,
      fundingRate,
      bookRatio,
      fiboPos,
      patterns
    } = entryData;

    const sql = `
      INSERT INTO trades_rag (
        cycle_id, symbol, side, leverage, mode, score_total,
        rsi_15m, rsi_1m, ema_status, sar_status, vol_ratio,
        funding_rate, book_ratio, fibo_pos, patterns, ai_thesis,
        entry_time, entry_price
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const rsiVal = parseFloat(rsi15m !== undefined ? rsi15m : (dadosMercado.rsi || 50)) || 50;
    const rsi1mVal = parseFloat(rsi1m !== undefined ? rsi1m : (dadosMercado.rsi1m || 50)) || 50;
    const emaStat = emaStatus || dadosMercado.emaStatus || '--';
    const sarStat = sarStatus || dadosMercado.sarTendencia || '--';
    const volRat = parseFloat(volRatio !== undefined ? volRatio : (dadosMercado.volRatio || 1.0)) || 1.0;
    const fundRate = parseFloat(fundingRate !== undefined ? fundingRate : (dadosMercado.fundingRate || 0)) || 0;
    const bookRat = parseFloat(bookRatio !== undefined ? bookRatio : (dadosMercado.longPct || 50)) || 50;
    const fibo = fiboPos || dadosMercado.fiboPos || '--';
    const patts = Array.isArray(patterns) ? patterns.join(', ') : (patterns || (dadosMercado.padroesDetectados || []).join(', ') || 'Nenhum');

    const params = [
      cycleId,
      symbol,
      side,
      leverage,
      mode,
      scoreTotal,
      rsiVal,
      rsi1mVal,
      emaStat,
      sarStat,
      volRat,
      fundRate,
      bookRat,
      fibo,
      patts,
      aiThesis || '',
      Date.now(),
      entryPrice || dadosMercado.preco || 0
    ];

    const res = await db.run(sql, params);
    console.log(`[RAG] Entrada gravada para ${symbol} (${side} ${leverage}x | Modo: ${mode} | Score: ${scoreTotal}) [ID: ${res.lastID}]`);
    return res.lastID;
  } catch(e) {
    console.error('[RAG] Erro ao salvar entrada:', e.message);
    return null;
  }
}

// Atualiza o trade no fechamento com o resultado e gera o diagnóstico de aprendizado
async function salvarSaidaRAG(exitData) {
  try {
    const { symbol, exitPrice = 0, exitReason = 'UNKNOWN', roiPct = 0, pnlUsdt = 0 } = exitData;

    // Busca o trade aberto mais recente para este símbolo
    const openTrade = await db.get(
      `SELECT * FROM trades_rag WHERE symbol = ? AND exit_time IS NULL ORDER BY entry_time DESC LIMIT 1`,
      [symbol]
    );

    if (!openTrade) {
      console.log(`[RAG] Nenhum trade aberto encontrado para registrar saída de ${symbol}`);
      return false;
    }

    const isWin = roiPct > 0.05;
    const isLoss = roiPct < -0.05;
    const result = isWin ? 'WIN' : (isLoss ? 'LOSS' : 'BREAKEVEN');

    // Gerador de diagnóstico de aprendizado (Post-Mortem)
    let postMortem = '';
    if (exitReason === 'PERDAO_30M') {
      postMortem = `Saída com Perdão após 30m (ROI ${roiPct.toFixed(2)}%): Posição estagnada ou sem volume. Saída estratégica para liberação de capital.`;
    } else if (exitReason.startsWith('CATRACA') || exitReason === 'BREAKEVEN') {
      postMortem = `Catraca Protegida (${roiPct.toFixed(2)}% ROI via ${exitReason}): Lucro garantido com parcial/degrau travado. Zero prejuízo com taxas pagas.`;
    } else if (exitReason === 'SAIDA_RESGATE_REPIQUE_HP' || exitReason.includes('RESGATE_REPIQUE')) {
      postMortem = `Saída no Repique de Resgate HP (${roiPct.toFixed(2)}% ROI): Estrutura enfraqueceu em 2 leituras de HP; saída no repique técnico com taxas cobertas.`;
    } else if (isWin) {
      if (openTrade.mode === 'ARMADILHA_CONTRARIA') {
        postMortem = `Vitória em Armadilha (${roiPct.toFixed(2)}% ROI): Contra-ataque no topo/fundo com exaustão foi certeiro.`;
      } else {
        postMortem = `Vitória em Tendência (${roiPct.toFixed(2)}% ROI via ${exitReason}): Confluência técnica confirmada com fluxo favorável.`;
      }
    } else if (isLoss) {
      if (exitReason === 'REVERSAO_TRAP_-1.5%') {
        postMortem = `Stop & Reverse por Armadilha (ROI ${roiPct.toFixed(2)}%): Posição falhou após pico positivo e acionou reversão imediata com fluxo contrário.`;
      } else if (exitReason === 'CYCLE_END') {
        postMortem = `Tempo Expirado no Ciclo (ROI ${roiPct.toFixed(2)}%): Movimento demorou mais que a janela de 9 minutos.`;
      } else if (openTrade.mode === 'ARMADILHA_CONTRARIA') {
        postMortem = `Derrota em Armadilha (${roiPct.toFixed(2)}% ROI): Mercado manteve força e rompeu além da zona de reversão.`;
      } else {
        postMortem = `Stop Loss (${roiPct.toFixed(2)}% ROI via ${exitReason}): Rompimento falso ou reversão súbita de fluxo.`;
      }
    } else {
      postMortem = `Breakeven (${roiPct.toFixed(2)}% ROI): Fechamento neutro.`;
    }

    await db.run(
      `UPDATE trades_rag 
          SET exit_time = ?, exit_price = ?, exit_reason = ?, roi_pct = ?, pnl_usdt = ?, result = ?, post_mortem = ?
        WHERE id = ?`,
      [Date.now(), exitPrice, exitReason, roiPct, pnlUsdt, result, postMortem, openTrade.id]
    );

    console.log(`[RAG] Saída registrada para ${symbol} [ID: ${openTrade.id}] -> ${result} (${roiPct.toFixed(2)}% ROI | ${exitReason}). Lição: ${postMortem}`);
    return true;
  } catch(e) {
    console.error('[RAG] Erro ao salvar saída:', e.message);
    return false;
  }
}

// Consulta a memória para validar o setup antes de autorizar a entrada
async function consultarHistoricoRAG(setup) {
  try {
    const { symbol, side, mode = 'TENDENCIA', scoreTotal = 50, fundingRate = 0, rsi15m = 50 } = setup;

    // Busca trades similares: mesmo modo, mesmo side e faixa próxima de score (±20 pts)
    const minScore = Math.max(0, scoreTotal - 20);
    const maxScore = Math.min(100, scoreTotal + 20);

    const rows = await db.all(
      `SELECT * FROM trades_rag 
        WHERE mode = ? AND side = ? AND score_total BETWEEN ? AND ? AND result IS NOT NULL
        ORDER BY entry_time DESC LIMIT 30`,
      [mode, side, minScore, maxScore]
    );

    // Também verifica o histórico recente específico deste par
    const parRows = await db.all(
      `SELECT * FROM trades_rag 
        WHERE symbol = ? AND result IS NOT NULL 
        ORDER BY entry_time DESC LIMIT 5`,
      [symbol]
    );

    const parLossesRecentes = parRows.filter(r => r.result === 'LOSS').length;

    if (rows.length === 0) {
      // Sem histórico similar: permite com cautela
      return {
        totalSimilar: 0,
        winRate: null,
        status: 'NEUTRO',
        motivo: 'Setup inédito na base RAG. Permitir com alavancagem moderada.',
        ajusteAlavancagem: 1.0,
        veto: false
      };
    }

    const wins = rows.filter(r => r.result === 'WIN').length;
    const losses = rows.filter(r => r.result === 'LOSS').length;
    const total = rows.length;
    const winRate = (wins / total) * 100;

    // REGRA DE APRENDIZADO 1: Se este setup tem histórico de perda severa (>= 3 trades e winRate < 45%)
    if (total >= 3 && winRate < 45) {
      return {
        totalSimilar: total,
        winRate: Math.round(winRate),
        status: 'VETO',
        motivo: `VETO RAG: Setup similar gerou ${losses} derrotas em ${total} trades (${Math.round(winRate)}% win rate). Evitando erro repetido.`,
        ajusteAlavancagem: 0,
        veto: true
      };
    }

    // REGRA DE APRENDIZADO 2: Se o par específico tomou 3 losses seguidos recentemente
    if (parLossesRecentes >= 3) {
      return {
        totalSimilar: total,
        winRate: Math.round(winRate),
        status: 'VETO',
        motivo: `VETO RAG: ${symbol} acumula ${parLossesRecentes} derrotas seguidas no histórico recente. Par em zona de risco.`,
        ajusteAlavancagem: 0,
        veto: true
      };
    }

    // REGRA DE APRENDIZADO 3: Setup vencedor comprovado (>= 3 trades e winRate >= 65%)
    if (total >= 3 && winRate >= 65) {
      return {
        totalSimilar: total,
        winRate: Math.round(winRate),
        status: 'APROVADO_FORTE',
        motivo: `APROVADO RAG: Setup de alta taxa de acerto comprovada (${Math.round(winRate)}% win rate em ${total} trades).`,
        ajusteAlavancagem: 1.2,
        veto: false
      };
    }

    return {
      totalSimilar: total,
      winRate: Math.round(winRate),
      status: 'APROVADO_NORMAL',
      motivo: `Setup com desempenho regular (${Math.round(winRate)}% win rate em ${total} trades).`,
      ajusteAlavancagem: 1.0,
      veto: false
    };
  } catch(e) {
    console.error('[RAG] Erro ao consultar histórico:', e.message);
    return { status: 'ERRO_FALLBACK', veto: false, ajusteAlavancagem: 1.0, motivo: 'Erro RAG' };
  }
}

// Gera resumo estritamente agregado (sem despejo de trades individuais para evitar poluição e viés negativo)
async function obterMemoriaParaIA() {
  try {
    const row = await db.get(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as wins,
              AVG(roi_pct) as avg_roi
         FROM trades_rag 
        WHERE result IS NOT NULL`
    );

    if (!row || !row.total) {
      return '';
    }

    const wr = Math.round((row.wins / row.total) * 100);
    return `MÉTRICAS HISTÓRICAS DO SISTEMA: ${row.total} operações arquivadas, Taxa de Acerto Geral: ${wr}%, ROI médio: ${(row.avg_roi || 0).toFixed(2)}%. Seja ultra-seletivo e priorize apenas confluências perfeitas.`;
  } catch(e) {
    return '';
  }
}

// Obtém estatísticas gerais do RAG
async function obterEstatisticasRAG() {
  try {
    const row = await db.get(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN result = 'LOSS' THEN 1 ELSE 0 END) as losses,
              AVG(roi_pct) as avg_roi
         FROM trades_rag 
        WHERE result IS NOT NULL`
    );
    return row || { total: 0, wins: 0, losses: 0, avg_roi: 0 };
  } catch(e) {
    return { total: 0, wins: 0, losses: 0, avg_roi: 0 };
  }
}

// Consulta pares que geraram perdas consecutivas recentes (janela deslizante de 48h)
async function consultarParesVetados(maxLossRate = 45, janelaHoras = 48) {
  try {
    const cutoff = Date.now() - (janelaHoras * 3600 * 1000);
    const rows = await db.all(
      `SELECT symbol,
              COUNT(*) as total,
              SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as wins
         FROM trades_rag
        WHERE result IS NOT NULL
          AND entry_time >= ?
        GROUP BY symbol
       HAVING total >= 3 AND (CAST(wins AS FLOAT) / total * 100) < ?`,
      [cutoff, maxLossRate]
    );
    return rows || [];
  } catch(e) {
    return [];
  }
}

// Inicializa a tabela ao carregar o módulo
initRagDb().catch(e => console.error('[RAG] Falha ao iniciar:', e.message));

module.exports = {
  initRagDb,
  salvarEntradaRAG,
  salvarSaidaRAG,
  consultarHistoricoRAG,
  obterMemoriaParaIA,
  obterEstatisticasRAG,
  consultarParesVetados
};
