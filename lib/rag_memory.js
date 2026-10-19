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
      entryPrice = 0
    } = entryData;

    const sql = `
      INSERT INTO trades_rag (
        cycle_id, symbol, side, leverage, mode, score_total,
        rsi_15m, rsi_1m, ema_status, sar_status, vol_ratio,
        funding_rate, book_ratio, fibo_pos, patterns, ai_thesis,
        entry_time, entry_price
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      cycleId,
      symbol,
      side,
      leverage,
      mode,
      scoreTotal,
      parseFloat(dadosMercado.rsi || 50) || 50,
      parseFloat(dadosMercado.rsi1m || 50) || 50,
      dadosMercado.emaStatus || '--',
      dadosMercado.sarTendencia || '--',
      parseFloat(dadosMercado.volRatio || 1.0) || 1.0,
      parseFloat(dadosMercado.fundingRate || 0) || 0,
      parseFloat(dadosMercado.longPct || 50) || 50,
      dadosMercado.fiboPos || '--',
      (dadosMercado.padroesDetectados || []).join(', ') || 'Nenhum',
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
    } else if (exitReason === 'BREAKEVEN') {
      postMortem = `Breakeven Protegido (${roiPct.toFixed(2)}% ROI): Atingiu >= +2.5% e retornou para +0.4% de recuo. Zero prejuízo com taxas pagas.`;
    } else if (isWin) {
      if (openTrade.mode === 'ARMADILHA_CONTRARIA') {
        postMortem = `Vitória em Armadilha (${roiPct.toFixed(2)}% ROI): Contra-ataque no topo/fundo com exaustão foi certeiro.`;
      } else {
        postMortem = `Vitória em Tendência (${roiPct.toFixed(2)}% ROI via ${exitReason}): Confluência técnica confirmada com fluxo favorável.`;
      }
    } else if (isLoss) {
      if (exitReason === 'CYCLE_END') {
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

// Gera resumo enxuto de lições para injetar no prompt da IA (0 custo de busca, rápido)
async function obterMemoriaParaIA() {
  try {
    const recentes = await db.all(
      `SELECT symbol, side, mode, score_total, roi_pct, result, post_mortem 
         FROM trades_rag 
        WHERE result IS NOT NULL 
        ORDER BY exit_time DESC LIMIT 15`
    );

    if (!recentes || recentes.length === 0) {
      return 'MEMÓRIA RAG: Base iniciando, sem histórico suficiente de vitórias/derrotas.';
    }

    const wins = recentes.filter(r => r.result === 'WIN');
    const losses = recentes.filter(r => r.result === 'LOSS');
    const winRate = Math.round((wins.length / recentes.length) * 100);

    let txt = `MEMÓRIA RAG ATIVA (Últimos ${recentes.length} trades | Acerto: ${winRate}% [${wins.length}W/${losses.length}L]):\n`;
    
    if (wins.length > 0) {
      txt += `• LIÇÕES DE ACERTO (REPETIR):\n`;
      wins.slice(0, 3).forEach(w => {
        txt += `  - ${w.symbol} [${w.side} / ${w.mode} / Score ${w.score_total}]: ${w.post_mortem}\n`;
      });
    }

    if (losses.length > 0) {
      txt += `• LIÇÕES DE ERRO (EVITAR A TODO CUSTO):\n`;
      losses.slice(0, 3).forEach(l => {
        txt += `  - ${l.symbol} [${l.side} / ${l.mode} / Score ${l.score_total}]: ${l.post_mortem}\n`;
      });
    }

    return txt.trim();
  } catch(e) {
    return 'MEMÓRIA RAG: Indisponível no momento.';
  }
}

// Inicializa a tabela ao carregar o módulo
initRagDb().catch(e => console.error('[RAG] Falha ao iniciar:', e.message));

module.exports = {
  salvarEntradaRAG,
  salvarSaidaRAG,
  consultarHistoricoRAG,
  obterMemoriaParaIA
};
