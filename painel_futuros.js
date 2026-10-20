const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const fut = require('./lib/futuresApi');
const ti = require('technicalindicators');
const axios = require('axios');
const fs = require('fs');
const db = require('./db');
const rag = require('./lib/rag_memory');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7005;
const SENHA = process.env.ACESSO_SENHA || '242524###';
const ROUTER_API_KEY = process.env.ROUTER_API_KEY;

// Inicializa banco de dados RAG local
rag.initRagDb().catch(e => console.error('[RAG] Erro ao iniciar:', e.message));

// Autenticação HTTP Basic
app.use((req, res, next) => {
  if (req.path === '/api/auto-status') return next();
  const auth = req.headers['authorization'];
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Painel Futuros Quant"');
    return res.status(401).send('Acesso Negado');
  }
  const parts = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  const pass = parts[1];
  if (pass !== SENHA) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Painel Futuros Quant"');
    return res.status(401).send('Senha Incorreta');
  }
  next();
});

// Arquivos de persistência
const ALVOS_FILE = path.join(__dirname, 'alvos_painel.json');
const AUTOBOT_FILE = path.join(__dirname, '.auto_bot_config.json');
const TOKENS_FILE = path.join(__dirname, '.tokens_usage.json');
const PLACAR_FILE = path.join(__dirname, '.placar_stats.json');
const MARCO_ZERO_FILE = path.join(__dirname, '.marco_zero_painel');

let marcoZero = 0;
try {
  if (fs.existsSync(MARCO_ZERO_FILE)) {
    marcoZero = parseInt(fs.readFileSync(MARCO_ZERO_FILE, 'utf8')) || 0;
  }
} catch(e) {}
if (!marcoZero) {
  marcoZero = Date.now();
  try { fs.writeFileSync(MARCO_ZERO_FILE, marcoZero.toString()); } catch(e){}
}

// Contador persistente de Win / Loss (Placar Institucional)
let placarStats = { wins: 0, losses: 0, total: 0 };
try {
  if (fs.existsSync(PLACAR_FILE)) {
    placarStats = JSON.parse(fs.readFileSync(PLACAR_FILE, 'utf8'));
  }
} catch(e) {
  placarStats = { wins: 0, losses: 0, total: 0 };
}

function salvarPlacarStats() {
  try {
    fs.writeFileSync(PLACAR_FILE, JSON.stringify(placarStats, null, 2));
  } catch(e) {}
}

function registrarDesfechoTrade(symbol, exitReason, roi, pnlUsdt) {
  const pnlNum = parseFloat(pnlUsdt) || 0;
  const roiNum = parseFloat(roi) || 0;
  const isWin = (pnlNum > 0.0001 || roiNum > 0.01 || exitReason === 'TP' || (exitReason === 'BREAKEVEN' && roiNum >= 0));
  if (isWin) {
    placarStats.wins = (placarStats.wins || 0) + 1;
  } else {
    placarStats.losses = (placarStats.losses || 0) + 1;
  }
  placarStats.total = (placarStats.wins || 0) + (placarStats.losses || 0);
  salvarPlacarStats();
  console.log(`[PLACAR-ATUALIZADO] ${symbol} -> ${isWin ? 'WIN (Vencedor)' : 'LOSS (Perdedor)'} (${exitReason}) | PnL: $${pnlNum.toFixed(2)} | ROI: ${roiNum.toFixed(2)}% | Total: ${placarStats.wins}W / ${placarStats.losses}L`);
}

function formatarPrecoAtivo(sym, preco) {
  if (preco === null || preco === undefined || isNaN(preco)) return '--';
  const prec = fut.filtrosDe(sym)?.pricePrecision ?? 4;
  return Number(preco).toFixed(prec);
}


// Contador persistente de tokens
let tokensGastos = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
try {
  if (fs.existsSync(TOKENS_FILE)) {
    tokensGastos = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  }
} catch(e) {}

function registrarUsoTokens(usage) {
  if (!usage) return;
  tokensGastos.prompt_tokens = (tokensGastos.prompt_tokens || 0) + (usage.prompt_tokens || 0);
  tokensGastos.completion_tokens = (tokensGastos.completion_tokens || 0) + (usage.completion_tokens || 0);
  tokensGastos.total_tokens = (tokensGastos.total_tokens || 0) + (usage.total_tokens || 0);
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokensGastos, null, 2));
  } catch(e) {}
}

let localAlvos = {};
try {
  if (fs.existsSync(ALVOS_FILE)) localAlvos = JSON.parse(fs.readFileSync(ALVOS_FILE, 'utf8'));
} catch (e) { localAlvos = {}; }

function salvarAlvos() {
  try { fs.writeFileSync(ALVOS_FILE, JSON.stringify(localAlvos, null, 2)); } catch(e){}
}

let autoBotState = {
  enabled: false,
  slots: {
    1: { symbol: null, targetSymbol: null, side: null, status: 'LIVRE', leverage: 3, openTime: null, lastChecked5mTime: 0, searchCooldownUntil: 0 },
    2: { symbol: null, targetSymbol: null, side: null, status: 'LIVRE', leverage: 3, openTime: null, lastChecked5mTime: 0, searchCooldownUntil: 0 }
  },
  lastLog: 'Sistema iniciado. Aguardando ativação.'
};

try {
  if (fs.existsSync(AUTOBOT_FILE)) {
    const salvo = JSON.parse(fs.readFileSync(AUTOBOT_FILE, 'utf8'));
    autoBotState.enabled = !!salvo.enabled;
  }
} catch (e) {}

function salvarAutoBotConfig() {
  try { fs.writeFileSync(AUTOBOT_FILE, JSON.stringify({ enabled: autoBotState.enabled }, null, 2)); } catch(e){}
}

let maxPriceTracker = {};
let minPriceTracker = {};
let klines5mCache = {};
let gatekeeperVetoedUntil = {};
let lastEvaluatedCandle = {}; // Cache Anti-Spam por vela de 5m

// Cotação USD/BRL
let brlGlobal = 5.20;
async function atualizarBRL() {
  try {
    const res = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL', { timeout: 4000 });
    if (res.data?.USDBRL?.bid) brlGlobal = parseFloat(res.data.USDBRL.bid);
  } catch (e) {}
}
setInterval(atualizarBRL, 600000);
atualizarBRL();

// ── FILTRO DE LIQUIDEZ E QUALIDADE (ETAPA 2) ──────────────────────────
async function validarLiquidezMoeda(symbol) {
  try {
    if (!symbol || !symbol.match(/^[A-Z0-9]+USDT$/) || symbol === 'HEMIUSDT') {
      return { ok: false, motivo: 'SIMBOLO_INVALIDO' };
    }

    const [oiData, klines5m, book] = await Promise.all([
      fut.openInterest(symbol).catch(() => null),
      fut.klines(symbol, '5m', 10).catch(() => []),
      fut.livroOfertas(symbol, 5).catch(() => null)
    ]);

    const oiVal = parseFloat(oiData?.openInterest || 0);
    if (!oiVal || oiVal <= 0 || isNaN(oiVal)) {
      return { ok: false, motivo: 'OI_VAZIO' };
    }

    if (!book || !book.bids?.[0] || !book.asks?.[0]) {
      return { ok: false, motivo: 'BOOK_VAZIO' };
    }
    const bid = parseFloat(book.bids[0][0]);
    const ask = parseFloat(book.asks[0][0]);
    if (!bid || !ask || bid <= 0) return { ok: false, motivo: 'PRECO_INVALIDO' };

    const spreadPct = ((ask - bid) / bid) * 100;
    if (spreadPct > 0.15) {
      return { ok: false, motivo: `SPREAD_EXCESSIVO (${spreadPct.toFixed(3)}%)` };
    }

    let flatCandles = 0;
    for (const k of klines5m) {
      const o = parseFloat(k[1]), h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]), v = parseFloat(k[5]);
      if (o === c || h === l || v === 0) flatCandles++;
    }
    if (flatCandles >= 3) {
      return { ok: false, motivo: `ZUMBI (${flatCandles} velas 0%)` };
    }

    return { ok: true, oiVal, spreadPct, flatCandles };
  } catch(e) {
    return { ok: false, motivo: e.message };
  }
}

// ── NOVO MOTOR DE INDICADORES MTF (ETAPAS 3 e 4) ───────────────────────
async function analisarEstruturaEMercado(symbol) {
  try {
    const [k5m, k15m, k1h, k4h, oiHist, takerRatio, premiumData, oiData, bookData, ticker24] = await Promise.all([
      fut.klines(symbol, '5m', 100).catch(() => []),
      fut.klines(symbol, '15m', 100).catch(() => []),
      fut.klines(symbol, '1h', 100).catch(() => []),
      fut.klines(symbol, '4h', 50).catch(() => []),
      fut.openInterestHist(symbol, '5m', 5).catch(() => []),
      fut.takerBuySellRatio(symbol, '5m', 5).catch(() => []),
      fut.precoMarca(symbol).catch(() => null),
      fut.openInterest(symbol).catch(() => null),
      fut.livroOfertas(symbol, 5).catch(() => null),
      fut.ticker24h(symbol).catch(() => null)
    ]);
    const priceChangePercent = parseFloat(ticker24?.priceChangePercent || 0);

    if (!k5m || k5m.length < 30 || !k15m || k15m.length < 50 || !k1h || k1h.length < 50) {
      return null;
    }

    const p5 = {
      opens: k5m.map(v => parseFloat(v[1])),
      highs: k5m.map(v => parseFloat(v[2])),
      lows: k5m.map(v => parseFloat(v[3])),
      closes: k5m.map(v => parseFloat(v[4])),
      vols: k5m.map(v => parseFloat(v[5]))
    };
    const p15 = {
      opens: k15m.map(v => parseFloat(v[1])),
      highs: k15m.map(v => parseFloat(v[2])),
      lows: k15m.map(v => parseFloat(v[3])),
      closes: k15m.map(v => parseFloat(v[4])),
      vols: k15m.map(v => parseFloat(v[5]))
    };
    const p1h = {
      closes: k1h.map(v => parseFloat(v[4]))
    };
    const p4h = {
      closes: (k4h && k4h.length > 0) ? k4h.map(v => parseFloat(v[4])) : []
    };

    const curPrice = p15.closes[p15.closes.length - 1];

    // EMAs 15m
    const ema9_15 = ti.EMA.calculate({ period: 9, values: p15.closes }).slice(-1)[0] || curPrice;
    const ema21_15 = ti.EMA.calculate({ period: 21, values: p15.closes }).slice(-1)[0] || curPrice;
    const ema50_15 = ti.EMA.calculate({ period: 50, values: p15.closes }).slice(-1)[0] || curPrice;
    const ema200_15 = p15.closes.length >= 100 ? (ti.EMA.calculate({ period: 200, values: p15.closes }).slice(-1)[0] || curPrice) : curPrice;

    // EMAs 5m
    const ema9_5 = ti.EMA.calculate({ period: 9, values: p5.closes }).slice(-1)[0] || curPrice;
    const ema21_5 = ti.EMA.calculate({ period: 21, values: p5.closes }).slice(-1)[0] || curPrice;
    const ema50_5 = ti.EMA.calculate({ period: 50, values: p5.closes }).slice(-1)[0] || curPrice;

    // EMAs 1h
    const ema9_1h = ti.EMA.calculate({ period: 9, values: p1h.closes }).slice(-1)[0] || curPrice;
    const ema21_1h = ti.EMA.calculate({ period: 21, values: p1h.closes }).slice(-1)[0] || curPrice;
    const ema50_1h = ti.EMA.calculate({ period: 50, values: p1h.closes }).slice(-1)[0] || curPrice;

    // EMA 4h (50)
    const ema50_4h = p4h.closes.length >= 50 ? (ti.EMA.calculate({ period: 50, values: p4h.closes }).slice(-1)[0] || curPrice) : curPrice;

    // ATR 14 (15m e 5m)
    const atr15m = ti.ATR.calculate({ period: 14, high: p15.highs, low: p15.lows, close: p15.closes }).slice(-1)[0] || (curPrice * 0.01);
    const atrPct15m = (atr15m / curPrice) * 100;
    const atr5m = ti.ATR.calculate({ period: 14, high: p5.highs, low: p5.lows, close: p5.closes }).slice(-1)[0] || (curPrice * 0.005);
    const atrPct5m = (atr5m / curPrice) * 100;

    // Distância da EMA 21 (15m) em ATR
    const distEma21Atr = Math.abs(curPrice - ema21_15) / (atr15m || 1);

    // ADX 14 (15m)
    const adxArr = ti.ADX.calculate({ period: 14, high: p15.highs, low: p15.lows, close: p15.closes });
    const adx15m = (adxArr && adxArr.length > 0) ? (adxArr[adxArr.length - 1].adx || 0) : 0;

    // RVOL 15m (última vela vs média 20)
    const avgVol20 = p15.vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const rvol15m = (p15.vols[p15.vols.length - 1] / (avgVol20 || 1)) || 1.0;

    // Wilder RSI 14 (15m) calculado com 100 velas (elimina o bug do 0.0)
    const rsiArr = ti.RSI.calculate({ period: 14, values: p15.closes });
    const rsi15m = (rsiArr && rsiArr.length > 0) ? parseFloat(rsiArr[rsiArr.length - 1].toFixed(1)) : 50.0;

    // Multi-Timeframe (MTF) vs EMA 50
    const dir4h = curPrice >= ema50_4h ? 'green' : 'red';
    const dir1h = curPrice >= ema50_1h ? 'green' : 'red';
    const dir15m = curPrice >= ema50_15 ? 'green' : 'red';
    const dir5m = curPrice >= ema50_5 ? 'green' : 'red';

    const aptoLong = (dir1h === 'green' && dir15m === 'green' && dir5m === 'green');
    const aptoShort = (dir1h === 'red' && dir15m === 'red' && dir5m === 'red');
    const mtfStatus = aptoLong ? 'APTO_LONG' : (aptoShort ? 'APTO_SHORT' : 'DESALINHADO');
    const mtfText = aptoLong ? 'APTO PARA OPERAR (ALTA)' : (aptoShort ? 'APTO PARA OPERAR (BAIXA)' : 'DESALINHADO (AGUARDAR)');

    // Alinhamento de EMAs (15m)
    let emaAlignStatus = 'EMARANHADAS (LATERAL)';
    if (ema9_15 > ema21_15 && ema21_15 > ema50_15) emaAlignStatus = 'ALINHADAS EM ALTA';
    else if (ema9_15 < ema21_15 && ema21_15 < ema50_15) emaAlignStatus = 'ALINHADAS EM BAIXA';

    // Status da Distância da EMA 21
    let distEmaText = '';
    let distEmaColor = 'var(--gold)';
    if (distEma21Atr <= 1.2) {
      distEmaText = `${distEma21Atr.toFixed(1)}x ATR [Zona de Pullback - OK]`;
      distEmaColor = 'var(--green)';
    } else if (distEma21Atr <= 1.5) {
      distEmaText = `${distEma21Atr.toFixed(1)}x ATR [Moderado]`;
      distEmaColor = 'var(--gold)';
    } else {
      distEmaText = `${distEma21Atr.toFixed(1)}x ATR [Esticado - BLOQUEADO]`;
      distEmaColor = 'var(--red)';
    }

    // Qualidade do Setup
    let qualidadeSetup = 'CONTRA-TENDÊNCIA (BLOQUEADO)';
    let qualidadeCor = 'var(--red)';
    if (distEma21Atr > 1.5) {
      qualidadeSetup = 'ESTICADO (AGUARDAR RECUO)';
      qualidadeCor = 'var(--red)';
    } else if (aptoLong && curPrice >= ema21_15 && distEma21Atr <= 1.2) {
      qualidadeSetup = 'PULLBACK A FAVOR DA TENDÊNCIA';
      qualidadeCor = 'var(--green)';
    } else if (aptoShort && curPrice <= ema21_15 && distEma21Atr <= 1.2) {
      qualidadeSetup = 'PULLBACK A FAVOR DA TENDÊNCIA';
      qualidadeCor = 'var(--green)';
    } else if (rvol15m >= 1.5 && ((aptoLong && curPrice > ema9_15) || (aptoShort && curPrice < ema9_15))) {
      qualidadeSetup = 'ROMPIMENTO COM VOLUME';
      qualidadeCor = 'var(--blue)';
    }

    // Fluxo: Delta OI & Taker Ratio & Funding
    let deltaOI = 0;
    if (oiHist && oiHist.length >= 2) {
      const lastOI = parseFloat(oiHist[oiHist.length - 1].sumOpenInterest);
      const prevOI = parseFloat(oiHist[0].sumOpenInterest);
      if (prevOI > 0) deltaOI = ((lastOI - prevOI) / prevOI) * 100;
    }
    const takerRatioVal = (takerRatio && takerRatio.length > 0) ? parseFloat(takerRatio[takerRatio.length - 1].buySellRatio) : 1.0;
    const fundingRate = parseFloat(premiumData?.lastFundingRate || 0);
    const oiVal = parseFloat(oiData?.openInterest || 0);

    // Contagem de velas flat (0.0%) nas últimas 10 velas de 5m
    const ultimas10_5m = k5m.slice(-10);
    let flatCandles5m = 0;
    for (const v of ultimas10_5m) {
      const o = parseFloat(v[1]), h = parseFloat(v[2]), l = parseFloat(v[3]), c = parseFloat(v[4]), vol = parseFloat(v[5]);
      if (o === c || h === l || vol === 0) flatCandles5m++;
    }

    // Spread do Order Book
    let spreadPct = 0;
    if (bookData && bookData.bids?.[0] && bookData.asks?.[0]) {
      const bid = parseFloat(bookData.bids[0][0]);
      const ask = parseFloat(bookData.asks[0][0]);
      if (bid > 0) spreadPct = ((ask - bid) / bid) * 100;
    }

    // ── VELA 5M E IDENTIFICAÇÃO DE PAVIO / DIREÇÃO ──
    const l5_open = p5.opens.slice(-1)[0] || curPrice;
    const l5_close = p5.closes.slice(-1)[0] || curPrice;
    const l5_high = p5.highs.slice(-1)[0] || curPrice;
    const l5_low = p5.lows.slice(-1)[0] || curPrice;
    const isGreen5m = l5_close >= l5_open;
    const isRed5m = l5_close < l5_open;
    const bodyHigh = Math.max(l5_open, l5_close);
    const bodyLow = Math.min(l5_open, l5_close);
    const bodySize = Math.max(0.000001, bodyHigh - bodyLow);
    const upperWick = l5_high - bodyHigh;
    const lowerWick = bodyLow - l5_low;
    const hasUpperRejection = upperWick > bodySize * 1.2;
    const hasLowerRejection = lowerWick > bodySize * 1.2;

    // Tendência 1h vs 15m (EMA 21 vs EMA 50)
    const isBull1h = ema21_1h > ema50_1h;
    const isBear1h = ema21_1h < ema50_1h;
    const isBull15m = ema21_15 > ema50_15;
    const isBear15m = ema21_15 < ema50_15;

    // Rompimento EMAs no 5m e 15m
    const breakUp = curPrice > ema9_5 && curPrice > ema21_5 && curPrice > ema50_5 && curPrice > ema9_15 && curPrice > ema21_15 && curPrice > ema50_15;
    const breakDown = curPrice < ema9_5 && curPrice < ema21_5 && curPrice < ema50_5 && curPrice < ema9_15 && curPrice < ema21_15 && curPrice < ema50_15;

    // ── CLASSIFICADOR DE 3 MODOS DINÂMICOS ──
    let modoDetectado = null;
    let modoLabel = 'SEM SETUP';
    let direcaoModo = null;
    let motivoModo = 'Aguardando confluência quantitativa';

    // MODO A: PULLBACK DE TENDÊNCIA (Continuidade)
    if (isBull1h && isBull15m && distEma21Atr >= 0.2 && distEma21Atr <= 2.2 && isGreen5m) {
      modoDetectado = 'PULLBACK';
      modoLabel = 'PULLBACK LONG';
      direcaoModo = 'LONG';
      motivoModo = 'Pullback na EMA 21 (15m) a favor da tendência de alta';
    } else if (isBear1h && isBear15m && distEma21Atr >= 0.2 && distEma21Atr <= 2.2 && isRed5m) {
      modoDetectado = 'PULLBACK';
      modoLabel = 'PULLBACK SHORT';
      direcaoModo = 'SHORT';
      motivoModo = 'Pullback na EMA 21 (15m) a favor da tendência de baixa';
    }

    // MODO B: IGNIÇÃO DE FLUXO / BREAKOUT (Momentum)
    if (!modoDetectado) {
      if (breakUp && rvol15m >= 1.4 && deltaOI > 0.5 && takerRatioVal > 1.10 && distEma21Atr <= 3.2) {
        modoDetectado = 'MOMENTUM';
        modoLabel = 'MOMENTUM LONG';
        direcaoModo = 'LONG';
        motivoModo = 'Rompimento de alta com RVOL, Delta OI e agressão compradora';
      } else if (breakDown && rvol15m >= 1.4 && deltaOI > 0.5 && takerRatioVal < 0.90 && distEma21Atr <= 3.2) {
        modoDetectado = 'MOMENTUM';
        modoLabel = 'MOMENTUM SHORT';
        direcaoModo = 'SHORT';
        motivoModo = 'Rompimento de baixa com RVOL, Delta OI e agressão vendedora';
      }
    }

    // MODO C: EXAUSTÃO / RETORNO À MÉDIA (Caça-Reversão)
    if (!modoDetectado) {
      if (distEma21Atr > 3.2 && rsi15m < 22 && takerRatioVal >= 0.95 && deltaOI <= 0.2 && hasLowerRejection) {
        modoDetectado = 'EXAUSTAO_REVERSAO';
        modoLabel = 'EXAUSTÃO REVERSÃO LONG';
        direcaoModo = 'LONG';
        motivoModo = 'Fundo esticado >3.2x ATR com RSI<22, pavio de rejeição e fluxo reagindo';
      } else if (distEma21Atr > 3.2 && rsi15m > 78 && takerRatioVal <= 1.05 && deltaOI <= 0.2 && hasUpperRejection) {
        modoDetectado = 'EXAUSTAO_REVERSAO';
        modoLabel = 'EXAUSTÃO REVERSÃO SHORT';
        direcaoModo = 'SHORT';
        motivoModo = 'Topo esticado >3.2x ATR com RSI>78, pavio de rejeição e agressão exausta';
      }
    }

    // ── SCORE DIRECIONAL AUTOMÁTICO (-100 A +100) ──
    let directionalScore = 0;
    // 1. Posição das EMAs (-35 a +35)
    if (curPrice > ema9_15) directionalScore += 10; else directionalScore -= 10;
    if (ema9_15 > ema21_15) directionalScore += 10; else directionalScore -= 10;
    if (ema21_15 > ema50_15) directionalScore += 10; else directionalScore -= 10;
    if (curPrice > ema21_5) directionalScore += 5; else directionalScore -= 5;

    // 2. Taker Buy/Sell Ratio (-35 a +35)
    if (takerRatioVal >= 1.30) directionalScore += 35;
    else if (takerRatioVal >= 1.15) directionalScore += 25;
    else if (takerRatioVal >= 1.05) directionalScore += 15;
    else if (takerRatioVal <= 0.70) directionalScore -= 35;
    else if (takerRatioVal <= 0.85) directionalScore -= 25;
    else if (takerRatioVal <= 0.95) directionalScore -= 15;

    // 3. Delta OI vs Preço (-30 a +30)
    if (curPrice > ema9_15) {
      if (deltaOI > 1.0) directionalScore += 30;
      else if (deltaOI > 0.3) directionalScore += 20;
      else if (deltaOI < -0.5) directionalScore += 10;
    } else {
      if (deltaOI > 1.0) directionalScore -= 30;
      else if (deltaOI > 0.3) directionalScore -= 20;
      else if (deltaOI < -0.5) directionalScore -= 10;
    }
    directionalScore = Math.max(-100, Math.min(100, directionalScore));

    // Projeções Dinâmicas de Risco (SL / TP / BE / Alavancagem)
    let leverageSugerida = 5;
    if (atrPct15m > 1.5) leverageSugerida = 2;
    else if (atrPct15m > 1.0) leverageSugerida = 3;
    else if (atrPct15m > 0.6) leverageSugerida = 4;
    else leverageSugerida = 5;

    const ladoOp = direcaoModo || (directionalScore >= 0 ? 'LONG' : 'SHORT');
    let slDist, tpDist, slPrice, tpPrice;

    if (modoDetectado === 'EXAUSTAO_REVERSAO') {
      // Modo C: TP exatamente na EMA 21 do 15m
      tpPrice = ema21_15;
      slDist = 1.5 * atr15m;
      slPrice = ladoOp === 'LONG' ? (curPrice - slDist) : (curPrice + slDist);
      tpDist = Math.abs(curPrice - tpPrice);
    } else {
      // Modos A e B: Risco:Retorno 1:2
      slDist = 1.8 * atr15m;
      tpDist = 2.0 * slDist;
      slPrice = ladoOp === 'LONG' ? (curPrice - slDist) : (curPrice + slDist);
      tpPrice = ladoOp === 'LONG' ? (curPrice + tpDist) : (curPrice - tpDist);
    }

    let slPctReal = (slDist / curPrice) * 100;
    let slRoe = slPctReal * leverageSugerida;

    // Banda Saudável de Stop Loss em ROI: Piso Mínimo de 6.0% e Teto Máximo de 12.0%
    const minSlRoi = 6.0;
    const maxSlRoi = 12.0;

    if (slRoe < minSlRoi) {
      slRoe = minSlRoi;
      slDist = curPrice * ((minSlRoi / leverageSugerida) / 100);
      slPctReal = (slDist / curPrice) * 100;
      slPrice = ladoOp === 'LONG' ? (curPrice - slDist) : (curPrice + slDist);
      if (modoDetectado !== 'EXAUSTAO_REVERSAO') {
        tpDist = 2.0 * slDist;
        tpPrice = ladoOp === 'LONG' ? (curPrice + tpDist) : (curPrice - tpDist);
      }
    } else if (slRoe > maxSlRoi) {
      slRoe = maxSlRoi;
      slDist = curPrice * ((maxSlRoi / leverageSugerida) / 100);
      slPctReal = (slDist / curPrice) * 100;
      slPrice = ladoOp === 'LONG' ? (curPrice - slDist) : (curPrice + slDist);
      if (modoDetectado !== 'EXAUSTAO_REVERSAO') {
        tpDist = 2.0 * slDist;
        tpPrice = ladoOp === 'LONG' ? (curPrice + tpDist) : (curPrice - tpDist);
      }
    }

    let tpPctReal = (tpDist / curPrice) * 100;
    let tpRoe = tpPctReal * leverageSugerida;

    // Teto Dinâmico de Take Profit: se projetar > 10.0% ROI, limita no alvo de 10.0% ROI
    if (tpRoe > 10.0) {
      tpDist = curPrice * (0.10 / leverageSugerida);
      tpPrice = ladoOp === 'LONG' ? (curPrice + tpDist) : (curPrice - tpDist);
      tpPctReal = (tpDist / curPrice) * 100;
      tpRoe = 10.0;
    }

    const beTriggerDist = curPrice * ((0.80 / leverageSugerida) / 100);
    const beTriggerPctReal = (beTriggerDist / curPrice) * 100;
    const beTriggerRoe = 0.80;
    const beTriggerPrice = ladoOp === 'LONG' ? (curPrice + beTriggerDist) : (curPrice - beTriggerDist);

    const last5mOpenTime = (k5m && k5m.length > 0) ? k5m[k5m.length - 1][0] : 0;
    return {
      symbol,
      curPrice,
      priceChangePercent,
      last5mOpenTime,
      p15, p5, p1h, p4h,
      ema9_15, ema21_15, ema50_15, ema200_15,
      ema9_5, ema21_5, ema50_5,
      ema9_1h, ema21_1h, ema50_1h, ema50_4h,
      atr15m, atrPct15m, atr5m, atrPct5m,
      distEma21Atr, distEmaText, distEmaColor,
      adx15m, rvol15m, rsi15m,
      dir4h, dir1h, dir15m, dir5m,
      aptoLong, aptoShort, mtfStatus, mtfText,
      emaAlignStatus, qualidadeSetup, qualidadeCor,
      deltaOI, takerRatioVal, fundingRate, oiVal,
      flatCandles5m, spreadPct,
      modoDetectado, modoLabel, direcaoModo, motivoModo, directionalScore,
      leverageSugerida,
      slDist, slPctReal, slRoe, slPrice,
      tpDist, tpPctReal, tpRoe, tpPrice,
      beTriggerDist, beTriggerPctReal, beTriggerRoe, beTriggerPrice
    };
  } catch(e) {
    console.error(`[INDICADORES] Erro em ${symbol}:`, e.message);
    return null;
  }
}

// ── GATEKEEPER DINÂMICO 3 MODOS (ETAPA 5 - 0 TOKENS) ─────────────────
function verificarGatekeeper(dados) {
  if (!dados) return { passou: false, motivo: 'Dados indisponíveis' };

  if (dados.flatCandles5m > 2) {
    return { passou: false, motivo: `Gatekeeper: Moeda zumbi (${dados.flatCandles5m} velas 0% no 5m)` };
  }
  if (dados.spreadPct > 0.15) {
    return { passou: false, motivo: `Gatekeeper: Spread excessivo (${dados.spreadPct.toFixed(3)}%)` };
  }

  // Verifica se a moeda se enquadra em algum dos 3 modos dinâmicos
  if (!dados.modoDetectado) {
    return { passou: false, motivo: 'Gatekeeper: Nenhum setup ativo (nem Pullback, nem Momentum, nem Exaustão)' };
  }

  // Validação direcional por modo
  if (dados.modoDetectado === 'PULLBACK' || dados.modoDetectado === 'MOMENTUM') {
    if (dados.direcaoModo === 'LONG' && dados.directionalScore < 55) {
      return { passou: false, motivo: `Gatekeeper: Score direcional insuficiente para LONG (${dados.directionalScore} < +55)` };
    }
    if (dados.direcaoModo === 'SHORT' && dados.directionalScore > -55) {
      return { passou: false, motivo: `Gatekeeper: Score direcional insuficiente para SHORT (${dados.directionalScore} > -55)` };
    }
  }

  return {
    passou: true,
    modo: dados.modoDetectado,
    modoLabel: dados.modoLabel,
    direcao: dados.direcaoModo,
    directionalScore: dados.directionalScore,
    motivo: dados.motivoModo
  };
}

// ── DECISÃO QUANTITATIVA VIA GEMINI FLASH (ETAPA 6) ───────────────────
async function consultarGeminiQuant(symbol, dados) {
  if (!ROUTER_API_KEY) {
    console.error('[GEMINI-QUANT] Sem ROUTER_API_KEY');
    return { action: 'WAIT', confidence: 0, reason_short: 'Sem chave 9Router' };
  }

  const prompt = `Você é um Gestor Quantitativo Institucional de Futuros da Binance.
Avalie a oportunidade baseando-se no Modo Quantitativo Detectado:
MODO ATIVO: ${dados.modoLabel || dados.modoDetectado}
DIREÇÃO SUGERIDA: ${dados.direcaoModo}
SCORE DIRECIONAL: ${dados.directionalScore} (-100 venda máxima a +100 compra máxima)
MOTIVO DO MODO: ${dados.motivoModo}

DADOS TÉCNICOS DA MOEDA ${symbol}:
- Preço Atual: ${dados.curPrice}
- Tendência MTF: 1h=${dados.dir1h === 'green' ? 'ALTA' : 'BAIXA'}, 15m=${dados.dir15m === 'green' ? 'ALTA' : 'BAIXA'}, 5m=${dados.dir5m === 'green' ? 'ALTA' : 'BAIXA'}
- EMAs 15m: EMA9=${dados.ema9_15.toFixed(4)}, EMA21=${dados.ema21_15.toFixed(4)}, EMA50=${dados.ema50_15.toFixed(4)}
- Distância EMA21: ${dados.distEma21Atr.toFixed(2)}x ATR (ATR 15m: ${dados.atr15m.toFixed(4)} | ${dados.atrPct15m.toFixed(2)}%)
- Força: ADX(15m)=${dados.adx15m.toFixed(1)}, RVOL(15m)=${dados.rvol15m.toFixed(2)}x, RSI(15m Wilder)=${dados.rsi15m}
- Fluxo: Funding Rate=${(dados.fundingRate * 100).toFixed(4)}%, Δ OI(15m)=${dados.deltaOI.toFixed(2)}%, Taker Ratio=${dados.takerRatioVal.toFixed(3)}
- Projeção de Níveis:
  * Alavancagem Sugerida: ${dados.leverageSugerida}x
  * Stop Loss Projetado: ${dados.slPrice.toFixed(4)} (Risco: -${dados.slPctReal.toFixed(2)}% preço, -${dados.slRoe.toFixed(1)}% ROE)
  * Take Profit Projetado: ${dados.tpPrice.toFixed(4)} (Alvo: +${dados.tpPctReal.toFixed(2)}% preço, +${dados.tpRoe.toFixed(1)}% ROE)
  * Breakeven Trigger: ${dados.beTriggerPrice.toFixed(4)} (+${dados.beTriggerPctReal.toFixed(2)}% preço)

Responda EXCLUSIVAMENTE em formato JSON (sem bloco de markdown):
{
  "action": "LONG" | "SHORT" | "WAIT",
  "confidence": 75,
  "leverage": ${dados.leverageSugerida},
  "stop_loss_price": ${dados.slPrice},
  "take_profit_price": ${dados.tpPrice},
  "breakeven_trigger_price": ${dados.beTriggerPrice},
  "reason_short": "máximo 15 palavras explicando decisão"
}`;

  try {
    const payload = {
      model: 'ag/gemini-3.5-flash-low',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1800
    };

    const resp = await axios.post('http://127.0.0.1:20128/v1/chat/completions', payload, {
      headers: {
        'Authorization': `Bearer ${ROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    if (resp.data?.usage) {
      registrarUsoTokens(resp.data.usage);
    }

    const raw = resp.data?.choices?.[0]?.message?.content?.trim() || '';
    let jsonStr = raw;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
    else jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    return parsed;
  } catch(e) {
    console.error(`[GEMINI-QUANT] Erro ao consultar IA para ${symbol}:`, e.message);
    return { action: 'WAIT', confidence: 0, reason_short: 'Falha na IA' };
  }
}


// ── REGRA DE PERDÃO AOS 30 MINUTOS (ESTAGNAÇÃO) ────────────────────────
async function consultarIAPerdao30m(symbol, pos, duracaoMinutos) {
  if (!ROUTER_API_KEY) return 'MANTER';
  try {
    const dados = await analisarEstruturaEMercado(symbol);
    const prompt = `Você é um gestor de risco quantitativo. Uma ordem em ${symbol} (${pos.lado} ${pos.alavancagem}x) está aberta há ${duracaoMinutos} minutos e estagnada (sem volume).
Preço Entrada: ${pos.precoEntrada}, Preço Atual: ${pos.precoMarca || pos.precoEntrada}, PnL: $${pos.pnlNaoRealizado}.
RVOL: ${dados ? dados.rvol15m.toFixed(2) : 1}x, ADX: ${dados ? dados.adx15m.toFixed(1) : 20}.
Responda JSON: {"decisao": "FECHAR" ou "MANTER", "motivo": "explicacao curta"}`;

    const resp = await axios.post('http://127.0.0.1:20128/v1/chat/completions', {
      model: 'ag/gemini-3.5-flash-low',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1200
    }, {
      headers: { 'Authorization': `Bearer ${ROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 12000
    });

    if (resp.data?.usage) registrarUsoTokens(resp.data.usage);
    const raw = resp.data?.choices?.[0]?.message?.content?.trim() || '';
    let jsonStr = raw;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
    else jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    return parsed.decisao === 'FECHAR' ? 'FECHAR' : 'MANTER';
  } catch(e) {
    return 'MANTER';
  }
}

// ── MONITORAMENTO DE RISCO EM CÓDIGO (1.5s - 0 Tokens, 0ms Delay) ─────
let isMonitoringTick = false;
const closingInProgress = new Set();
setInterval(async () => {
  if (isMonitoringTick) return;
  isMonitoringTick = true;
  try {
    for (const sym of Object.keys(localAlvos)) {
      if (closingInProgress.has(sym)) continue;
      try {
        const alvo = localAlvos[sym];
        const pos = await fut.posicao(sym);
        if (!pos || pos.quantidade === 0) {
          delete localAlvos[sym];
          delete maxPriceTracker[sym];
          delete minPriceTracker[sym];
          salvarAlvos();
          continue;
        }

        const curPrice = parseFloat(pos.precoMarca) || parseFloat(pos.precoEntrada);
        const entryPrice = parseFloat(pos.precoEntrada);
        const alav = pos.alavancagem || 1;
        const isLong = pos.lado === 'LONG';
        const margemInicial = (Math.abs(pos.quantidade) * entryPrice) / alav;
        const varPrecoPct = ((curPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
        const roiPuro = varPrecoPct * alav;
        const roi = roiPuro;

        // ── MONITORAMENTO DE ROI MÁXIMO (BASEADO 100% EM ROI) ──
        if (alvo.maxRoiReached === undefined || roi > alvo.maxRoiReached) {
          alvo.maxRoiReached = roi;
        }
        const maxRoi = alvo.maxRoiReached || 0;

        // ── NOVO GERENCIAMENTO DE BREAKEVEN (3 ESTÁGIOS FIXOS EM ROI) ──
        const prevStage = alvo.beStage || 0;
        let novoEstagio = 0;
        let lockedRoi = 0;

        // Estágio 3: Atingiu +3.00% de ROI em diante -> trava fixo garantindo exatamente +0.70% de ROI
        if (maxRoi >= 3.00) {
          novoEstagio = 3;
          lockedRoi = 0.70;
        }
        // Estágio 2: Atingiu +1.50% de ROI (< 3.00) -> posiciona stop garantindo exatamente +0.50% de ROI
        else if (maxRoi >= 1.50) {
          novoEstagio = 2;
          lockedRoi = 0.50;
        }
        // Estágio 1: Passou de +0.80% de ROI (< 1.50) -> posiciona stop garantindo exatamente +0.30% de ROI
        else if (maxRoi >= 0.80) {
          novoEstagio = 1;
          lockedRoi = 0.30;
        }
        // Antes de +0.80% de ROI: Breakeven desligado. Opera apenas com SL e TP originais.
        else {
          novoEstagio = 0;
          lockedRoi = 0;
        }

        if (novoEstagio > 0) {
          alvo.beArmed = true;
          alvo.beStage = novoEstagio;
          alvo.lockedRoi = lockedRoi;
          alvo.beStopPrice = entryPrice * (1 + (isLong ? 1 : -1) * ((lockedRoi / alav) / 100));
          const stopFmt = formatarPrecoAtivo(sym, alvo.beStopPrice);
          alvo.beLabel = `🛡️ BREAKEVEN ATIVO: GARANTIDO +${lockedRoi.toFixed(1)}% ROI ($${stopFmt}) | PICO: +${maxRoi.toFixed(2)}% ROI`;

          if (novoEstagio !== prevStage) {
            salvarAlvos();
            console.log(`[BREAKEVEN-E${novoEstagio}] ${sym} (${pos.lado}): Pico +${maxRoi.toFixed(2)}% ROI -> Stop garantido em +${lockedRoi.toFixed(1)}% ROI ($${stopFmt})`);
          }
        } else {
          alvo.beArmed = false;
          alvo.beStage = 0;
          alvo.lockedRoi = 0;
          alvo.beStopPrice = null;
          alvo.beLabel = '';
        }

        let deveFechar = false;
        let motivoFechamento = '';

        if (isLong) {
          if (!maxPriceTracker[sym]) maxPriceTracker[sym] = curPrice;
          else if (curPrice > maxPriceTracker[sym]) maxPriceTracker[sym] = curPrice;

          // 1. Take Profit
          if (!deveFechar && alvo.tpPrice && curPrice >= alvo.tpPrice) {
            deveFechar = true;
            motivoFechamento = `[TAKE PROFIT] Preço ${formatarPrecoAtivo(sym, curPrice)} >= TP ${formatarPrecoAtivo(sym, alvo.tpPrice)} (+${roi.toFixed(2)}% ROI)`;
          }
          // 2. Stop Loss (Preço ATR ou Teto Rígido -12.0% ROI)
          else if (!deveFechar && alvo.slPrice && curPrice <= alvo.slPrice) {
            deveFechar = true;
            motivoFechamento = `[STOP LOSS ATR] Preço ${formatarPrecoAtivo(sym, curPrice)} <= SL ${formatarPrecoAtivo(sym, alvo.slPrice)} (${roi.toFixed(2)}% ROI)`;
          }
          else if (!deveFechar && roi <= -12.0) {
            deveFechar = true;
            motivoFechamento = `[SAFETY SL -12%] ROI atingiu ${roi.toFixed(2)}% (Teto -12.0% ROI)`;
          }
          // 3. Breakeven (Só aciona se o ROI atual cair de volta e tocar ou cruzar para baixo do lockedRoi ativo)
          else if (!deveFechar && alvo.beArmed && (roi <= alvo.lockedRoi || (alvo.beStopPrice && curPrice <= alvo.beStopPrice))) {
            deveFechar = true;
            motivoFechamento = `[BREAKEVEN] ROI recuou para ${roi.toFixed(2)}% <= +${alvo.lockedRoi.toFixed(1)}% ROI ($${formatarPrecoAtivo(sym, alvo.beStopPrice)} | Pico: +${maxRoi.toFixed(2)}%)`;
          }
        } else {
          // SHORT
          if (!minPriceTracker[sym]) minPriceTracker[sym] = curPrice;
          else if (curPrice < minPriceTracker[sym]) minPriceTracker[sym] = curPrice;

          // 1. Take Profit
          if (!deveFechar && alvo.tpPrice && curPrice <= alvo.tpPrice) {
            deveFechar = true;
            motivoFechamento = `[TAKE PROFIT] Preço ${formatarPrecoAtivo(sym, curPrice)} <= TP ${formatarPrecoAtivo(sym, alvo.tpPrice)} (+${roi.toFixed(2)}% ROI)`;
          }
          // 2. Stop Loss (Preço ATR ou Teto Rígido -12.0% ROI)
          else if (!deveFechar && alvo.slPrice && curPrice >= alvo.slPrice) {
            deveFechar = true;
            motivoFechamento = `[STOP LOSS ATR] Preço ${formatarPrecoAtivo(sym, curPrice)} >= SL ${formatarPrecoAtivo(sym, alvo.slPrice)} (${roi.toFixed(2)}% ROI)`;
          }
          else if (!deveFechar && roi <= -12.0) {
            deveFechar = true;
            motivoFechamento = `[SAFETY SL -12%] ROI atingiu ${roi.toFixed(2)}% (Teto -12.0% ROI)`;
          }
          // 3. Breakeven (Só aciona se o ROI atual cair de volta e tocar ou cruzar para baixo do lockedRoi ativo)
          else if (!deveFechar && alvo.beArmed && (roi <= alvo.lockedRoi || (alvo.beStopPrice && curPrice >= alvo.beStopPrice))) {
            deveFechar = true;
            motivoFechamento = `[BREAKEVEN] ROI recuou para ${roi.toFixed(2)}% <= +${alvo.lockedRoi.toFixed(1)}% ROI ($${formatarPrecoAtivo(sym, alvo.beStopPrice)} | Pico: +${maxRoi.toFixed(2)}%)`;
          }
        }

        if (deveFechar) {
          closingInProgress.add(sym);
          const alvoBackup = { ...localAlvos[sym] };
          delete localAlvos[sym];
          delete maxPriceTracker[sym];
          delete minPriceTracker[sym];
          salvarAlvos();

          try {
            console.log(`[FECHAMENTO QUANT] ${sym}: ${motivoFechamento}`);
            await fut.cancelarTodasOrdens(sym);
            await fut.fecharMercado(sym, pos.lado, pos.quantidade);

            const exitTipo = (motivoFechamento.includes('TAKE PROFIT') || motivoFechamento.includes('TETO TP')) ? 'TP' : (motivoFechamento.includes('BREAKEVEN') ? 'BREAKEVEN' : 'SL');
            await rag.salvarSaidaRAG({
              symbol: sym,
              exitPrice: curPrice,
              exitReason: exitTipo,
              roiPct: roi,
              pnlUsdt: pos.pnlNaoRealizado
            }).catch(() => {});

            registrarDesfechoTrade(sym, exitTipo, roi, pos.pnlNaoRealizado);

            // Libera slot com cooldown 45s
            [1, 2].forEach(s => {
              if (autoBotState.slots[s].symbol === sym) {
                autoBotState.slots[s].symbol = null;
                autoBotState.slots[s].side = null;
                autoBotState.slots[s].targetSymbol = null;
                autoBotState.slots[s].searchCooldownUntil = Date.now() + 45000;
                autoBotState.slots[s].status = 'FECHADO_COOLDOWN_45S';
              }
            });
          } catch(err) {
            console.error(`[FECHAMENTO QUANT] Erro ao fechar ${sym}:`, err.message);
            const posRest = await fut.posicao(sym).catch(() => null);
            if (posRest && posRest.quantidade > 0) {
              localAlvos[sym] = alvoBackup;
              salvarAlvos();
            }
          } finally {
            closingInProgress.delete(sym);
          }
        }
      } catch(e) {}
    }
  } finally {
    isMonitoringTick = false;
  }
}, 1500);

// ── ROBÔ AUTÔNOMO CONTÍNUO (ETAPA 5: GATEKEEPER + CANDLE 5M) ───────────
let autoBotLoopRunning = false;
setInterval(async () => {
  if (!autoBotState.enabled || autoBotLoopRunning) return;
  autoBotLoopRunning = true;

  try {
    const now = Date.now();

    // ── OTIMIZAÇÃO 2: PAUSA TOTAL DE CONSULTAS DE ENTRADA COM SLOTS CHEIOS ──
    const slot1Ocupado = !!autoBotState.slots[1].symbol;
    const slot2Ocupado = !!autoBotState.slots[2].symbol;

    if (slot1Ocupado && slot2Ocupado) {
      autoBotState.lastLog = `[SLOTS OCUPADOS - MONITORANDO POSIÇÕES] Slot 1: ${autoBotState.slots[1].symbol} | Slot 2: ${autoBotState.slots[2].symbol}`;
      for (const slotNum of [1, 2]) {
        const slot = autoBotState.slots[slotNum];
        slot.status = `[SLOTS OCUPADOS - MONITORANDO POSIÇÕES] (${slot.symbol})`;
        try {
          const pos = await fut.posicao(slot.symbol);
          if (!pos || pos.quantidade === 0) {
            slot.symbol = null;
            slot.targetSymbol = null;
            slot.side = null;
            slot.status = 'LIVRE';
            continue;
          }

          const duracaoMs = now - (slot.openTime || now);
          if (duracaoMs >= 30 * 60 * 1000) {
            if (now - (slot.last30mCheck || 0) >= 5 * 60 * 1000) {
              slot.last30mCheck = now;
              const duracaoMin = Math.round(duracaoMs / 60000);
              console.log(`[AUTOBOT-30M] Slot ${slotNum} (${slot.symbol}): ${duracaoMin} min aberto. Avaliando estagnação...`);
              const decisao30m = await consultarIAPerdao30m(slot.symbol, pos, duracaoMin);
              if (decisao30m === 'FECHAR') {
                console.log(`[AUTOBOT-30M] Slot ${slotNum}: IA recomendou FECHAR PERDÃO em ${slot.symbol}!`);
                await fut.cancelarTodasOrdens(slot.symbol);
                await fut.fecharMercado(slot.symbol, pos.lado, pos.quantidade);

                const margem = pos.margem || ((pos.quantidade * pos.precoEntrada) / (pos.alavancagem || 1));
                const roiFinal = margem > 0 ? (pos.pnlNaoRealizado / margem) * 100 : 0;
                await rag.salvarSaidaRAG({
                  symbol: slot.symbol,
                  exitPrice: pos.precoMarca || pos.precoEntrada,
                  exitReason: 'PERDAO_30M',
                  roiPct: roiFinal,
                  pnlUsdt: pos.pnlNaoRealizado
                }).catch(() => {});

                registrarDesfechoTrade(slot.symbol, 'PERDAO_30M', roiFinal, pos.pnlNaoRealizado);

                delete localAlvos[slot.symbol];
                delete maxPriceTracker[slot.symbol];
                delete minPriceTracker[slot.symbol];
                salvarAlvos();

                const symFechado = slot.symbol;
                slot.symbol = null;
                slot.side = null;
                slot.targetSymbol = null;
                slot.searchCooldownUntil = now + 45000;
                slot.status = 'PERDAO_COOLDOWN_45S';
                autoBotState.lastLog = `Slot ${slotNum}: Fechado com perdão aos 30m em ${symFechado}. Cooldown 45s.`;
              }
            }
          }
        } catch(e) {}
      }
      return; // ZERO TOKENS GASTOS! NENHUMA CHAMADA DE IA PARA ENTRADA ENQUANTO SLOTS ESTIVEREM OCUPADOS!
    }

    for (const slotNum of [1, 2]) {
      const slot = autoBotState.slots[slotNum];
      const outroSlot = autoBotState.slots[slotNum === 1 ? 2 : 1];
      const moedaOutroSlot = outroSlot.symbol || outroSlot.targetSymbol;

      // 1. Slot operando: verificar perdão aos 30 minutos
      if (slot.symbol) {
        try {
          const pos = await fut.posicao(slot.symbol);
          if (!pos || pos.quantidade === 0) {
            slot.symbol = null;
            slot.targetSymbol = null;
            slot.side = null;
            slot.status = 'LIVRE';
            continue;
          }

          slot.status = `[POSIÇÃO ATIVA] ${slot.symbol} (${slot.side || pos.lado} ${slot.leverage || pos.alavancagem}x)`;

          const duracaoMs = now - (slot.openTime || now);
          if (duracaoMs >= 30 * 60 * 1000) {
            if (now - (slot.last30mCheck || 0) >= 5 * 60 * 1000) {
              slot.last30mCheck = now;
              const duracaoMin = Math.round(duracaoMs / 60000);
              console.log(`[AUTOBOT-30M] Slot ${slotNum} (${slot.symbol}): ${duracaoMin} min aberto. Avaliando estagnação...`);
              const decisao30m = await consultarIAPerdao30m(slot.symbol, pos, duracaoMin);
              if (decisao30m === 'FECHAR') {
                console.log(`[AUTOBOT-30M] Slot ${slotNum}: IA recomendou FECHAR PERDÃO em ${slot.symbol}!`);
                await fut.cancelarTodasOrdens(slot.symbol);
                await fut.fecharMercado(slot.symbol, pos.lado, pos.quantidade);

                const margem = pos.margem || ((pos.quantidade * pos.precoEntrada) / (pos.alavancagem || 1));
                const roiFinal = margem > 0 ? (pos.pnlNaoRealizado / margem) * 100 : 0;
                await rag.salvarSaidaRAG({
                  symbol: slot.symbol,
                  exitPrice: pos.precoMarca || pos.precoEntrada,
                  exitReason: 'PERDAO_30M',
                  roiPct: roiFinal,
                  pnlUsdt: pos.pnlNaoRealizado
                }).catch(() => {});

                registrarDesfechoTrade(slot.symbol, 'PERDAO_30M', roiFinal, pos.pnlNaoRealizado);

                delete localAlvos[slot.symbol];
                delete maxPriceTracker[slot.symbol];
                delete minPriceTracker[slot.symbol];
                salvarAlvos();

                const symFechado = slot.symbol;
                slot.symbol = null;
                slot.side = null;
                slot.targetSymbol = null;
                slot.searchCooldownUntil = now + 45000;
                slot.status = 'PERDAO_COOLDOWN_45S';
                autoBotState.lastLog = `Slot ${slotNum}: Fechado com perdão aos 30m em ${symFechado}. Cooldown 45s.`;
                continue;
              }
            }
          }
        } catch(e) {}
        continue;
      }

      // 2. Slot vago: respeitar cooldown 45s
      if (slot.searchCooldownUntil && now < slot.searchCooldownUntil) {
        const restSec = Math.round((slot.searchCooldownUntil - now) / 1000);
        slot.status = `[COOLDOWN PÓS-SAÍDA] Aguardando ${restSec}s`;
        continue;
      }

      // 3. Buscar moeda candidata líquida se não tiver
      if (!slot.targetSymbol) {
        slot.status = 'ESCANEANDO_MERCADO';
        const volData = await fut.ticker24h().catch(() => []);
        const vetados = await rag.consultarParesVetados(45).catch(() => []);
        const vetadosSet = new Set(vetados.map(v => v.symbol));

        // Conjunto global de símbolos ativos ou em avaliação nos 2 slots
        const openingOrActiveSymbols = new Set();
        [1, 2].forEach(s => {
          if (autoBotState.slots[s].symbol) openingOrActiveSymbols.add(autoBotState.slots[s].symbol);
          if (autoBotState.slots[s].targetSymbol) openingOrActiveSymbols.add(autoBotState.slots[s].targetSymbol);
        });
        Object.keys(localAlvos).forEach(s => openingOrActiveSymbols.add(s));

        // Ordena por volatilidade excluindo pares ativos em qualquer slot ou vetados recentemente
        const candidatos = volData
          .filter(t => {
            const sym = t.symbol;
            if (!sym.match(/^[A-Z0-9]+USDT$/) || sym === 'HEMIUSDT') return false;
            if (openingOrActiveSymbols.has(sym)) return false;
            if (vetadosSet.has(sym)) return false;
            if (gatekeeperVetoedUntil[sym] && now < gatekeeperVetoedUntil[sym]) return false;
            if (parseFloat(t.count || 0) <= 1000) return false;
            return true;
          })
          .sort((a, b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)))
          .slice(0, 15);

        let moedaEscolhida = null;
        for (const c of candidatos) {
          const liq = await validarLiquidezMoeda(c.symbol);
          if (liq.ok) {
            moedaEscolhida = c.symbol;
            break;
          }
        }

        if (!moedaEscolhida) {
          slot.status = 'SEM_MOEDAS_LIQUIDAS';
          continue;
        }

        slot.targetSymbol = moedaEscolhida;
        slot.targetAssignedTime = now;
        slot.lastChecked60sTime = 0;
        slot.status = `CANDIDATO: ${moedaEscolhida} (AVALIANDO FLUXO)`;
        console.log(`[AUTOBOT] Slot ${slotNum} escolheu candidato líquido: ${moedaEscolhida}`);
      }

      // 4. Analisar candidato
      const cand = slot.targetSymbol;
      const outroSlotNum = (slotNum === 1 ? 2 : 1);
      const outroMoedaAtiva = autoBotState.slots[outroSlotNum].symbol;
      const outroMoedaAlvo = autoBotState.slots[outroSlotNum].targetSymbol;

      // Trava estrita anti-conflito: Slot 1 e Slot 2 NUNCA operam nem avaliam a mesma moeda
      if (cand === outroMoedaAtiva || (outroMoedaAlvo && cand === outroMoedaAlvo && slotNum > outroSlotNum) || (localAlvos[cand] && slot.symbol !== cand)) {
        console.log(`[AUTOBOT-CONFLITO] Slot ${slotNum} abortou ${cand}: já em uso ou ativo em outro slot`);
        slot.targetSymbol = null;
        continue;
      }

      // Ciclo ágil de avaliação a cada 60 segundos
      if (now - (slot.lastChecked60sTime || 0) < 60000) {
        const restSec = Math.round((60000 - (now - (slot.lastChecked60sTime || 0))) / 1000);
        slot.status = `MONITORANDO: ${cand} (REAVALIA EM ${restSec}s)`;
        continue;
      }

      slot.lastChecked60sTime = now;

      const dados = await analisarEstruturaEMercado(cand);
      if (!dados) {
        slot.status = 'ERRO_INDICADORES';
        slot.targetSymbol = null;
        continue;
      }

      const scoreTxt = (dados.directionalScore > 0 ? '+' : '') + dados.directionalScore;
      const modoTxt = dados.modoLabel || 'SEM SETUP';

      // ── OTIMIZAÇÃO: GATEKEEPER HARDCODED (0 TOKENS) ──
      const gk = verificarGatekeeper(dados);
      if (!gk.passou) {
        console.log(`[GATEKEEPER-RECUSA] Slot ${slotNum} (${cand}) [${modoTxt} | Score: ${scoreTxt}]: ${gk.motivo}`);
        slot.status = `[RECUSADO: ${gk.motivo}]`;
        autoBotState.lastLog = `Slot ${slotNum} (${cand}): ${gk.motivo}`;
        gatekeeperVetoedUntil[cand] = now + 120000; // 2 min de respiro para testar outros pares
        slot.targetSymbol = null;
        continue;
      }

      // ── OTIMIZAÇÃO 1: CACHE ANTI-SPAM POR VELA DE 5 MINUTOS ──
      const candle5mTime = dados.last5mOpenTime || (Math.floor(now / 300000) * 300000);
      const cached = lastEvaluatedCandle[cand];
      if (cached && cached.candleTime === candle5mTime) {
        const scoreDiff = Math.abs(dados.directionalScore - cached.score);
        if (cached.action === 'WAIT' && scoreDiff < 15) {
          console.log(`[CACHE-5M] Slot ${slotNum} (${cand}) [${modoTxt}]: Vela 5m inalterada (${new Date(candle5mTime).toLocaleTimeString('pt-BR')}), Score: ${scoreTxt} (diff: ${scoreDiff} < 15). Pulando IA (0 tokens). Motivo anterior: ${cached.reason}`);
          slot.status = `[AGUARDANDO NOVA VELA 5M] ${cand} (Score: ${scoreTxt})`;
          autoBotState.lastLog = `Slot ${slotNum} (${cand}): [AGUARDANDO NOVA VELA 5M] (Score: ${scoreTxt})`;
          gatekeeperVetoedUntil[cand] = now + 60000; // 60s antes de testar de novo
          slot.targetSymbol = null;
          continue;
        }
      }

      // ── CONSULTA GEMINI FLASH QUANT (CONFLUÊNCIA CONFIRMADA) ──
      console.log(`[CONSULTANDO-IA] Slot ${slotNum} (${cand}) [${modoTxt} | Score: ${scoreTxt}] -> Chamando Gemini Flash...`);
      slot.status = `[${modoTxt} - SCORE: ${scoreTxt}] CONSULTANDO IA...`;
      const dec = await consultarGeminiQuant(cand, dados);

      // Salva no Cache Anti-Spam por vela de 5m
      lastEvaluatedCandle[cand] = {
        candleTime: candle5mTime,
        score: dados.directionalScore,
        action: dec.action,
        reason: dec.reason_short,
        evaluatedAt: now
      };

      if ((dec.action === 'LONG' || dec.action === 'SHORT') && dec.confidence >= 65) {
        const ladoTrade = dec.action === 'LONG' ? 'BUY' : 'SELL';
        const alav = Math.min(5, Math.max(1, dec.leverage || dados.leverageSugerida));
        const valorUSDT = 10;

        // Garantia absoluta: não abre se já houver posição ativa na Binance
        const posAtual = await fut.posicao(cand).catch(() => null);
        if (posAtual && posAtual.quantidade > 0) {
          console.log(`[AUTOBOT-CONFLITO] ${cand} já possui posição aberta. Abortando.`);
          slot.targetSymbol = null;
          continue;
        }

        await fut.garantirAlavancagem(cand, alav, 'ISOLATED');
        const book = await fut.livroOfertas(cand, 5);
        const bestBid = parseFloat((book?.bids?.[0] || [])[0]);
        const bestAsk = parseFloat((book?.asks?.[0] || [])[0]);
        if (!bestBid || !bestAsk) continue;

        // Check rigoroso de Spread Instantâneo (> 0.30% aborta na hora)
        const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
        if (spreadPct > 0.30) {
          console.log(`[AUTOBOT-SPREAD-VETO] Slot ${slotNum} (${cand}): Spread instantâneo de ${spreadPct.toFixed(3)}% > 0.30% max. Cancelando envio para proteger contra slippage.`);
          gatekeeperVetoedUntil[cand] = now + 60000;
          slot.targetSymbol = null;
          continue;
        }

        const precoExec = parseFloat(ladoTrade === 'BUY' ? bestAsk : bestBid);
        if (!precoExec) continue;

        const calc = fut.calcularQuantidade(cand, valorUSDT, precoExec, alav);
        if (!calc.ok) {
          console.error(`[AUTOBOT] Erro cálculo qty em ${cand}:`, calc.motivo);
          gatekeeperVetoedUntil[cand] = now + 5 * 60 * 1000;
          slot.targetSymbol = null;
          continue;
        }

        // Execução maker/limit-chase protegida
        let ord = await fut.colocarLimite(cand, ladoTrade, calc.qty, precoExec);
        await new Promise(r => setTimeout(r, 1200));
        try { await fut.cancelarOrdem(cand, ord.orderId); } catch(e){}
        let st = await fut.consultarOrdem(cand, ord.orderId);
        let filledQty = parseFloat(st.executedQty) || 0;

        if (filledQty === 0) {
          const book2 = await fut.livroOfertas(cand, 5);
          const precoExec2 = parseFloat(ladoTrade === 'BUY' ? (book2.asks[0] || [])[0] : (book2.bids[0] || [])[0]);
          if (precoExec2 && Math.abs(precoExec2 - precoExec) / precoExec <= 0.003) {
            let ord2 = await fut.colocarLimite(cand, ladoTrade, calc.qty, precoExec2);
            await new Promise(r => setTimeout(r, 1200));
            try { await fut.cancelarOrdem(cand, ord2.orderId); } catch(e){}
            st = await fut.consultarOrdem(cand, ord2.orderId);
            filledQty = parseFloat(st.executedQty) || 0;
          }
        }

        if (filledQty > 0) {
          slot.symbol = cand;
          slot.side = dec.action;
          slot.leverage = alav;
          slot.openTime = now;
          slot.last30mCheck = now;
          slot.status = `[ATIVO: ${cand} ${dec.action} ${alav}x]`;

          // SL e TP 100% matemáticos pelo código (IA NÃO define preços de SL ou TP)
          let slDistExec = precoExec * (dados.slPctReal / 100);
          let slRoeExec = (slDistExec / precoExec) * alav * 100;

          // Banda saudável de ROI no SL: piso -6.0% e teto -12.0%
          if (slRoeExec < 6.0) {
            slRoeExec = 6.0;
            slDistExec = precoExec * ((6.0 / alav) / 100);
          } else if (slRoeExec > 12.0) {
            slRoeExec = 12.0;
            slDistExec = precoExec * ((12.0 / alav) / 100);
          }
          const slPrecoDefinido = dec.action === 'LONG' ? (precoExec - slDistExec) : (precoExec + slDistExec);

          // Take Profit no dobro da distância do SL (R:R 1:2), respeitando teto dinâmico de 10.0% ROI
          let tpDistExec = (dados.modoDetectado === 'EXAUSTAO_REVERSAO' && dados.tpPrice)
            ? Math.abs(precoExec - dados.tpPrice)
            : 2.0 * slDistExec;
          let tpRoeProj = (tpDistExec / precoExec) * alav * 100;
          if (tpRoeProj > 10.0) {
            tpDistExec = precoExec * (0.10 / alav);
          }
          const tpPrecoDefinido = dec.action === 'LONG' ? (precoExec + tpDistExec) : (precoExec - tpDistExec);

          const beTriggerDist = precoExec * ((0.80 / alav) / 100);
          const beTriggerPrice = dec.action === 'LONG' ? (precoExec + beTriggerDist) : (precoExec - beTriggerDist);

          console.log(`[ORDEM-EXECUTADA] Slot ${slotNum} (${cand}) [${modoTxt}]: ${dec.action} ${alav}x a $${formatarPrecoAtivo(cand, precoExec)} | Qty: ${filledQty} | SL: $${formatarPrecoAtivo(cand, slPrecoDefinido)} (-${slRoeExec.toFixed(1)}% ROI) | TP: $${formatarPrecoAtivo(cand, tpPrecoDefinido)}`);

          // Armar alvos em código
          localAlvos[cand] = {
            side: dec.action,
            entryPrice: precoExec,
            slPrice: slPrecoDefinido,
            tpPrice: tpPrecoDefinido,
            beTriggerPrice: beTriggerPrice,
            slDistPct: (slDistExec / precoExec),
            beArmed: false,
            beStage: 0,
            beStopPrice: null,
            beLabel: '',
            lockedRoi: 0,
            leverage: alav,
            maxRoiReached: 0
          };
          salvarAlvos();

          // Salvar entrada no RAG
          await rag.salvarEntradaRAG({
            symbol: cand,
            side: dec.action,
            leverage: alav,
            mode: dados.modoLabel || dados.modoDetectado || 'QUANT_MTF',
            scoreTotal: dec.confidence,
            rsi15m: dados.rsi15m,
            rsi1m: 50.0,
            emaStatus: dados.emaAlignStatus,
            sarStatus: dados.mtfStatus,
            volRatio: dados.rvol15m,
            fundingRate: dados.fundingRate,
            bookRatio: dados.takerRatioVal,
            fiboPos: `${dados.distEma21Atr.toFixed(1)}x ATR`,
            patterns: dados.qualidadeSetup,
            aiThesis: dec.reason_short,
            entryPrice: precoExec
          }).catch(() => {});

          autoBotState.lastLog = `Slot ${slotNum}: Entrou ${dec.action} em ${cand} (${alav}x). Conf: ${dec.confidence}%. ${dec.reason_short}`;
        } else {
          slot.status = `[ESCORREGOU: ${cand} (Não preencheu)]`;
        }
      } else {
        console.log(`[IA-RECUSA] Slot ${slotNum} (${cand}) [${modoTxt} | Score: ${scoreTxt} | Conf: ${dec.confidence}%]: ${dec.reason_short}`);
        slot.status = `[IA RECUSOU: ${dec.reason_short || 'Sem confluência'}]`;
        autoBotState.lastLog = `Slot ${slotNum} (${cand}) IA: ${dec.reason_short || 'Aguardar confluência'}`;
        gatekeeperVetoedUntil[cand] = now + 5 * 60 * 1000;
        slot.targetSymbol = null;
      }
    }
  } catch(e) {
    console.error('[AUTOBOT-LOOP] Erro:', e.message);
  } finally {
    autoBotLoopRunning = false;
  }
}, 3000);


// ── ROTAS DE API DO BACKEND ───────────────────────────────────────────

app.get('/api/saldo', async (req, res) => {
  try {
    const s = await fut.saldoUSDT();
    const total = (typeof s === 'number') ? s : (s?.total || 0);
    const disponivel = (typeof s === 'number') ? s : (s?.disponivel || total);
    
    let pnlHoje = 0;
    try {
      const h = await fut.income({ startTime: marcoZero, limit: 1000 });
      for (const item of h || []) {
        if (item.symbol !== 'HEMIUSDT' && item.time >= marcoZero) {
          if (item.incomeType === 'REALIZED_PNL' || item.incomeType === 'COMMISSION' || item.incomeType === 'FUNDING_FEE') {
            pnlHoje += parseFloat(item.income);
          }
        }
      }
    } catch(e) {}

    res.json({ success: true, saldo: total, disponivel, pnlHoje, brl: brlGlobal });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

// Scanner de Voláteis com Filtro de Liquidez (ETAPA 2)
app.get('/api/volateis', async (req, res) => {
  try {
    const data = await fut.ticker24h();
    const candidatos = data
      .filter(t => t.symbol.match(/^[A-Z0-9]+USDT$/) && t.symbol !== 'HEMIUSDT' && parseFloat(t.count || 0) > 1000)
      .sort((a, b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)))
      .slice(0, 20);

    const filtradas = [];
    for (const c of candidatos) {
      if (filtradas.length >= 10) break;
      const liq = await validarLiquidezMoeda(c.symbol);
      if (liq.ok) {
        filtradas.push({
          symbol: c.symbol,
          priceChangePercent: c.priceChangePercent,
          lastPrice: c.lastPrice,
          spreadPct: liq.spreadPct
        });
      }
    }

    res.json({ success: true, data: filtradas });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

// Rota de Análise Completa da Moeda (ETAPAS 3 e 4)
app.get('/api/moeda/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const dados = await analisarEstruturaEMercado(symbol);
    if (!dados) return res.json({ success: false, error: 'Dados insuficientes para análise' });

    let pos = null;
    try {
      const p = await fut.posicao(symbol);
      if (p && p.quantidade > 0) pos = p;
    } catch(e) {}

    res.json({
      success: true,
      symbol,
      preco: dados.curPrice,
      priceChangePercent: dados.priceChangePercent || 0,
      intervals: {
        '4h': dados.dir4h,
        '1h': dados.dir1h,
        '15m': dados.dir15m,
        '5m': dados.dir5m
      },
      mtfStatus: dados.mtfStatus,
      mtfText: dados.mtfText,
      emaAlignStatus: dados.emaAlignStatus,
      distEma21Atr: dados.distEma21Atr,
      distEmaText: dados.distEmaText,
      distEmaColor: dados.distEmaColor,
      atr15m: dados.atr15m,
      atrPct15m: dados.atrPct15m,
      adx15m: dados.adx15m,
      rvol15m: dados.rvol15m,
      rsi: dados.rsi15m,
      qualidadeSetup: dados.qualidadeSetup,
      qualidadeCor: dados.qualidadeCor,
      leverageSugerida: dados.leverageSugerida,
      slPrice: dados.slPrice,
      slPctReal: dados.slPctReal,
      slRoe: dados.slRoe,
      tpPrice: dados.tpPrice,
      tpPctReal: dados.tpPctReal,
      tpRoe: dados.tpRoe,
      beTriggerPrice: dados.beTriggerPrice,
      beTriggerPctReal: dados.beTriggerPctReal,
      modoDetectado: dados.modoDetectado,
      modoLabel: dados.modoLabel,
      direcaoModo: dados.direcaoModo,
      motivoModo: dados.motivoModo,
      directionalScore: dados.directionalScore,
      beArmed: !!localAlvos[symbol]?.beArmed,
      beStage: localAlvos[symbol]?.beStage || 0,
      beStopPrice: localAlvos[symbol]?.beStopPrice || null,
      beLabel: localAlvos[symbol]?.beLabel || '',
      lockedRoi: localAlvos[symbol]?.lockedRoi || 0,
      maxRoiReached: localAlvos[symbol]?.maxRoiReached || 0,
      pricePrecision: fut.filtrosDe(symbol)?.pricePrecision ?? 4,
      pos
    });
  } catch(err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

// Métricas de Fluxo do Rodapé: Taker Ratio, Delta OI, Funding (ETAPA 3)
app.get('/api/gauge/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const [oiHist, takerRatio, premiumData, oiData] = await Promise.all([
      fut.openInterestHist(symbol, '5m', 5).catch(() => []),
      fut.takerBuySellRatio(symbol, '5m', 5).catch(() => []),
      fut.precoMarca(symbol).catch(() => null),
      fut.openInterest(symbol).catch(() => null)
    ]);

    let deltaOI = 0;
    if (oiHist && oiHist.length >= 2) {
      const lastOI = parseFloat(oiHist[oiHist.length - 1].sumOpenInterest);
      const prevOI = parseFloat(oiHist[0].sumOpenInterest);
      if (prevOI > 0) deltaOI = ((lastOI - prevOI) / prevOI) * 100;
    }

    const takerRatioVal = (takerRatio && takerRatio.length > 0) ? parseFloat(takerRatio[takerRatio.length - 1].buySellRatio) : 1.0;
    const fundingRate = parseFloat(premiumData?.lastFundingRate || 0);
    const oiVal = parseFloat(oiData?.openInterest || 0);

    res.json({
      success: true,
      symbol,
      deltaOI,
      takerRatio: takerRatioVal,
      fundingRate,
      openInterest: oiVal
    });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

// Auxílio de IA sob Demanda no Botão Manual (ETAPA 6)
app.get('/api/ia-advise/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const dados = await analisarEstruturaEMercado(symbol);
    if (!dados) return res.json({ success: false, error: 'Dados insuficientes' });

    const dec = await consultarGeminiQuant(symbol, dados);
    res.json({
      success: true,
      symbol,
      decisao: dec.action,
      confianca: dec.confidence,
      alavancagem: dec.leverage || dados.leverageSugerida,
      slPrice: dados.slPrice,
      tpPrice: dados.tpPrice,
      beTriggerPrice: dados.beTriggerPrice,
      motivo: dec.reason_short
    });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// Execução Manual de Trade
app.post('/api/trade', async (req, res) => {
  try {
    const { symbol, lado, valorUSDT, alavancagem } = req.body;
    const alav = Math.min(5, Math.max(1, parseInt(alavancagem) || 1));
    await fut.garantirAlavancagem(symbol, alav, 'ISOLATED');

    const book = await fut.livroOfertas(symbol, 5);
    const preco = parseFloat(lado === 'BUY' ? (book.asks[0] || [])[0] : (book.bids[0] || [])[0]);
    if (!preco) throw new Error('Livro vazio');

    const calc = fut.calcularQuantidade(symbol, parseFloat(valorUSDT), preco, alav);
    if (!calc.ok) throw new Error(calc.motivo);

    let ord = await fut.colocarLimite(symbol, lado, calc.qty, preco);
    await new Promise(r => setTimeout(r, 1200));
    try { await fut.cancelarOrdem(symbol, ord.orderId); } catch(e){}
    let st = await fut.consultarOrdem(symbol, ord.orderId);
    let fill = parseFloat(st.executedQty) || 0;

    if (fill === 0) {
      const book2 = await fut.livroOfertas(symbol, 5);
      const preco2 = parseFloat(lado === 'BUY' ? (book2.asks[0] || [])[0] : (book2.bids[0] || [])[0]);
      if (preco2 && Math.abs(preco2 - preco) / preco <= 0.003) {
        let ord2 = await fut.colocarLimite(symbol, lado, calc.qty, preco2);
        await new Promise(r => setTimeout(r, 1200));
        try { await fut.cancelarOrdem(symbol, ord2.orderId); } catch(e){}
        st = await fut.consultarOrdem(symbol, ord2.orderId);
        fill = parseFloat(st.executedQty) || 0;
      }
    }

    if (fill > 0) {
      const dados = await analisarEstruturaEMercado(symbol);
      let slDistMan = dados ? (dados.slPctReal / 100 * preco) : (preco * ((6.0 / alav) / 100));
      let slRoeMan = (slDistMan / preco) * alav * 100;
      if (slRoeMan < 6.0) {
        slRoeMan = 6.0;
        slDistMan = preco * ((6.0 / alav) / 100);
      } else if (slRoeMan > 12.0) {
        slRoeMan = 12.0;
        slDistMan = preco * ((12.0 / alav) / 100);
      }
      let slCalc = lado === 'BUY' ? (preco - slDistMan) : (preco + slDistMan);

      let tpDistMan = (dados && dados.modoDetectado === 'EXAUSTAO_REVERSAO' && dados.tpPrice)
        ? Math.abs(preco - dados.tpPrice)
        : 2.0 * slDistMan;
      let tpRoeMan = (tpDistMan / preco) * alav * 100;
      if (tpRoeMan > 10.0) {
        tpDistMan = preco * (0.10 / alav);
      }
      let tpCalc = lado === 'BUY' ? (preco + tpDistMan) : (preco - tpDistMan);

      const beTriggerDist = preco * ((0.80 / alav) / 100);
      const beTriggerPrice = lado === 'BUY' ? (preco + beTriggerDist) : (preco - beTriggerDist);

      localAlvos[symbol] = {
        side: lado === 'BUY' ? 'LONG' : 'SHORT',
        entryPrice: preco,
        slPrice: slCalc,
        tpPrice: tpCalc,
        beTriggerPrice: beTriggerPrice,
        slDistPct: (slDistMan / preco),
        beArmed: false,
        beStage: 0,
        beStopPrice: null,
        beLabel: '',
        lockedRoi: 0,
        leverage: alav,
        maxRoiReached: 0
      };
      salvarAlvos();
      res.json({ success: true, result: st });
    } else {
      res.json({ success: false, error: 'A ordem limite não pegou (derrapagem > 0.3%).' });
    }
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

app.post('/api/close', async (req, res) => {
  try {
    const { symbol } = req.body;
    const pos = await fut.posicao(symbol);
    if (!pos || pos.quantidade === 0) throw new Error('Nenhuma posição aberta.');
    await fut.cancelarTodasOrdens(symbol);
    const r = await fut.fecharMercado(symbol, pos.lado, pos.quantidade);

    const margem = pos.margem || ((pos.quantidade * pos.precoEntrada) / (pos.alavancagem || 1));
    const roi = margem > 0 ? (pos.pnlNaoRealizado / margem) * 100 : 0;
    registrarDesfechoTrade(symbol, 'MANUAL_CLOSE', roi, pos.pnlNaoRealizado);

    await rag.salvarSaidaRAG({
      symbol,
      exitPrice: pos.precoMarca || pos.precoEntrada,
      exitReason: 'MANUAL_CLOSE',
      roiPct: roi,
      pnlUsdt: pos.pnlNaoRealizado
    }).catch(() => {});

    delete localAlvos[symbol];
    delete maxPriceTracker[symbol];
    delete minPriceTracker[symbol];
    salvarAlvos();
    res.json({ success: true, result: r });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

app.post('/api/tp-sl', async (req, res) => {
  try {
    const { symbol, tpPct, slPct } = req.body;
    const pos = await fut.posicao(symbol);
    if (!pos || pos.quantidade === 0) throw new Error('Nenhuma posição aberta.');
    await fut.cancelarTodasOrdens(symbol);
    localAlvos[symbol] = {
      tp: parseFloat(tpPct) || null,
      sl: parseFloat(slPct) || null
    };
    salvarAlvos();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/reverse', async (req, res) => {
  try {
    const { symbol } = req.body;
    const pos = await fut.posicao(symbol);
    if (!pos || pos.quantidade === 0) throw new Error('Nenhuma posição para reverter.');
    const origSide = pos.lado;
    const oppSide = origSide === 'LONG' ? 'SELL' : 'BUY';
    const qty = pos.quantidade;
    const alav = pos.alavancagem || 1;
    await fut.cancelarTodasOrdens(symbol);
    await fut.fecharMercado(symbol, origSide, qty);
    await new Promise(r => setTimeout(r, 600));
    const r2 = await fut.abrirMercado(symbol, oppSide, qty);
    res.json({ success: true, result: r2 });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

app.get('/api/auto-status', (req, res) => {
  res.json({
    success: true,
    enabled: autoBotState.enabled,
    slots: autoBotState.slots,
    lastLog: autoBotState.lastLog,
    tokensGastos: tokensGastos.total_tokens || 0,
    placar: {
      wins: placarStats.wins || 0,
      losses: placarStats.losses || 0,
      total: (placarStats.wins || 0) + (placarStats.losses || 0)
    }
  });
});

app.post('/api/auto-trade', async (req, res) => {
  try {
    const { enabled } = req.body;
    autoBotState.enabled = !!enabled;
    salvarAutoBotConfig();
    res.json({ success: true, enabled: autoBotState.enabled });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/rag-stats', async (req, res) => {
  try {
    const stats = await rag.obterEstatisticasRAG();
    res.json({ success: true, stats });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/win-loss', (req, res) => {
  res.json({
    success: true,
    wins: placarStats.wins || 0,
    losses: placarStats.losses || 0,
    total: (placarStats.wins || 0) + (placarStats.losses || 0)
  });
});

app.post('/api/limpar-placar', (req, res) => {
  placarStats = { wins: 0, losses: 0, total: 0 };
  salvarPlacarStats();
  marcoZero = Date.now();
  try { fs.writeFileSync(MARCO_ZERO_FILE, marcoZero.toString()); } catch(e){}
  res.json({ success: true, wins: 0, losses: 0, total: 0 });
});

app.get('/api/historico-completo', async (req, res) => {
  try {
    const trades = await fut.userTradesCompleto();
    res.json({ success: true, count: trades.length, trades });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

app.get('/api/historico', async (req, res) => {
  try {
    const trades = await fut.userTrades();
    res.json({ success: true, trades: (trades || []).slice(0, 50) });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

// ── FRONTEND HTML / UI QUANT DARK (ETAPAS 2 e 3) ──────────────────────
  function renderColHTML(col) { return `
    <div class="card ${col === 1 ? 'active' : ''}" id="card-${col}" onclick="selecionarColuna(${col})">
      
      <!-- TOPO DO CARD: MOEDA INPUT, VARIAÇÃO 24H E MODO DINÂMICO ATIVO -->
      <div class="card-top-row">
        <div class="coin-input-group">
          <input type="text" id="sym-${col}" placeholder="MOEDA (EX: BTC)" oninput="debouncedLoad(${col})" autocomplete="off">
          <span class="pct-badge" id="pct-24h-${col}">--%</span>
        </div>
        <div class="modo-badge" id="modo-badge-${col}">[AGUARDANDO SETUP]</div>
      </div>

      <!-- PREÇO ATUAL GRANDE E DESTACADO -->
      <div class="price-display" id="price-${col}">$ 0.0000</div>
      
      <!-- TENDÊNCIA MULTI-TIMEFRAME (EMA 50) -->
      <div class="mtf-box">
        <div class="mtf-header">
          <span class="mtf-title">TENDÊNCIA MULTI-TIMEFRAME (EMA 50)</span>
          <span id="mtf-status-${col}" class="badge-mtf">CARREGANDO...</span>
        </div>
        <div class="candles-row" id="candles-${col}">
          ${['4h','1h','15m','5m'].map(tf => `
            <div class="candle">
              <span class="candle-label">${tf}</span>
              <div class="dot" id="dot-${col}-${tf}"></div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- CORPO DO CARD: ESTRUTURA & FLUXO INSTITUCIONAL (5M / 15M) -->
      <div class="flow-panel">
        <div class="flow-title">ESTRUTURA & FLUXO INSTITUCIONAL</div>
        
        <div class="flow-grid">
          <div class="flow-cell">
            <span class="cell-label">Alinhamento EMAs:</span>
            <span class="cell-val" id="ema-align-${col}">--</span>
          </div>
          <div class="flow-cell">
            <span class="cell-label">Distância EMA 21:</span>
            <span class="cell-val" id="dist-ema-${col}">--</span>
          </div>
          <div class="flow-cell">
            <span class="cell-label">ATR (14) 15m:</span>
            <span class="cell-val text-gold" id="atr-pct-${col}">--</span>
          </div>
          <div class="flow-cell">
            <span class="cell-label">ADX / RVOL:</span>
            <span class="cell-val" id="adx-rvol-${col}">--</span>
          </div>
          <div class="flow-cell">
            <span class="cell-label">RSI (15m Wilder):</span>
            <span class="cell-val" id="rsi-${col}" style="font-size:1.15rem; font-weight:800;">--</span>
          </div>
          <div class="flow-cell">
            <span class="cell-label">Taker Ratio:</span>
            <span class="cell-val" id="gauge-taker-${col}">--</span>
          </div>
          <div class="flow-cell">
            <span class="cell-label">Δ OI (15m):</span>
            <span class="cell-val" id="gauge-delta-oi-${col}">--</span>
          </div>
          <div class="flow-cell">
            <span class="cell-label">Funding Rate:</span>
            <span class="cell-val" id="gauge-fund-${col}">--</span>
          </div>
        </div>

        <div class="compass-row">
          <span class="compass-label">Bússola Quant (-100 a +100):</span>
          <span class="compass-val" id="trend-${col}">--</span>
        </div>
      </div>

      <!-- POSIÇÃO ABERTA (ALTO DESTAQUE VISUAL COM GLOW) -->
      <div class="pos-card" id="pos-${col}">
        <div class="pos-header">
          <div id="pos-lado-${col}" class="pos-side-pill">--</div>
          <span id="pos-qty-${col}" class="pos-qty">Qty: --</span>
        </div>
        <div id="pos-be-status-${col}" class="pos-be-banner" style="display:none;"></div>
        <div class="pos-pnl" id="pos-pnl-${col}">$ 0.00 (0.00%)</div>
        <div class="pos-pnl-brl" id="pos-pnl-brl-${col}">R$ 0,00</div>
        <div class="pos-entry-row">Preço Entrada: <b id="pos-entry-${col}" style="color:#FFF;">--</b></div>
        <div class="pos-actions-row">
          <button class="btn-close" onclick="fecharPosicao(${col})">FECHAR MERCADO</button>
          <button class="btn-reverse" onclick="reverterPosicao(${col})">REVERTER</button>
        </div>
      </div>

      <!-- RODAPÉ: BLOCO DE RISCO QUANTITATIVO BEM DIMENSIONADO -->
      <div class="risk-card">
        <div class="risk-meta-row">
          <span>Alav Sugerida: <b id="proj-alav-${col}" style="color:var(--gold);">--x</b></span>
          <span>Entrada Projetada: <b id="proj-entry-${col}" style="color:#FFF;">$--</b></span>
        </div>

        <div class="range-group">
          <label>Alavancagem Manual</label>
          <input type="range" id="alav-${col}" min="1" max="5" value="3" oninput="document.getElementById('alav-val-${col}').innerText = this.value + 'x'">
          <span id="alav-val-${col}">3x</span>
        </div>
        
        <div class="input-group" style="margin-bottom: 14px;">
          <input type="number" id="val-${col}" placeholder="Tamanho (USDT)" value="10" style="font-size:1.05rem; padding:12px;">
        </div>

        <!-- TARGETS EM 3 BOXES BEM DISTRIBUÍDAS -->
        <div class="targets-grid">
          <div class="target-box target-sl">
            <div class="target-title">STOP LOSS (1.8x ATR)</div>
            <div class="target-val" id="proj-sl-${col}">--</div>
          </div>
          <div class="target-box target-be">
            <div class="target-title">BREAKEVEN (+0.25%)</div>
            <div class="target-val" id="proj-be-${col}">--</div>
          </div>
          <div class="target-box target-tp">
            <div class="target-title">TAKE PROFIT (1:2 R:R)</div>
            <div class="target-val" id="proj-tp-${col}">--</div>
          </div>
        </div>
      </div>

      <!-- BOTÕES DE AÇÃO -->
      <div class="actions">
        <button class="btn-buy" onclick="execTrade(${col}, 'BUY')">COMPRAR (LONG)</button>
        <button class="btn-sell" onclick="execTrade(${col}, 'SELL')">VENDER (SHORT)</button>
      </div>

      <button onclick="consultarIaManual(${col})" class="btn-ia-advise">
        ⚡ AUXÍLIO DE IA (GEMINI FLASH)
      </button>

      <div class="status" id="status-${col}">Pronto</div>
    </div>
  `;
}

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Futuros Quant Institucional - Binance</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22 fill=%22%23D4AF37%22>$</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    :root {
      --bg: #070a13;
      --card-bg: #0d111c;
      --card-border: rgba(255, 255, 255, 0.10);
      --border: rgba(255, 255, 255, 0.08);
      --text: #F8FAFC;
      --text-muted: #94A3B8;
      --green: #10B981;
      --red: #EF4444;
      --blue: #38BDF8;
      --gold: #D4AF37;
      --purple: #A78BFA;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
    body { background-color: var(--bg); color: var(--text); padding: 14px; min-height: 100vh; }
    .container { max-width: 1280px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    
    /* PAINEL DE RESUMO DE DESEMPENHO NO TOPO */
    .perf-header-bar {
      background: linear-gradient(180deg, rgba(16,21,35,0.95) 0%, rgba(10,13,23,0.98) 100%);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 16px 22px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      box-shadow: 0 4px 25px rgba(0,0,0,0.45);
    }
    .header-stat-group { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
    .stat-box { display: flex; flex-direction: column; gap: 4px; }
    .stat-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 700; }
    .stat-value-gold { font-size: 1.55rem; font-weight: 900; color: var(--gold); letter-spacing: 0.5px; }
    .stat-sub { font-size: 0.85rem; color: var(--blue); font-weight: 700; }

    /* PLACAR DE TRADES INSTITUCIONAL COM WIN RATE */
    .placar-box {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(0,0,0,0.45);
      border: 1px solid var(--border);
      padding: 8px 16px;
      border-radius: 12px;
    }
    .badge-win { font-size: 1rem; font-weight: 800; color: var(--green); background: rgba(16,185,129,0.2); border: 1px solid rgba(16,185,129,0.4); padding: 4px 10px; border-radius: 6px; }
    .badge-loss { font-size: 1rem; font-weight: 800; color: var(--red); background: rgba(239,68,68,0.2); border: 1px solid rgba(239,68,68,0.4); padding: 4px 10px; border-radius: 6px; }
    .badge-wr { font-size: 0.8rem; font-weight: 800; color: var(--gold); background: rgba(212,175,55,0.18); border: 1px solid rgba(212,175,55,0.35); padding: 4px 10px; border-radius: 6px; }
    .btn-zerar { padding: 4px 10px; font-size: 0.72rem; background: rgba(255,255,255,0.08); border: 1px solid var(--border); color: var(--text-muted); border-radius: 6px; cursor: pointer; font-weight: 800; transition: 0.2s; }
    .btn-zerar:hover { background: rgba(255,255,255,0.16); color: #FFF; }

    .header-btns { display: flex; gap: 10px; }
    .header-btns button { padding: 10px 16px; font-size: 0.85rem; background: rgba(255,255,255,0.06); border: 1px solid var(--border); color: var(--text); border-radius: 10px; cursor: pointer; font-weight: 700; transition: 0.2s; }
    .header-btns button:hover { background: rgba(255,255,255,0.14); border-color: rgba(255,255,255,0.25); }

    /* CARROSSEL SUPERIOR DE MOEDAS */
    .volatility-bar { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; scrollbar-width: thin; scrollbar-color: var(--gold) rgba(0,0,0,0.3); }
    .volatility-bar::-webkit-scrollbar { height: 5px; }
    .volatility-bar::-webkit-scrollbar-thumb { background: var(--gold); border-radius: 4px; }
    .vol-item { flex-shrink: 0; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; background: rgba(13,17,28,0.9); border: 1px solid var(--border); border-radius: 10px; padding: 8px 14px; font-size: 0.85rem; cursor: pointer; transition: 0.2s; font-weight: 800; }
    .vol-item:hover { border-color: var(--gold); background: rgba(212, 175, 55, 0.15); transform: translateY(-1px); }
    .vol-item .sym { color: var(--text); }
    .vol-item .pct { font-weight: 900; }

    /* BARRA DE CONTROLE DO ROBÔ AUTÔNOMO */
    .bot-control-bar {
      background: linear-gradient(180deg, rgba(13,17,28,0.95) 0%, rgba(9,12,20,0.98) 100%);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 14px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .bot-control-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }

    /* GRELHA DOS CARTÕES (1 E 2) */
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .card {
      background: linear-gradient(180deg, #0e121e 0%, #080b14 100%);
      border: 1px solid var(--card-border);
      border-radius: 18px;
      padding: 20px;
      transition: all 0.3s;
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 14px;
      box-shadow: 0 4px 25px rgba(0,0,0,0.4);
    }
    .card.active { border-color: rgba(212, 175, 55, 0.55); box-shadow: 0 0 25px rgba(212, 175, 55, 0.1); }

    /* CARD HEADER */
    .card-top-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .coin-input-group { display: flex; align-items: center; gap: 8px; flex: 1; max-width: 270px; }
    .coin-input-group input {
      width: 100%;
      background: rgba(0,0,0,0.45);
      border: 1px solid var(--border);
      color: var(--gold);
      font-size: 1.2rem;
      padding: 10px 14px;
      border-radius: 10px;
      outline: none;
      text-transform: uppercase;
      font-weight: 900;
      letter-spacing: 1px;
    }
    .coin-input-group input:focus { border-color: var(--gold); box-shadow: 0 0 12px rgba(212,175,55,0.25); }
    .pct-badge { font-size: 0.85rem; font-weight: 800; padding: 5px 10px; border-radius: 8px; background: rgba(255,255,255,0.06); border: 1px solid var(--border); }

    .modo-badge {
      font-size: 0.85rem;
      font-weight: 800;
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.05);
      color: var(--text-muted);
      letter-spacing: 0.5px;
      text-align: right;
    }

    /* PREÇO */
    .price-display { font-size: 2rem; text-align: center; font-weight: 900; color: var(--text); letter-spacing: 1px; margin: 4px 0; }

    /* MTF BOX */
    .mtf-box { background: rgba(0,0,0,0.35); border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px; }
    .mtf-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .mtf-title { font-size: 0.75rem; color: var(--text-muted); font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
    .badge-mtf { font-size: 0.78rem; font-weight: 800; padding: 4px 10px; border-radius: 6px; background: rgba(255,255,255,0.08); color: var(--gold); }
    .candles-row { display: flex; justify-content: space-around; background: rgba(0,0,0,0.25); border-radius: 10px; border: 1px solid var(--border); padding: 10px 14px; }
    .candle { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .candle-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 700; }
    .dot { width: 14px; height: 14px; border-radius: 50%; background: #334155; transition: 0.3s; }
    .dot.green { background: var(--green); box-shadow: 0 0 10px rgba(16, 185, 129, 0.7); }
    .dot.red { background: var(--red); box-shadow: 0 0 10px rgba(239, 68, 68, 0.7); }

    /* ESTRUTURA & FLUXO INSTITUCIONAL */
    .flow-panel { background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: 14px; padding: 14px 18px; font-size: 0.9rem; }
    .flow-title { font-size: 0.75rem; color: var(--gold); font-weight: 800; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 1px solid rgba(212,175,55,0.25); padding-bottom: 6px; }
    .flow-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 20px; margin-bottom: 12px; }
    .flow-cell { display: flex; justify-content: space-between; align-items: center; }
    .cell-label { color: var(--text-muted); font-size: 0.85rem; font-weight: 600; }
    .cell-val { font-weight: 700; color: #FFF; font-size: 0.9rem; }
    .text-gold { color: var(--gold) !important; }

    .compass-row { display: flex; justify-content: space-between; align-items: center; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px; }
    .compass-label { font-size: 0.82rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; }
    .compass-val { font-size: 1rem; font-weight: 800; }

    /* POSIÇÃO ABERTA COM DESTAQUE MÁXIMO */
    .pos-card { border-radius: 14px; padding: 16px; display: none; transition: all 0.3s; }
    .pos-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .pos-side-pill { font-weight: 900; font-size: 1.1rem; padding: 4px 12px; border-radius: 8px; }
    .badge-long { background: rgba(16,185,129,0.25); color: var(--green); border: 1px solid var(--green); }
    .badge-short { background: rgba(239,68,68,0.25); color: var(--red); border: 1px solid var(--red); }
    .pos-qty { color: var(--text-muted); font-size: 0.9rem; font-weight: 700; }
    .pos-be-banner { background: rgba(56, 189, 248, 0.18); border: 1px solid var(--blue); color: var(--blue); border-radius: 8px; padding: 6px 12px; font-weight: 800; font-size: 0.8rem; text-align: center; margin-bottom: 10px; }
    @keyframes pulse-alert {
      0% { opacity: 1; transform: scale(1); box-shadow: 0 0 8px rgba(212, 175, 55, 0.4); }
      50% { opacity: 0.8; transform: scale(1.02); box-shadow: 0 0 18px rgba(212, 175, 55, 0.85); }
      100% { opacity: 1; transform: scale(1); box-shadow: 0 0 8px rgba(212, 175, 55, 0.4); }
    }
    .pos-alert-banner { animation: pulse-alert 1.2s infinite ease-in-out; }
    .pos-pnl { font-size: 2.2rem; font-weight: 900; text-align: center; margin: 6px 0; letter-spacing: 0.5px; }
    .pos-pnl-brl { font-size: 1.1rem; font-weight: 800; text-align: center; margin-bottom: 10px; }
    .pos-entry-row { font-size: 0.9rem; color: var(--text-muted); text-align: center; margin-bottom: 14px; }
    .pos-actions-row { display: flex; gap: 10px; }

    /* BLOCO DE RISCO QUANTITATIVO BEM DIMENSIONADO */
    .risk-card { background: rgba(0,0,0,0.45); border: 1px solid var(--card-border); border-radius: 14px; padding: 16px 18px; }
    .risk-meta-row { display: flex; justify-content: space-between; color: var(--text-muted); font-size: 0.85rem; margin-bottom: 12px; font-weight: 700; }
    .range-group { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; background: rgba(0,0,0,0.3); padding: 10px 14px; border-radius: 10px; border: 1px solid var(--border); }
    .range-group label { flex: 1; font-size: 0.78rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700; }
    .range-group input[type="range"] { flex: 2; accent-color: var(--gold); }
    .range-group span { font-size: 1.05rem; color: var(--gold); font-weight: 800; width: 40px; text-align: right; }

    .input-group input { width: 100%; background: rgba(0,0,0,0.35); border: 1px solid var(--border); color: var(--gold); font-size: 1.1rem; padding: 12px; border-radius: 10px; outline: none; text-align: center; font-weight: 800; }

    .targets-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
    .target-box { padding: 10px; border-radius: 10px; text-align: center; font-family: monospace; }
    .target-title { font-size: 0.68rem; font-weight: 800; text-transform: uppercase; margin-bottom: 5px; letter-spacing: 0.5px; }
    .target-val { font-size: 0.88rem; font-weight: 900; }
    .target-sl { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: var(--red); }
    .target-be { background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.35); color: var(--blue); }
    .target-tp { background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); color: var(--green); }

    /* BOTÕES */
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button { padding: 14px; border: none; border-radius: 10px; font-size: 0.85rem; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: white; cursor: pointer; transition: 0.2s; outline: none; }
    button:active { transform: scale(0.97); }
    .btn-buy { background: linear-gradient(135deg, #059669 0%, #10B981 100%); box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3); }
    .btn-sell { background: linear-gradient(135deg, #DC2626 0%, #EF4444 100%); box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3); }
    .btn-close { background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%); }
    .btn-reverse { background: linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%); }
    .btn-ia-advise { width: 100%; padding: 13px; background: rgba(212,175,55,0.15); border: 1px solid var(--gold); color: var(--gold); border-radius: 10px; font-size: 0.82rem; font-weight: 800; cursor: pointer; transition: 0.2s; }
    .btn-ia-advise:hover { background: rgba(212,175,55,0.25); }

    .status { text-align: center; font-size: 0.85rem; color: var(--text-muted); min-height: 1.4rem; font-weight: 600; }

    /* MODAL HISTÓRICO COM VISUAL INSTITUCIONAL */
    .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.88); backdrop-filter: blur(8px); display: none; justify-content: center; align-items: center; z-index: 999; }
    .modal { background: #0c0f1d; border: 1px solid var(--card-border); border-radius: 20px; width: 92%; max-width: 720px; max-height: 85vh; overflow-y: auto; padding: 24px; box-shadow: 0 8px 35px rgba(0,0,0,0.6); }
    .modal-head { display: flex; justify-content: space-between; margin-bottom: 18px; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 12px; }

    .hist-summary-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .hist-stat-card { background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 12px; padding: 14px; text-align: center; }
    .hist-stat-title { font-size: 0.72rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
    .hist-stat-val { font-size: 1.35rem; font-weight: 900; }
    .hist-stat-count { font-size: 0.85rem; color: var(--text-muted); font-weight: 600; }

    .trade-card-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255,255,255,0.025);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 16px;
      margin-bottom: 10px;
      transition: 0.2s;
    }
    .trade-card-row:hover { background: rgba(255,255,255,0.05); }
    .trade-left { display: flex; flex-direction: column; gap: 4px; }
    .trade-sym-row { display: flex; align-items: center; gap: 8px; }
    .trade-sym { font-weight: 800; color: #FFF; font-size: 0.95rem; }
    .trade-side-pill { font-size: 0.7rem; font-weight: 800; padding: 2px 7px; border-radius: 4px; }
    .pill-buy { background: rgba(16,185,129,0.2); color: var(--green); }
    .pill-sell { background: rgba(239,68,68,0.2); color: var(--red); }
    .trade-tag-pill { font-size: 0.7rem; font-weight: 800; padding: 2px 7px; border-radius: 4px; }
    .trade-date { font-size: 0.72rem; color: var(--text-muted); }
    .trade-right { text-align: right; display: flex; flex-direction: column; gap: 2px; }
    .trade-pnl { font-size: 1.15rem; font-weight: 900; }
    .trade-fee { font-size: 0.72rem; color: var(--text-muted); }

    @media (max-width: 820px) {
      .grid { grid-template-columns: 1fr; }
      .perf-header-bar { flex-direction: column; text-align: center; }
      .header-stat-group { justify-content: center; }
      .hist-summary-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <!-- MODAL DE CONFIRMAÇÃO ESTÉTICO -->
  <div class="modal-overlay" id="modal-confirm">
    <div class="modal" style="max-width: 440px; text-align: center;">
      <h3 id="modal-confirm-title" style="color: var(--gold); margin-bottom: 15px; font-size: 1.3rem;">Confirmação</h3>
      <div id="modal-confirm-body" style="color: var(--text); font-size: 0.95rem; margin-bottom: 25px; line-height: 1.5;"></div>
      <div style="display: flex; gap: 12px; justify-content: center;" id="modal-confirm-actions">
        <button id="modal-btn-cancel" style="flex: 1; padding: 12px; background: rgba(255,255,255,0.1); color: var(--text); border: 1px solid var(--border); border-radius: 8px; font-weight: bold; cursor: pointer;">CANCELAR</button>
        <button id="modal-btn-ok" style="flex: 1; padding: 12px; background: var(--gold); color: #000; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">CONFIRMAR</button>
      </div>
    </div>
  </div>

  <!-- MODAL DE HISTÓRICO -->
  <div class="modal-overlay" id="modal-hist">
    <div class="modal">
      <div class="modal-head">
        <h3 style="color: var(--gold); font-size: 1.25rem;">Histórico Institucional de Ordens</h3>
        <button onclick="fecharHistorico()" style="background:transparent; border:none; color:var(--text-muted); font-size:1.5rem; cursor:pointer;">&times;</button>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
        <div style="display:flex; gap:8px;">
          <button id="btn-tab-periodo" onclick="mudarAbaHist('periodo')" style="padding:8px 16px; font-size:0.8rem; background:var(--gold); color:#000; border-radius:8px; font-weight:800; cursor:pointer;">Agrupado</button>
          <button id="btn-tab-hoje" onclick="mudarAbaHist('hoje')" style="padding:8px 16px; font-size:0.8rem; background:rgba(255,255,255,0.08); color:var(--text); border-radius:8px; cursor:pointer; font-weight:700;">Hoje</button>
          <button id="btn-tab-todas" onclick="mudarAbaHist('todas')" style="padding:8px 16px; font-size:0.8rem; background:rgba(255,255,255,0.08); color:var(--text); border-radius:8px; cursor:pointer; font-weight:700;">Todas</button>
        </div>
      </div>
      <div id="hist-content">Carregando...</div>
    </div>
  </div>

  <div class="container">
    
    <!-- PAINEL DE RESUMO DE DESEMPENHO INSTITUCIONAL -->
    <div class="perf-header-bar">
      <div class="header-stat-group">
        <div class="stat-box">
          <span class="stat-label">Saldo Futuros (Testnet)</span>
          <div style="display:flex; align-items:baseline; gap:6px; flex-wrap:wrap;">
            <span class="stat-value-gold" id="saldo-total">$ 0.00</span>
            <span id="pnl-usdt" style="font-size:0.85rem; font-weight:800; font-family:monospace; color:var(--text-muted);">(0.00%)</span>
          </div>
          <span class="stat-sub" id="saldo-brl">R$ 0,00</span>
        </div>

        <!-- PLACAR DE ACERTOS / ERROS COM WIN RATE REAL -->
        <div class="placar-box">
          <span class="stat-label" style="margin-right:4px;">Trades:</span>
          <span class="badge-win" id="placar-wins">0 W</span>
          <span style="color:var(--text-muted); font-weight:bold;">/</span>
          <span class="badge-loss" id="placar-losses">0 L</span>
          <span class="badge-wr" id="placar-wr">0% WR</span>
          <button class="btn-zerar" onclick="zerarPlacar()" title="Zerar contadores">ZERAR</button>
        </div>

        <div class="stat-box">
          <span class="stat-label">Tokens Gastos</span>
          <span style="font-size:1.25rem; font-weight:900; color:var(--purple);" id="total-tokens-val">0</span>
        </div>
      </div>

      <div class="header-btns">
        <button onclick="carregarSaldo()">Atualizar</button>
        <button onclick="abrirHistorico()">Histórico</button>
        <button onclick="fazerLogout()">Sair</button>
      </div>
    </div>

    <!-- CARROSSEL SUPERIOR DE MOEDAS VOLÁTEIS -->
    <div class="volatility-bar" id="vol-bar"></div>

    <!-- BARRA DE CONTROLE DO ROBÔ AUTÔNOMO -->
    <div class="bot-control-bar">
      <div class="bot-control-top">
        <div style="display:flex; align-items:center; gap:12px;">
          <button id="btn-auto-toggle" onclick="toggleAutoBot()" style="padding:10px 18px; font-size:0.85rem; border-radius:10px; border:1px solid var(--green); background:rgba(16, 185, 129, 0.2); color:var(--green); cursor:pointer; font-weight:900;">
            LIGAR ROBÔ IA
          </button>
          <span id="auto-status-text" style="font-size:0.9rem; color:var(--text-muted); font-weight:bold;">Robô Desligado</span>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="font-size:0.8rem; color:var(--text-muted);">Memória RAG:</span>
          <span id="auto-rag-badge" style="font-size:0.8rem; color:var(--gold); font-weight:bold; background:rgba(212, 175, 55, 0.15); border:1px solid rgba(212, 175, 55, 0.35); padding:4px 12px; border-radius:8px;">0 trades</span>
        </div>
      </div>
      <div style="font-size:0.8rem; color:var(--text-muted); font-family:monospace; background:rgba(0,0,0,0.3); padding:9px 14px; border-radius:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border:1px solid var(--border);" id="auto-log-text">
        Nenhum evento registrado.
      </div>
    </div>

    <!-- GRELHA DOS CARTÕES (1 E 2) -->
    <div class="grid">
      ${renderColHTML(1)}
      ${renderColHTML(2)}
    </div>

  </div>

  <script>
    let colunaAtiva = 1;
    let timers = {}, autoRefresh = {};
    let saldoGlobal = 0, brlGlobal = 5.20;

    function selecionarColuna(c) {
      colunaAtiva = c;
      document.getElementById('card-1').classList.toggle('active', c === 1);
      document.getElementById('card-2').classList.toggle('active', c === 2);
    }

    function askConfirm(title, message, isAlert = false) {
      return new Promise((resolve) => {
        const modal = document.getElementById('modal-confirm');
        document.getElementById('modal-confirm-title').innerText = title;
        document.getElementById('modal-confirm-body').innerHTML = message;
        const btnCancel = document.getElementById('modal-btn-cancel');
        const btnOk = document.getElementById('modal-btn-ok');

        if (isAlert) {
          btnCancel.style.display = 'none';
          btnOk.innerText = 'OK';
        } else {
          btnCancel.style.display = 'block';
          btnOk.innerText = 'CONFIRMAR';
        }

        const handleOk = () => { cleanup(); resolve(true); };
        const handleCancel = () => { cleanup(); resolve(false); };
        const cleanup = () => {
          btnOk.removeEventListener('click', handleOk);
          btnCancel.removeEventListener('click', handleCancel);
          modal.style.display = 'none';
        };

        btnOk.addEventListener('click', handleOk);
        btnCancel.addEventListener('click', handleCancel);
        modal.style.display = 'flex';
      });
    }

    async function carregarSaldo() {
      try {
        const res = await fetch('/api/saldo');
        const data = await res.json();
        if (data.success) {
          saldoGlobal = typeof data.saldo === 'number' ? data.saldo : (data.saldo?.total || 0);
          brlGlobal = data.brl || 5.20;
          document.getElementById('saldo-total').innerText = '$ ' + saldoGlobal.toFixed(2);
          document.getElementById('saldo-brl').innerText = 'R$ ' + (saldoGlobal * brlGlobal).toFixed(2);

          const pnl = parseFloat(data.pnlHoje) || 0;
          const saldoInicial = saldoGlobal - pnl;
          let pct = 0;
          if (saldoInicial > 0) pct = (pnl / saldoInicial) * 100;
          const pnlEl = document.getElementById('pnl-usdt');
          if (pnlEl) {
            if (Math.abs(pnl) < 0.0001) {
              pnlEl.innerText = '(0.00%)';
              pnlEl.style.color = 'var(--text-muted)';
            } else {
              const sinal = pnl > 0 ? '+' : '';
              pnlEl.innerText = '(' + sinal + pct.toFixed(2) + '% | ' + (pnl >= 0 ? '+' : '-') + '$ ' + Math.abs(pnl).toFixed(2) + ')';
              pnlEl.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
            }
          }
        }
      } catch (e) {}
    }

    async function carregarVolateis() {
      try {
        const r = await fetch('/api/volateis');
        const d = await r.json();
        if (d.success && d.data) {
          let html = '';
          d.data.forEach(item => {
            const pct = parseFloat(item.priceChangePercent);
            const cor = pct >= 0 ? 'var(--green)' : 'var(--red)';
            const sinal = pct >= 0 ? '+' : '';
            html += '<div class="vol-item" data-sym="' + item.symbol + '" onclick="aplicarMoeda(this.dataset.sym)">' +
              '<span class="sym">' + item.symbol.replace('USDT','') + '</span>' +
              '<span class="pct" style="color:' + cor + ';">' + sinal + pct.toFixed(1) + '%</span>' +
            '</div>';
          });
          document.getElementById('vol-bar').innerHTML = html;
        }
      } catch(e) {}
    }

    function aplicarMoeda(sym) {
      document.getElementById('sym-' + colunaAtiva).value = sym;
      debouncedLoad(colunaAtiva);
    }

    function debouncedLoad(col) {
      clearTimeout(timers[col]);
      clearInterval(autoRefresh[col]);
      document.getElementById('status-' + col).innerText = "Carregando MTF...";
      document.getElementById('status-' + col).style.color = "var(--gold)";
      timers[col] = setTimeout(() => {
        loadData(col);
        atualizarGauge(col);
        autoRefresh[col] = setInterval(() => {
          loadData(col);
          atualizarGauge(col);
        }, 5000);
      }, 600);
    }

    async function loadData(col) {
      let sym = document.getElementById('sym-' + col).value.trim().toUpperCase();
      if (!sym) return;
      if (!sym.endsWith('USDT')) sym += 'USDT';
      localStorage.setItem('sym-' + col, sym);

      try {
        const res = await fetch('/api/moeda/' + sym);
        const data = await res.json();
        if (!data.success) {
          document.getElementById('status-' + col).innerText = data.error || "Erro";
          document.getElementById('status-' + col).style.color = "var(--red)";
          return;
        }

        document.getElementById('status-' + col).innerText = "Sincronizado MTF";
        document.getElementById('status-' + col).style.color = "var(--green)";
        document.getElementById('price-' + col).innerText = "$ " + parseFloat(data.preco).toFixed(4);

        // Variação 24h
        const pctEl = document.getElementById('pct-24h-' + col);
        if (pctEl) {
          const p24 = parseFloat(data.priceChangePercent || 0);
          const corP24 = p24 >= 0 ? 'var(--green)' : 'var(--red)';
          pctEl.innerText = (p24 >= 0 ? '+' : '') + p24.toFixed(1) + '%';
          pctEl.style.color = corP24;
          pctEl.style.borderColor = corP24;
        }

        // Atualiza Dots MTF (4h, 1h, 15m, 5m)
        ['4h','1h','15m','5m'].forEach(tf => {
          const dot = document.getElementById('dot-' + col + '-' + tf);
          if (dot) dot.className = "dot " + (data.intervals[tf] || "");
        });

        // Badge Alinhamento MTF
        const mtfBadge = document.getElementById('mtf-status-' + col);
        if (mtfBadge) {
          mtfBadge.innerText = data.mtfText || '--';
          mtfBadge.style.color = data.mtfStatus.startsWith('APTO') ? 'var(--green)' : 'var(--gold)';
        }

        // Painel Estrutura & Fluxo
        document.getElementById('ema-align-' + col).innerText = data.emaAlignStatus || '--';
        const distEl = document.getElementById('dist-ema-' + col);
        distEl.innerText = data.distEmaText || '--';
        distEl.style.color = data.distEmaColor || '#FFF';

        document.getElementById('atr-pct-' + col).innerText = (data.atrPct15m ? data.atrPct15m.toFixed(2) + '%' : '--') + (data.atr15m ? ' ($ ' + data.atr15m.toFixed(4) + ')' : '');
        document.getElementById('adx-rvol-' + col).innerText = 'ADX: ' + (data.adx15m ? data.adx15m.toFixed(1) : '--') + ' | RVOL: ' + (data.rvol15m ? data.rvol15m.toFixed(1) + 'x' : '--');

        // RSI 15m Wilder & Bússola Quant
        document.getElementById('rsi-' + col).innerText = data.rsi || '--';
        const trendEl = document.getElementById('trend-' + col);
        const scoreSign = (data.directionalScore > 0 ? '+' : '');
        let scoreColor = 'var(--text-muted)';
        let scoreTag = 'NEUTRO';
        if (data.directionalScore >= 55) { scoreColor = 'var(--green)'; scoreTag = 'COMPRA FORTE'; }
        else if (data.directionalScore <= -55) { scoreColor = 'var(--red)'; scoreTag = 'VENDA FORTE'; }
        else if (data.directionalScore > 20) { scoreColor = 'var(--green)'; scoreTag = 'COMPRA LEVE'; }
        else if (data.directionalScore < -20) { scoreColor = 'var(--red)'; scoreTag = 'VENDA LEVE'; }
        trendEl.innerHTML = '<span style="color:' + scoreColor + '; font-weight:800;">' + scoreSign + (data.directionalScore || 0) + ' [' + scoreTag + ']</span>';

        // Badge do Modo Ativo
        const modoBadge = document.getElementById('modo-badge-' + col);
        if (modoBadge) {
          if (data.modoDetectado) {
            let corModo = 'var(--gold)';
            if (data.modoDetectado === 'MOMENTUM') corModo = 'var(--blue)';
            else if (data.modoDetectado === 'PULLBACK') corModo = 'var(--green)';
            else if (data.modoDetectado === 'EXAUSTAO_REVERSAO') corModo = 'var(--red)';
            modoBadge.innerText = '[MODO: ' + data.modoLabel + ']';
            modoBadge.style.color = corModo;
            modoBadge.style.borderColor = corModo;
            modoBadge.style.background = 'rgba(255,255,255,0.06)';
          } else {
            modoBadge.innerText = '[SEM SETUP ATIVO]';
            modoBadge.style.color = 'var(--text-muted)';
            modoBadge.style.borderColor = 'var(--border)';
            modoBadge.style.background = 'transparent';
          }
        }

        // Projeção de Risco Quantitativo
        document.getElementById('proj-alav-' + col).innerText = (data.leverageSugerida || 3) + 'x';
        document.getElementById('proj-entry-' + col).innerText = '$ ' + parseFloat(data.preco).toFixed(4);
        document.getElementById('proj-sl-' + col).innerText = '$ ' + (data.slPrice ? data.slPrice.toFixed(4) : '--') + ' (-' + (data.slRoe ? data.slRoe.toFixed(1) : '--') + '%)';
        document.getElementById('proj-be-' + col).innerText = '$ ' + (data.beTriggerPrice ? data.beTriggerPrice.toFixed(4) : '--') + ' (+' + (data.beTriggerPctReal ? data.beTriggerPctReal.toFixed(2) : '--') + '%)';
        document.getElementById('proj-tp-' + col).innerText = '$ ' + (data.tpPrice ? data.tpPrice.toFixed(4) : '--') + ' (+' + (data.tpRoe ? data.tpRoe.toFixed(1) : '--') + '%)';

        // Ajusta slider se vazio
        const alavEl = document.getElementById('alav-' + col);
        if (alavEl && !alavEl.dataset.userModified && data.leverageSugerida) {
          alavEl.value = data.leverageSugerida;
          document.getElementById('alav-val-' + col).innerText = data.leverageSugerida + 'x';
        }

        // ── POSIÇÃO ABERTA (ALTO DESTAQUE VISUAL COM GLOW) ──
        const posBox = document.getElementById('pos-' + col);
        const cardEl = document.getElementById('card-' + col);
        if (data.pos) {
          posBox.style.display = 'block';
          const p = data.pos;
          const ladoEl = document.getElementById('pos-lado-' + col);
          const isLong = p.lado === 'LONG';
          ladoEl.innerHTML = '<span class="pos-side-pill ' + (isLong ? 'badge-long' : 'badge-short') + '">' + p.lado + ' ' + p.alavancagem + 'x</span>';

          document.getElementById('pos-qty-' + col).innerText = "Qty: " + p.quantidade;

          const pnl = p.pnlNaoRealizado;
          const entryPrice = parseFloat(p.precoEntrada);
          const alav = p.alavancagem || 1;
          const curPrice = parseFloat(p.precoMarca) || entryPrice;
          const varPrecoPct = ((curPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1);
          let roi = varPrecoPct * alav;
          const isProfit = pnl >= 0;
          const sinal = isProfit ? '+' : '';
          const cor = isProfit ? '#10B981' : '#EF4444';
          const pnlEl = document.getElementById('pos-pnl-' + col);
          const pnlBrlEl = document.getElementById('pos-pnl-brl-' + col);

          // Destaque visual: Verde vibrante se ganhando, Vermelho se perdendo
          pnlEl.style.color = cor;
          pnlEl.style.textShadow = '0 0 20px ' + (isProfit ? 'rgba(16, 185, 129, 0.6)' : 'rgba(239, 68, 68, 0.6)');
          pnlEl.innerText = (isProfit ? "+$ " : "-$ ") + Math.abs(pnl).toFixed(2) + ' (' + sinal + roi.toFixed(2) + '%)';

          pnlBrlEl.style.color = isProfit ? '#34D399' : '#F87171';
          pnlBrlEl.innerText = (isProfit ? "+R$ " : "-R$ ") + Math.abs(pnl * brlGlobal).toFixed(2);

          posBox.style.border = '2px solid ' + cor;
          posBox.style.boxShadow = '0 0 25px ' + (isProfit ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)');
          posBox.style.background = isProfit
            ? 'linear-gradient(180deg, rgba(16,185,129,0.18) 0%, rgba(6,78,59,0.25) 100%)'
            : 'linear-gradient(180deg, rgba(239,68,68,0.18) 0%, rgba(127,29,29,0.25) 100%)';

          if (cardEl) {
            cardEl.style.borderColor = isProfit ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)';
            cardEl.style.boxShadow = '0 0 25px ' + (isProfit ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)');
          }

          const prec = data.pricePrecision || 4;
          document.getElementById('pos-entry-' + col).innerText = '$ ' + Number(p.precoEntrada).toFixed(prec);

          // Banner de Status da Posição (Breakeven)
          const beEl = document.getElementById('pos-be-status-' + col);
          if (beEl) {
            const stopPriceTxt = data.beStopPrice ? Number(data.beStopPrice).toFixed(prec) : '--';
            if (data.beArmed && data.beStopPrice) {
              const maxR = (data.maxRoiReached || 0).toFixed(2);
              const lockR = (data.lockedRoi || 0).toFixed(1);
              beEl.style.display = 'block';
              beEl.className = 'pos-be-banner';
              beEl.style.background = 'rgba(16, 185, 129, 0.22)';
              beEl.style.borderColor = 'var(--green)';
              beEl.style.color = 'var(--green)';
              beEl.innerText = '🛡️ BREAKEVEN ATIVO: GARANTIDO +' + lockR + '% ROI ($' + stopPriceTxt + ') | PICO: +' + maxR + '% ROI';
            } else {
              beEl.style.display = 'none';
            }
          }
        } else {
          posBox.style.display = 'none';
          if (cardEl) {
            cardEl.style.borderColor = (colunaAtiva === col ? 'rgba(212, 175, 55, 0.55)' : 'var(--card-border)');
            cardEl.style.boxShadow = (colunaAtiva === col ? '0 0 25px rgba(212, 175, 55, 0.1)' : '0 4px 20px rgba(0,0,0,0.35)');
          }
        }
      } catch(e) {
        document.getElementById('status-' + col).innerText = "Falha de rede";
      }
    }

    async function atualizarGauge(col) {
      let sym = document.getElementById('sym-' + col).value.trim().toUpperCase();
      if (!sym) return;
      if (!sym.endsWith('USDT')) sym += 'USDT';
      try {
        const r = await fetch('/api/gauge/' + sym);
        const d = await r.json();
        if (d.success) {
          const takerEl = document.getElementById('gauge-taker-' + col);
          if (takerEl) {
            const tr = parseFloat(d.takerRatio || 1);
            takerEl.innerText = tr.toFixed(2) + 'x ' + (tr >= 1 ? '[COMPRA]' : '[VENDA]');
            takerEl.style.color = tr >= 1 ? 'var(--green)' : 'var(--red)';
          }

          const doiEl = document.getElementById('gauge-delta-oi-' + col);
          if (doiEl) {
            const doi = parseFloat(d.deltaOI || 0);
            doiEl.innerText = (doi >= 0 ? '+' : '') + doi.toFixed(1) + '%';
            doiEl.style.color = doi >= 0 ? 'var(--green)' : 'var(--red)';
          }

          const fundEl = document.getElementById('gauge-fund-' + col);
          if (fundEl) {
            const fr = parseFloat(d.fundingRate || 0);
            fundEl.innerText = (fr * 100).toFixed(4) + '%';
            fundEl.style.color = fr > 0.00015 ? 'var(--red)' : (fr < 0.00005 ? 'var(--green)' : '#FFF');
          }
        }
      } catch(e) {}
    }

    async function consultarIaManual(col) {
      let sym = document.getElementById('sym-' + col).value.trim().toUpperCase();
      if (!sym) return;
      if (!sym.endsWith('USDT')) sym += 'USDT';

      const st = document.getElementById('status-' + col);
      st.innerText = "Consultando Gemini Flash Quant...";
      st.style.color = "var(--gold)";

      try {
        const res = await fetch('/api/ia-advise/' + sym);
        const data = await res.json();
        if (data.success) {
          const corDec = data.decisao === 'LONG' ? 'var(--green)' : (data.decisao === 'SHORT' ? 'var(--red)' : 'var(--gold)');
          const html = '<div style="font-size:1rem; margin-bottom:10px;">Veredito: <b style="color:' + corDec + ';">' + data.decisao + '</b> (' + data.confianca + '% confiança)</div>' +
            '<div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:15px;">' + data.motivo + '</div>' +
            '<div style="font-size:0.8rem; font-family:monospace; background:rgba(0,0,0,0.3); padding:10px; border-radius:8px; text-align:left;">' +
              '<div>• Alavancagem: ' + data.alavancagem + 'x</div>' +
              '<div>• Stop Loss: $ ' + (data.slPrice ? data.slPrice.toFixed(4) : '--') + '</div>' +
              '<div>• Take Profit: $ ' + (data.tpPrice ? data.tpPrice.toFixed(4) : '--') + '</div>' +
              '<div>• Breakeven: $ ' + (data.beTriggerPrice ? data.beTriggerPrice.toFixed(4) : '--') + '</div>' +
            '</div>';
          askConfirm("⚡ Análise Institucional", html, true);
          st.innerText = "IA: " + data.decisao + " (" + data.motivo + ")";
        } else {
          askConfirm("Erro IA", data.error, true);
        }
      } catch(e) {
        st.innerText = "Falha ao consultar IA";
      }
    }

    async function execTrade(col, lado) {
      let sym = document.getElementById('sym-' + col).value.trim().toUpperCase();
      if (!sym) return;
      if (!sym.endsWith('USDT')) sym += 'USDT';

      const alav = document.getElementById('alav-' + col).value;
      const val = document.getElementById('val-' + col).value;
      const txtLado = lado === 'BUY' ? 'COMPRA (LONG)' : 'VENDA (SHORT)';
      const corLado = lado === 'BUY' ? 'var(--green)' : 'var(--red)';

      const html = '<div style="font-size:1.1rem; margin-bottom:10px;">Ativo: <b style="color:var(--gold);">' + sym + '</b></div>' +
        '<div style="font-size:1.1rem; margin-bottom:10px;">Ordem: <b style="color:' + corLado + ';">' + txtLado + '</b></div>' +
        '<div style="font-size:1.1rem; margin-bottom:10px;">Alavancagem: <b style="color:var(--text);">' + alav + 'x</b></div>' +
        '<div style="font-size:1.1rem; margin-bottom:20px;">Tamanho Total: <b style="color:var(--text);">' + val + ' USDT</b></div>';

      if (!(await askConfirm('Executar Ordem', html))) return;

      const st = document.getElementById('status-' + col);
      st.innerText = "Executando...";
      st.style.color = "var(--gold)";

      try {
        const res = await fetch('/api/trade', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ symbol: sym, lado, valorUSDT: val, alavancagem: alav })
        });
        const data = await res.json();
        if (data.success) {
          st.innerText = "Executado!";
          st.style.color = "var(--green)";
          loadData(col);
          carregarSaldo();
        } else {
          st.innerText = "Falha!";
          st.style.color = "var(--red)";
          askConfirm("Erro ao Executar", data.error, true);
        }
      } catch (e) {
        st.innerText = "Erro";
      }
    }

    async function fecharPosicao(col) {
      let sym = document.getElementById('sym-' + col).value.trim().toUpperCase();
      if (!sym.endsWith('USDT')) sym += 'USDT';

      if (!(await askConfirm('Fechar Posição', 'Deseja encerrar 100% da posição de <b style="color:var(--gold);">' + sym + '</b> a mercado?'))) return;

      const st = document.getElementById('status-' + col);
      st.innerText = "Fechando...";

      try {
        const res = await fetch('/api/close', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ symbol: sym })
        });
        const data = await res.json();
        if (data.success) {
          st.innerText = "Encerrada!";
          st.style.color = "var(--green)";
          loadData(col);
          carregarSaldo();
          carregarPlacar();
        } else {
          st.innerText = "Erro: " + data.error;
          st.style.color = "var(--red)";
        }
      } catch (e) {
        st.innerText = "Erro";
      }
    }

    async function reverterPosicao(col) {
      let sym = document.getElementById('sym-' + col).value.trim().toUpperCase();
      if (!sym.endsWith('USDT')) sym += 'USDT';

      if (!(await askConfirm('Reverter Posição', 'Deseja <b style="color:var(--gold);">REVERTER</b> a posição de ' + sym + '?'))) return;

      const st = document.getElementById('status-' + col);
      st.innerText = "Revertendo...";

      try {
        const res = await fetch('/api/reverse', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ symbol: sym })
        });
        const data = await res.json();
        if (data.success) {
          st.innerText = "Posição revertida!";
          st.style.color = "var(--green)";
          loadData(col);
          carregarSaldo();
          carregarPlacar();
        } else {
          st.innerText = "Erro: " + data.error;
          st.style.color = "var(--red)";
        }
      } catch (e) {
        st.innerText = "Erro";
      }
    }

    // ── PLACAR INSTITUCIONAL WIN / LOSS EM TEMPO REAL ──
    async function carregarPlacar() {
      try {
        const r = await fetch('/api/win-loss');
        const d = await r.json();
        if (d.success) {
          const w = d.wins || 0;
          const l = d.losses || 0;
          const tot = w + l;
          const wr = tot > 0 ? Math.round((w / tot) * 100) : 0;
          document.getElementById('placar-wins').innerText = w + ' W';
          document.getElementById('placar-losses').innerText = l + ' L';
          const wrEl = document.getElementById('placar-wr');
          if (wrEl) wrEl.innerText = wr + '% WR';
        }
      } catch(e) {}
    }

    async function zerarPlacar() {
      if (!(await askConfirm('Zerar Placar', 'Deseja reiniciar a contagem de acertos e erros a partir deste momento?'))) return;
      try {
        const r = await fetch('/api/limpar-placar', { method: 'POST' });
        const d = await r.json();
        if (d.success) {
          document.getElementById('placar-wins').innerText = '0 W';
          document.getElementById('placar-losses').innerText = '0 L';
          const wrEl = document.getElementById('placar-wr');
          if (wrEl) wrEl.innerText = '0% WR';
          carregarSaldo();
          askConfirm('✓ Sucesso', 'Placar zerado com sucesso.', true);
        }
      } catch(e) {}
    }

    // ── ROBÔ AUTÔNOMO ──
    let autoBotActive = false;

    async function atualizarStatusAutoBot() {
      try {
        const r = await fetch('/api/auto-status');
        const d = await r.json();
        if (d.success) {
          autoBotActive = d.enabled;
          const btn = document.getElementById('btn-auto-toggle');
          const statusTxt = document.getElementById('auto-status-text');
          const logEl = document.getElementById('auto-log-text');

          if (d.enabled) {
            btn.innerText = 'DESLIGAR ROBÔ';
            btn.style.background = 'rgba(239, 68, 68, 0.2)';
            btn.style.borderColor = 'var(--red)';
            btn.style.color = 'var(--red)';
            statusTxt.innerText = '● Robô Autônomo Ativo';
            statusTxt.style.color = 'var(--green)';

            [1, 2].forEach(col => {
              const sl = d.slots[col];
              if (sl) {
                const symTarget = sl.symbol || sl.targetSymbol;
                if (symTarget) {
                  const symInput = document.getElementById('sym-' + col);
                  const cur = symInput.value.trim().toUpperCase();
                  if (cur !== symTarget) {
                    symInput.value = symTarget;
                    debouncedLoad(col);
                  }
                }
                const st = document.getElementById('status-' + col);
                if (st && sl.status) {
                  st.innerText = '🤖 ' + sl.status;
                  if (sl.status.includes('ATIVO')) {
                    st.style.color = 'var(--green)';
                  } else if (sl.status.includes('SLOTS OCUPADOS')) {
                    st.style.color = 'var(--blue)';
                  } else if (sl.status.includes('AGUARDANDO')) {
                    st.style.color = 'var(--gold)';
                  } else if (sl.status.includes('RECUSADO') || sl.status.includes('VETO')) {
                    st.style.color = 'var(--red)';
                  } else {
                    st.style.color = 'var(--text-muted)';
                  }
                }
              }
            });
          } else {
            btn.innerText = 'LIGAR ROBÔ IA';
            btn.style.background = 'rgba(16, 185, 129, 0.2)';
            btn.style.borderColor = 'var(--green)';
            btn.style.color = 'var(--green)';
            statusTxt.innerText = 'Robô Desligado';
            statusTxt.style.color = 'var(--text-muted)';
          }

          if (d.lastLog) logEl.innerText = d.lastLog;
          const tokEl = document.getElementById('total-tokens-val');
          if (tokEl && d.tokensGastos !== undefined) {
            tokEl.innerText = Number(d.tokensGastos).toLocaleString('pt-BR');
          }

          // Atualiza placar em tempo real se vier no payload de auto-status
          if (d.placar) {
            const w = d.placar.wins || 0;
            const l = d.placar.losses || 0;
            const tot = w + l;
            const wr = tot > 0 ? Math.round((w / tot) * 100) : 0;
            const wEl = document.getElementById('placar-wins');
            const lEl = document.getElementById('placar-losses');
            const wrEl = document.getElementById('placar-wr');
            if (wEl) wEl.innerText = w + ' W';
            if (lEl) lEl.innerText = l + ' L';
            if (wrEl) wrEl.innerText = wr + '% WR';
          }

          carregarRagBadge();
        }
      } catch(e) {}
    }

    let ultimoCarregamentoRag = 0;
    async function carregarRagBadge() {
      const agora = Date.now();
      if (agora - ultimoCarregamentoRag < 10000) return;
      ultimoCarregamentoRag = agora;
      try {
        const r = await fetch('/api/rag-stats');
        const d = await r.json();
        if (d.success && d.stats) {
          const el = document.getElementById('auto-rag-badge');
          if (el) {
            const tot = d.stats.total || 0;
            const wins = d.stats.wins || 0;
            const wr = tot > 0 ? Math.round((wins / tot) * 100) : 0;
            el.innerText = tot + ' trades (' + wr + '% win)';
          }
        }
      } catch(e) {}
    }

    async function toggleAutoBot() {
      const novoEstado = !autoBotActive;
      const acao = novoEstado ? 'LIGAR' : 'DESLIGAR';
      if (!(await askConfirm(acao + ' ROBÔ', 'Deseja ' + acao.toLowerCase() + ' o robô autônomo com 3 Modos Dinâmicos e gestão de risco 1:2?'))) return;

      try {
        const r = await fetch('/api/auto-trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: novoEstado })
        });
        const d = await r.json();
        if (d.success) atualizarStatusAutoBot();
      } catch(e) {
        askConfirm('Erro', 'Falha ao alterar estado do robô.', true);
      }
    }

    // ── HISTÓRICO MODAL INSTITUCIONAL ──
    let abaAtualHist = 'periodo';
    let todosTradesCache = [];

    function abrirHistorico() {
      document.getElementById('modal-hist').style.display = 'flex';
      carregarHistoricoCompleto();
    }
    function fecharHistorico() {
      document.getElementById('modal-hist').style.display = 'none';
    }

    function mudarAbaHist(aba) {
      abaAtualHist = aba;
      ['periodo', 'hoje', 'todas'].forEach(t => {
        const btn = document.getElementById('btn-tab-' + t);
        if (t === aba) {
          btn.style.background = 'var(--gold)';
          btn.style.color = '#000';
          btn.style.fontWeight = '800';
        } else {
          btn.style.background = 'rgba(255,255,255,0.08)';
          btn.style.color = 'var(--text)';
          btn.style.fontWeight = '600';
        }
      });
      renderizarAbaHistorico();
    }

    async function carregarHistoricoCompleto() {
      const container = document.getElementById('hist-content');
      container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted); font-weight:600;">Carregando histórico Binance...</div>';
      try {
        const res = await fetch('/api/historico-completo');
        const data = await res.json();
        if (!data.success || !data.trades || data.trades.length === 0) {
          container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted); font-weight:600;">Nenhum trade encontrado.</div>';
          return;
        }
        todosTradesCache = data.trades;
        renderizarAbaHistorico();
      } catch(e) {
        container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--red); font-weight:700;">Erro ao carregar histórico.</div>';
      }
    }

    function renderizarAbaHistorico() {
      const container = document.getElementById('hist-content');
      if (!todosTradesCache || todosTradesCache.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted); font-weight:600;">Sem registros.</div>';
        return;
      }

      const tradeGroups = {};
      todosTradesCache.forEach(t => {
        const orderId = t.orderId;
        if (!tradeGroups[orderId]) {
          tradeGroups[orderId] = {
            orderId,
            symbol: t.symbol,
            side: t.side,
            time: t.time,
            pnl: 0,
            fee: 0,
            qty: 0,
            hasPnl: false
          };
        }
        const p = parseFloat(t.realizedPnl);
        const f = parseFloat(t.commission);
        const q = parseFloat(t.qty);
        if (!isNaN(p)) {
          tradeGroups[orderId].pnl += p;
          if (Math.abs(p) > 0.000001) tradeGroups[orderId].hasPnl = true;
        }
        if (!isNaN(f)) tradeGroups[orderId].fee += f;
        if (!isNaN(q)) tradeGroups[orderId].qty += q;
      });

      const groupedArray = Object.values(tradeGroups).sort((a,b) => b.time - a.time);

      if (abaAtualHist === 'hoje') {
        const inicioHoje = new Date();
        inicioHoje.setHours(0,0,0,0);
        const hojeTrades = groupedArray.filter(g => g.time >= inicioHoje.getTime());
        container.innerHTML = renderAbaComResumo(hojeTrades, 'Hoje', 'Operações de Hoje');
      } else if (abaAtualHist === 'todas') {
        container.innerHTML = renderAbaComResumo(groupedArray, 'Todas', 'Todas as Operações');
      } else {
        container.innerHTML = renderAbaComResumo(groupedArray, 'Geral', 'Últimas 40 Operações');
      }
    }

    function renderAbaComResumo(lista, titulo, subtitulo) {
      if (!lista || lista.length === 0) {
        return '<div style="text-align:center; padding:30px; color:var(--text-muted); font-weight:600;">Nenhum trade encontrado em ' + subtitulo + '.</div>';
      }

      let totWin = 0, totLoss = 0, totPnl = 0, totFee = 0;
      lista.forEach(g => {
        if (g.hasPnl) {
          if (g.pnl > 0.0001) totWin++;
          else if (g.pnl < -0.0001) totLoss++;
          totPnl += g.pnl;
        }
        totFee += g.fee;
      });

      const winRate = (totWin + totLoss) > 0 ? Math.round((totWin / (totWin + totLoss)) * 100) : 0;
      let html = '<div class="hist-summary-grid">' +
          '<div class="hist-stat-card">' +
            '<div class="hist-stat-title">Taxa de Acerto (' + titulo + ')</div>' +
            '<div class="hist-stat-val" style="color:' + (winRate >= 50 ? 'var(--green)' : 'var(--gold)') + ';">' + winRate + '% <span class="hist-stat-count">(' + totWin + 'W / ' + totLoss + 'L)</span></div>' +
          '</div>' +
          '<div class="hist-stat-card">' +
            '<div class="hist-stat-title">PnL Líquido (' + titulo + ')</div>' +
            '<div class="hist-stat-val" style="color:' + (totPnl >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + (totPnl >= 0 ? '+' : '') + '$ ' + totPnl.toFixed(2) + '</div>' +
          '</div>' +
          '<div class="hist-stat-card">' +
            '<div class="hist-stat-title">Corretagem (' + titulo + ')</div>' +
            '<div class="hist-stat-val text-gold">-$ ' + totFee.toFixed(2) + '</div>' +
          '</div>' +
        '</div>';

      html += renderListaSimples(lista.slice(0, 50), subtitulo);
      return html;
    }

    function renderListaSimples(lista, titulo) {
      if (lista.length === 0) return '<div style="text-align:center; padding:30px; color:var(--text-muted); font-weight:600;">Nenhum trade encontrado em ' + titulo + '.</div>';
      let html = '<div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:14px; font-weight:700;">Exibindo ' + lista.length + ' ordens (' + titulo + ')</div>';
      lista.forEach(g => {
        const isWin = g.pnl > 0.0001;
        const isLoss = g.pnl < -0.0001;
        const cor = isWin ? '#10B981' : (isLoss ? '#EF4444' : '#94A3B8');
        const borderCor = isWin ? 'var(--green)' : (isLoss ? 'var(--red)' : 'var(--border)');
        const bgBadge = isWin ? 'rgba(16,185,129,0.18)' : (isLoss ? 'rgba(239,68,68,0.18)' : 'rgba(255,255,255,0.06)');
        const dataStr = new Date(g.time).toLocaleString('pt-BR');
        const tag = isWin ? 'WIN' : (isLoss ? 'LOSS' : '0 a 0');

        html += '<div class="trade-card-row" style="border-left: 4px solid ' + borderCor + ';">' +
            '<div class="trade-left">' +
              '<div class="trade-sym-row">' +
                '<span class="trade-sym">' + g.symbol + '</span>' +
                '<span class="trade-side-pill ' + (g.side === 'BUY' ? 'pill-buy' : 'pill-sell') + '">' + (g.side === 'BUY' ? 'COMPRA' : 'VENDA') + '</span>' +
                '<span class="trade-tag-pill" style="color:' + cor + '; background:' + bgBadge + ';">' + tag + '</span>' +
              '</div>' +
              '<div class="trade-date">' + dataStr + '</div>' +
            '</div>' +
            '<div class="trade-right">' +
              '<div class="trade-pnl" style="color:' + cor + ';">' + (g.pnl >= 0 ? '+' : '') + '$ ' + g.pnl.toFixed(2) + '</div>' +
              '<div class="trade-fee">Taxa: $ ' + g.fee.toFixed(4) + '</div>' +
            '</div>' +
          '</div>';
      });
      return html;
    }

    function fazerLogout() {
      fetch('/', { headers: { 'Authorization': 'Basic logout' } }).finally(() => {
        window.location.reload();
      });
    }

    // Inicialização
    window.addEventListener('DOMContentLoaded', () => {
      [1, 2].forEach(col => {
        const saved = localStorage.getItem('sym-' + col);
        if (saved && saved !== 'undefined' && saved !== 'null') {
          document.getElementById('sym-' + col).value = saved;
          debouncedLoad(col);
        }
      });
      carregarSaldo();
      carregarVolateis();
      carregarPlacar();
      atualizarStatusAutoBot();
      setInterval(carregarSaldo, 15000);
      setInterval(carregarVolateis, 60000);
      setInterval(carregarPlacar, 5000);
      setInterval(atualizarStatusAutoBot, 3000);
    });
  </script>
</body>
</html>`);
});


(async () => {
  try {
    await fut.sincronizarRelogio('boot');
    await fut.carregarExchangeInfo();

    // Sincroniza posições ativas da Binance nos slots autônomos e limpa órfãs
    try {
      const posAtivas = await fut.todasPosicoes();
      const posComQtd = (Array.isArray(posAtivas) ? posAtivas : []).filter(p => parseFloat(p.positionAmt) !== 0);
      if (posComQtd.length > 0) {
        for (let idx = 0; idx < posComQtd.length; idx++) {
          const p = posComQtd[idx];
          if (idx < 2) {
            const sNum = idx + 1;
            autoBotState.slots[sNum].symbol = p.symbol;
            autoBotState.slots[sNum].targetSymbol = p.symbol;
            autoBotState.slots[sNum].side = p.lado;
            autoBotState.slots[sNum].leverage = p.alavancagem;
            autoBotState.slots[sNum].openTime = p.atualizadoEm || Date.now();
            autoBotState.slots[sNum].status = `[POSIÇÃO ATIVA] ${p.symbol} (${p.lado} ${p.alavancagem}x)`;
            console.log(`[BOOT] Slot ${sNum} sincronizado com posição existente: ${p.symbol} (${p.lado} ${p.alavancagem}x)`);

            if (!localAlvos[p.symbol]) {
              const pEntrada = parseFloat(p.precoEntrada);
              const isLong = p.lado === 'LONG';
              const alav = p.alavancagem || 1;
              localAlvos[p.symbol] = {
                side: p.lado,
                entryPrice: pEntrada,
                slPrice: isLong ? pEntrada * (1 - (12.0 / alav) / 100) : pEntrada * (1 + (12.0 / alav) / 100),
                tpPrice: isLong ? pEntrada * (1 + 0.10 / alav) : pEntrada * (1 - 0.10 / alav),
                beTriggerPrice: isLong ? pEntrada * (1 + (0.80 / alav) / 100) : pEntrada * (1 - (0.80 / alav) / 100),
                slDistPct: 0.12 / alav,
                beArmed: false,
                beStage: 0,
                beStopPrice: null,
                beLabel: '',
                lockedRoi: 0,
                leverage: p.alavancagem,
                maxRoiReached: 0
              };
              salvarAlvos();
            } else {
              if (localAlvos[p.symbol].beStage === undefined) localAlvos[p.symbol].beStage = 0;
              if (localAlvos[p.symbol].beStopPrice === undefined) localAlvos[p.symbol].beStopPrice = null;
              if (localAlvos[p.symbol].beLabel === undefined) localAlvos[p.symbol].beLabel = '';
              if (localAlvos[p.symbol].lockedRoi === undefined) localAlvos[p.symbol].lockedRoi = 0;
              if (localAlvos[p.symbol].maxRoiReached === undefined) localAlvos[p.symbol].maxRoiReached = 0;
              delete localAlvos[p.symbol].jaReverteu;
              delete localAlvos[p.symbol].elegivelParaReversao;
              salvarAlvos();
            }
          } else {
            console.warn(`[BOOT-ORFÃ] Posição órfã detectada na Binance além dos 2 slots: ${p.symbol} (${p.lado} ${p.quantidade}). Encerrando imediatamente a mercado...`);
            await fut.cancelarTodasOrdens(p.symbol);
            await fut.fecharMercado(p.symbol, p.lado, p.quantidade).catch(e => {
              console.error(`[BOOT-ORFÃ] Erro ao fechar órfã ${p.symbol}:`, e.message);
            });
          }
        }
      }
    } catch(e) {
      console.error('[BOOT] Erro ao sincronizar posições:', e.message);
    }

    app.listen(PORT, () => console.log('Painel Quant Institucional rodando na porta ' + PORT));
  } catch (e) {
    console.error("Erro no boot:", e);
  }
})();
