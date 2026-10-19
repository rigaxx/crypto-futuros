const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const fut = require('./lib/futuresApi');
const ti = require('technicalindicators');
const axios = require('axios');
const fs = require('fs');
const db = require('./db');
const rag = require('./lib/rag_memory');

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7005;
const SENHA = process.env.ACESSO_SENHA || 'admin123';
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
    const [k5m, k15m, k1h, k4h, oiHist, takerRatio, premiumData, oiData, bookData] = await Promise.all([
      fut.klines(symbol, '5m', 100).catch(() => []),
      fut.klines(symbol, '15m', 100).catch(() => []),
      fut.klines(symbol, '1h', 100).catch(() => []),
      fut.klines(symbol, '4h', 50).catch(() => []),
      fut.openInterestHist(symbol, '5m', 5).catch(() => []),
      fut.takerBuySellRatio(symbol, '5m', 5).catch(() => []),
      fut.precoMarca(symbol).catch(() => null),
      fut.openInterest(symbol).catch(() => null),
      fut.livroOfertas(symbol, 5).catch(() => null)
    ]);

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

    // Projeções Dinâmicas de Risco (SL / TP / BE / Alavancagem)
    // Alavancagem 1x a 5x baseada no ATR%
    let leverageSugerida = 5;
    if (atrPct15m > 1.5) leverageSugerida = 2;
    else if (atrPct15m > 1.0) leverageSugerida = 3;
    else if (atrPct15m > 0.6) leverageSugerida = 4;
    else leverageSugerida = 5;

    const isLongSugerido = (mtfStatus === 'APTO_LONG');
    const slDist = 1.8 * atr15m;
    const slPctReal = (slDist / curPrice) * 100;
    const slRoe = slPctReal * leverageSugerida;
    const slPrice = isLongSugerido ? (curPrice - slDist) : (curPrice + slDist);

    const tpDist = 2.0 * slDist; // 1:2 R:R
    const tpPctReal = (tpDist / curPrice) * 100;
    const tpRoe = tpPctReal * leverageSugerida;
    const tpPrice = isLongSugerido ? (curPrice + tpDist) : (curPrice - tpDist);

    const beTriggerDist = Math.max(curPrice * 0.012, slDist); // min 1.2% real price ou 1x SL
    const beTriggerPctReal = (beTriggerDist / curPrice) * 100;
    const beTriggerRoe = beTriggerPctReal * leverageSugerida;
    const beTriggerPrice = isLongSugerido ? (curPrice + beTriggerDist) : (curPrice - beTriggerDist);

    return {
      symbol,
      curPrice,
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

// ── GATEKEEPER HARDCODED (ETAPA 5 - 0 TOKENS) ──────────────────────────
function verificarGatekeeper(dados) {
  if (!dados) return { passou: false, motivo: 'Dados indisponíveis' };

  // Regra 1: 1h e 15m na mesma direção na EMA 50
  const dir1h = dados.curPrice >= dados.ema50_1h ? 'BULL' : 'BEAR';
  const dir15m = dados.curPrice >= dados.ema50_15 ? 'BULL' : 'BEAR';
  if (dir1h !== dir15m) {
    return { passou: false, motivo: `Gatekeeper: 1h (${dir1h}) e 15m (${dir15m}) desalinhados na EMA 50` };
  }

  // Regra 2: Distância da EMA 21 > 1.5 * ATR (preço esticado)
  if (dados.distEma21Atr > 1.5) {
    return { passou: false, motivo: `Gatekeeper: Preço esticado (${dados.distEma21Atr.toFixed(2)}x ATR > 1.5x) da EMA 21` };
  }

  // Regra 3: ADX(14) do 15m menor que 20 (mercado lateral/sem força)
  if (dados.adx15m < 20) {
    return { passou: false, motivo: `Gatekeeper: ADX fraco (${dados.adx15m.toFixed(1)} < 20)` };
  }

  // Regra 4: Moeda com variação 0.0% em mais de 2 das últimas 10 velas de 5m
  if (dados.flatCandles5m > 2) {
    return { passou: false, motivo: `Gatekeeper: Moeda zumbi (${dados.flatCandles5m} velas 0% no 5m)` };
  }

  return { passou: true, direcaoSugerida: dir1h === 'BULL' ? 'LONG' : 'SHORT' };
}

// ── DECISÃO QUANTITATIVA VIA GEMINI FLASH (ETAPA 6) ───────────────────
async function consultarGeminiQuant(symbol, dados) {
  if (!ROUTER_API_KEY) {
    console.error('[GEMINI-QUANT] Sem ROUTER_API_KEY');
    return { action: 'WAIT', confidence: 0, reason_short: 'Sem chave 9Router' };
  }

  const prompt = `Você é um Gestor Quantitativo Institucional de Futuros da Binance. Sua decisão padrão é WAIT (ficar de fora).
Nunca autorize LONG após grandes altas esticadas longe da EMA 21, e nunca autorize SHORT após quedas extremas (>20% no dia) quando o 5m/15m já mostra exaustão vendedora ou divergência.
Só aprove uma entrada (LONG ou SHORT) se houver alinhamento entre Tendência (1h/15m), Pullback na EMA 21, Fluxo Positivo (Delta OI subindo + Taker Ratio a favor) e Risco/Retorno mínimo de 1:2.

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
  "action": "WAIT",
  "confidence": 85,
  "leverage": ${dados.leverageSugerida},
  "stop_loss_price": ${dados.slPrice},
  "take_profit_price": ${dados.tpPrice},
  "breakeven_trigger_price": ${dados.beTriggerPrice},
  "reason_short": "máximo 15 palavras explicando decisão"
}`;

  try {
    const payload = {
      model: 'ag/gemini-3.8-flash-low',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 250
    };

    const resp = await axios.post('http://127.0.0.1:20128/v1/chat/completions', payload, {
      headers: {
        'Authorization': `Bearer ${ROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    if (resp.data?.usage) {
      registrarUsoTokens(resp.data.usage);
    }

    const raw = resp.data?.choices?.[0]?.message?.content?.trim() || '';
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
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
      max_tokens: 150
    }, {
      headers: { 'Authorization': `Bearer ${ROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 8000
    });

    if (resp.data?.usage) registrarUsoTokens(resp.data.usage);
    const raw = resp.data?.choices?.[0]?.message?.content?.trim() || '';
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    return parsed.decisao === 'FECHAR' ? 'FECHAR' : 'MANTER';
  } catch(e) {
    return 'MANTER';
  }
}

// ── MONITORAMENTO DE RISCO EM CÓDIGO (1.5s - 0 Tokens, 0ms Delay) ─────
setInterval(async () => {
  for (const sym of Object.keys(localAlvos)) {
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
      const margem = pos.margem || ((pos.quantidade * entryPrice) / alav);
      let roi = 0;
      if (margem > 0) roi = (pos.pnlNaoRealizado / margem) * 100;

      let deveFechar = false;
      let motivoFechamento = '';

      if (pos.lado === 'LONG') {
        if (!maxPriceTracker[sym]) maxPriceTracker[sym] = curPrice;
        else if (curPrice > maxPriceTracker[sym]) maxPriceTracker[sym] = curPrice;
        const peakPrice = maxPriceTracker[sym];
        const peakGainReal = (peakPrice - entryPrice) / entryPrice;

        // 1. Take Profit
        if (alvo.tpPrice && curPrice >= alvo.tpPrice) {
          deveFechar = true;
          motivoFechamento = `[TAKE PROFIT 1:2] Preço ${curPrice} >= TP ${alvo.tpPrice} (+${roi.toFixed(2)}% ROI)`;
        }
        // 2. Stop Loss
        else if (alvo.slPrice && curPrice <= alvo.slPrice) {
          deveFechar = true;
          motivoFechamento = `[STOP LOSS ATR] Preço ${curPrice} <= SL ${alvo.slPrice} (${roi.toFixed(2)}% ROI)`;
        }
        // 3. Fallback SL -10% ROI
        else if (roi <= -10.0) {
          deveFechar = true;
          motivoFechamento = `[SAFETY SL -10%] ROI bateu ${roi.toFixed(2)}%`;
        }
        // 4. Breakeven Dinâmico
        else {
          const beGatilho = Math.max(0.012, alvo.slDistPct || 0.012);
          if (!alvo.beArmed && peakGainReal >= beGatilho) {
            alvo.beArmed = true;
            salvarAlvos();
            console.log(`[BREAKEVEN ARMADO] ${sym}: Pico andou +${(peakGainReal * 100).toFixed(2)}% (>= ${(beGatilho * 100).toFixed(2)}%). Stop movido para Entrada + 0.25%.`);
          }
          if (alvo.beArmed && curPrice <= entryPrice * 1.0025) {
            deveFechar = true;
            motivoFechamento = `[BREAKEVEN +0.25%] Recuou para Entrada + 0.25% (taxas Binance pagas, ganho garantido)`;
          }
        }
      } else {
        // SHORT
        if (!minPriceTracker[sym]) minPriceTracker[sym] = curPrice;
        else if (curPrice < minPriceTracker[sym]) minPriceTracker[sym] = curPrice;
        const valleyPrice = minPriceTracker[sym];
        const peakGainReal = (entryPrice - valleyPrice) / entryPrice;

        // 1. Take Profit
        if (alvo.tpPrice && curPrice <= alvo.tpPrice) {
          deveFechar = true;
          motivoFechamento = `[TAKE PROFIT 1:2] Preço ${curPrice} <= TP ${alvo.tpPrice} (+${roi.toFixed(2)}% ROI)`;
        }
        // 2. Stop Loss
        else if (alvo.slPrice && curPrice >= alvo.slPrice) {
          deveFechar = true;
          motivoFechamento = `[STOP LOSS ATR] Preço ${curPrice} >= SL ${alvo.slPrice} (${roi.toFixed(2)}% ROI)`;
        }
        // 3. Fallback SL -10% ROI
        else if (roi <= -10.0) {
          deveFechar = true;
          motivoFechamento = `[SAFETY SL -10%] ROI bateu ${roi.toFixed(2)}%`;
        }
        // 4. Breakeven Dinâmico
        else {
          const beGatilho = Math.max(0.012, alvo.slDistPct || 0.012);
          if (!alvo.beArmed && peakGainReal >= beGatilho) {
            alvo.beArmed = true;
            salvarAlvos();
            console.log(`[BREAKEVEN ARMADO] ${sym}: Pico andou +${(peakGainReal * 100).toFixed(2)}% (>= ${(beGatilho * 100).toFixed(2)}%). Stop movido para Entrada + 0.25%.`);
          }
          if (alvo.beArmed && curPrice >= entryPrice * 0.9975) {
            deveFechar = true;
            motivoFechamento = `[BREAKEVEN +0.25%] Recuou para Entrada + 0.25% (taxas Binance pagas, ganho garantido)`;
          }
        }
      }

      if (deveFechar) {
        console.log(`[FECHAMENTO QUANT] ${sym}: ${motivoFechamento}`);
        await fut.cancelarTodasOrdens(sym);
        await fut.fecharMercado(sym, pos.lado, pos.quantidade);

        const exitTipo = motivoFechamento.includes('TAKE PROFIT') ? 'TP' : (motivoFechamento.includes('BREAKEVEN') ? 'BREAKEVEN' : 'SL');
        await rag.salvarSaidaRAG({
          symbol: sym,
          exitPrice: curPrice,
          exitReason: exitTipo,
          roiPct: roi,
          pnlUsdt: pos.pnlNaoRealizado
        }).catch(() => {});

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

        delete localAlvos[sym];
        delete maxPriceTracker[sym];
        delete minPriceTracker[sym];
        salvarAlvos();
      }
    } catch(e) {}
  }
}, 1500);

// ── ROBÔ AUTÔNOMO CONTÍNUO (ETAPA 5: GATEKEEPER + CANDLE 5M) ───────────
let autoBotLoopRunning = false;
setInterval(async () => {
  if (!autoBotState.enabled || autoBotLoopRunning) return;
  autoBotLoopRunning = true;

  try {
    const now = Date.now();

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
        slot.status = `COOLDOWN_RESPIRADA (${restSec}s)`;
        continue;
      }

      // 3. Buscar moeda candidata líquida se não tiver
      if (!slot.targetSymbol) {
        slot.status = 'ESCANEANDO_MERCADO';
        const volData = await fut.ticker24h().catch(() => []);
        const vetados = await rag.consultarParesVetados(45).catch(() => []);
        const vetadosSet = new Set(vetados.map(v => v.symbol));

        // Ordena por volatilidade
        const candidatos = volData
          .filter(t => t.symbol.match(/^[A-Z0-9]+USDT$/) && t.symbol !== 'HEMIUSDT' && t.symbol !== moedaOutroSlot && !vetadosSet.has(t.symbol) && parseFloat(t.count || 0) > 1000)
          .sort((a, b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)))
          .slice(0, 10);

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
        slot.lastChecked5mTime = 0;
        slot.status = `CANDIDATO: ${moedaEscolhida} (AGUARDANDO FECHAMENTO 5M)`;
        console.log(`[AUTOBOT] Slot ${slotNum} escolheu candidato: ${moedaEscolhida}`);
      }

      // 4. Analisar no fechamento da vela de 5 minutos
      const cand = slot.targetSymbol;
      const k5m = await fut.klines(cand, '5m', 10).catch(() => []);
      if (!k5m || k5m.length < 2) continue;

      const last5mOpenTime = k5m[k5m.length - 1][0];
      if (slot.lastChecked5mTime === last5mOpenTime) {
        // Vela de 5m atual já foi avaliada; aguarda o fechamento
        slot.status = `MONITORANDO: ${cand} (AGUARDANDO VELA 5M)`;
        continue;
      }

      slot.lastChecked5mTime = last5mOpenTime;
      console.log(`[AUTOBOT] Slot ${slotNum}: Fechamento de vela 5m detectado em ${cand}. Analisando...`);

      const dados = await analisarEstruturaEMercado(cand);
      if (!dados) {
        slot.status = 'ERRO_INDICADORES';
        continue;
      }

      // ETAPA 5: GATEKEEPER HARDCODED (0 TOKENS)
      const gk = verificarGatekeeper(dados);
      if (!gk.passou) {
        console.log(`[AUTOBOT-GATEKEEPER] Slot ${slotNum} (${cand}) VETADO: ${gk.motivo} (0 tokens gastos)`);
        slot.status = `GATEKEEPER_VETO: ${gk.motivo}`;

        // Se ficar mais de 15 minutos sem passar no Gatekeeper, troca de moeda
        if (now - (slot.targetAssignedTime || now) > 15 * 60 * 1000) {
          slot.targetSymbol = null;
        }
        continue;
      }

      // Passou no Gatekeeper! Consulta Gemini Flash Quant
      console.log(`[AUTOBOT] Slot ${slotNum}: ${cand} passou no Gatekeeper! Consultando Gemini Flash...`);
      slot.status = `CONSULTANDO_IA (${cand})`;
      const dec = await consultarGeminiQuant(cand, dados);

      console.log(`[AUTOBOT-IA] Decisão para ${cand}:`, dec);

      if ((dec.action === 'LONG' || dec.action === 'SHORT') && dec.confidence >= 80) {
        const ladoTrade = dec.action === 'LONG' ? 'BUY' : 'SELL';
        const alav = Math.min(5, Math.max(1, dec.leverage || dados.leverageSugerida));
        const valorUSDT = 10;

        await fut.garantirAlavancagem(cand, alav, 'ISOLATED');
        const book = await fut.livroOfertas(cand, 5);
        const precoExec = parseFloat(ladoTrade === 'BUY' ? (book.asks[0] || [])[0] : (book.bids[0] || [])[0]);
        if (!precoExec) continue;

        const calc = fut.calcularQuantidade(cand, valorUSDT, precoExec, alav);
        if (!calc.ok) {
          console.error(`[AUTOBOT] Erro cálculo qty em ${cand}:`, calc.motivo);
          continue;
        }

        // Execução maker/limit-chase protegida
        let ord = await fut.colocarLimite(cand, ladoTrade, calc.qty, precoExec);
        await new Promise(r => setTimeout(r, 1200));
        try { await fut.cancelarOrdem(cand, ord.orderId); } catch(e){}
        let st = await fut.consultarOrdem(cand, ord.orderId);
        let filledQty = parseFloat(st.executedQty) || 0;

        if (filledQty === 0) {
          // Tenta segunda vez se não derrapou > 0.3%
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
          console.log(`[AUTOBOT] Slot ${slotNum}: Ordem EXECUTADA em ${cand} (${dec.action} ${alav}x, Qty: ${filledQty})!`);
          slot.symbol = cand;
          slot.side = dec.action;
          slot.leverage = alav;
          slot.openTime = now;
          slot.last30mCheck = now;
          slot.status = `ATIVO: ${cand} ${dec.action} ${alav}x`;

          // Armar alvos em código
          localAlvos[cand] = {
            side: dec.action,
            entryPrice: precoExec,
            slPrice: dec.stop_loss_price || dados.slPrice,
            tpPrice: dec.take_profit_price || dados.tpPrice,
            beTriggerPrice: dec.breakeven_trigger_price || dados.beTriggerPrice,
            slDistPct: dados.slPctReal / 100,
            beArmed: false,
            leverage: alav
          };
          salvarAlvos();

          // Salvar entrada no RAG
          await rag.salvarEntradaRAG({
            symbol: cand,
            side: dec.action,
            leverage: alav,
            mode: 'QUANT_MTF',
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
          slot.status = `ESCORREGOU: ${cand} (Não preencheu)`;
        }
      } else {
        slot.status = `IA_WAIT: ${dec.reason_short || 'Sem confluência'}`;
        // Se a IA rejeitar, troca de alvo
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
    res.json({ success: true, saldo: s });
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
      slPrice: dec.stop_loss_price || dados.slPrice,
      tpPrice: dec.take_profit_price || dados.tpPrice,
      beTriggerPrice: dec.breakeven_trigger_price || dados.beTriggerPrice,
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
      localAlvos[symbol] = {
        side: lado === 'BUY' ? 'LONG' : 'SHORT',
        entryPrice: preco,
        slPrice: dados ? dados.slPrice : (lado === 'BUY' ? preco * 0.98 : preco * 1.02),
        tpPrice: dados ? dados.tpPrice : (lado === 'BUY' ? preco * 1.04 : preco * 0.96),
        beTriggerPrice: dados ? dados.beTriggerPrice : (lado === 'BUY' ? preco * 1.015 : preco * 0.985),
        slDistPct: dados ? (dados.slPctReal / 100) : 0.02,
        beArmed: false,
        leverage: alav
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
    tokensGastos: tokensGastos.total_tokens || 0
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

app.get('/api/win-loss', async (req, res) => {
  try {
    const trades = await fut.userTradesCompleto();
    let tradesFiltrados = trades;
    let cutoff = 0;
    try {
      if (fs.existsSync(path.join(__dirname, '.placar_cutoff.json'))) {
        cutoff = JSON.parse(fs.readFileSync(path.join(__dirname, '.placar_cutoff.json'), 'utf8')).cutoff || 0;
        if (cutoff > 0) tradesFiltrados = trades.filter(t => t.time >= cutoff);
      }
    } catch(e){}

    const tradeGroups = {};
    tradesFiltrados.forEach(t => {
      const orderId = t.orderId;
      if (!tradeGroups[orderId]) tradeGroups[orderId] = { pnl: 0, time: t.time, symbol: t.symbol, hasPnl: false };
      const p = parseFloat(t.realizedPnl);
      if (!isNaN(p)) {
        tradeGroups[orderId].pnl += p;
        if (Math.abs(p) > 0.000001) tradeGroups[orderId].hasPnl = true;
      }
    });

    let wins = 0, losses = 0;
    Object.values(tradeGroups).forEach(g => {
      if (g.hasPnl) {
        if (g.pnl > 0) wins++;
        else if (g.pnl < 0) losses++;
      }
    });

    res.json({ success: true, wins, losses, total: wins + losses });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/limpar-placar', (req, res) => {
  try {
    fs.writeFileSync(path.join(__dirname, '.placar_cutoff.json'), JSON.stringify({ cutoff: Date.now() }));
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
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
      <div class="input-group">
        <input type="text" id="sym-${col}" placeholder="Moeda (ex: BTC)" oninput="debouncedLoad(${col})" autocomplete="off">
      </div>
      <div class="price-display" id="price-${col}">$ 0.0000</div>
      
      <!-- TENDÊNCIA MTF (4h, 1h, 15m, 5m) + ALINHAMENTO MTF -->
      <div class="mtf-box">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px;">Tendência MTF (EMA 50)</span>
          <span id="mtf-status-${col}" class="badge-mtf">CARREGANDO</span>
        </div>
        <div class="candles-row" id="candles-${col}" style="margin-bottom:0; padding:6px 10px;">
          ${['4h','1h','15m','5m'].map(tf => `
            <div class="candle">
              <span class="candle-label">${tf}</span>
              <div class="dot" id="dot-${col}-${tf}"></div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- PAINEL DE ESTRUTURA E FLUXO (5m / 15m) -->
      <div class="flow-panel">
        <div class="flow-title">Estrutura & Fluxo (5m / 15m)</div>
        <div class="flow-row">
          <span style="color:var(--text-muted);">Alinhamento EMAs:</span>
          <span id="ema-align-${col}" style="font-weight:bold; color:#fff;">--</span>
        </div>
        <div class="flow-row">
          <span style="color:var(--text-muted);">Distância EMA 21:</span>
          <span id="dist-ema-${col}" style="font-weight:bold;">--</span>
        </div>
        <div class="flow-row">
          <span style="color:var(--text-muted);">ATR (14) 15m:</span>
          <span id="atr-pct-${col}" style="color:var(--gold); font-weight:bold;">--</span>
        </div>
        <div class="flow-row" style="margin-bottom:0;">
          <span style="color:var(--text-muted);">ADX / RVOL:</span>
          <span id="adx-rvol-${col}" style="color:#fff; font-weight:bold;">--</span>
        </div>
      </div>

      <!-- RSI (15m WILDER) & QUALIDADE DO SETUP -->
      <div class="setup-quality-box">
        <div>
          <div style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase;">RSI (15m Wilder)</div>
          <div id="rsi-${col}" style="font-weight:bold; font-size:1.1rem; color:var(--text);">--</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:0.65rem; color:var(--text-muted); text-transform:uppercase;">Qualidade do Setup</div>
          <div id="trend-${col}" style="font-weight:bold; font-size:0.75rem;">--</div>
        </div>
      </div>

      <!-- POSIÇÃO ABERTA -->
      <div class="pos-card" id="pos-${col}">
        <div class="pos-header">
          <span id="pos-lado-${col}" style="font-weight: bold;">--</span>
          <span id="pos-qty-${col}" style="color: var(--text-muted);">Qty: --</span>
        </div>
        <div class="pos-pnl" id="pos-pnl-${col}">$ 0.00 (0.00%)</div>
        <div style="font-size: 0.75rem; color: #3b82f6; text-align: center; margin-bottom: 8px;" id="pos-pnl-brl-${col}">R$ 0,00</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); text-align: center; margin-bottom: 8px;">Entrada: <span id="pos-entry-${col}">--</span></div>
        <div style="display:flex; gap:6px; margin-bottom:6px;">
          <button class="btn-close" style="flex:1; padding:8px; font-size:0.7rem;" onclick="fecharPosicao(${col})">FECHAR MERCADO</button>
          <button class="btn-reverse" style="flex:1; padding:8px; font-size:0.7rem;" onclick="reverterPosicao(${col})">REVERTER</button>
        </div>
      </div>

      <!-- PROJEÇÃO DE RISCO QUANTITATIVO (SL / BE / TP / ATR) -->
      <div class="risk-proj-box">
        <div style="display:flex; justify-content:space-between; color:var(--text-muted); margin-bottom:4px; font-size:0.7rem;">
          <span>Alav Sugerida: <b id="proj-alav-${col}" style="color:var(--gold);">--x</b></span>
          <span>Entrada: <b style="color:#fff;">10 USDT</b></span>
        </div>
        <div style="display:flex; justify-content:space-between; font-family:monospace; font-size:0.7rem;">
          <span style="color:var(--red);">SL: <span id="proj-sl-${col}">--</span></span>
          <span style="color:var(--blue);">BE: <span id="proj-be-${col}">--</span></span>
          <span style="color:var(--green);">TP: <span id="proj-tp-${col}">--</span></span>
        </div>
      </div>

      <div class="range-group">
        <label>Alavancagem</label>
        <input type="range" id="alav-${col}" min="1" max="5" value="3" oninput="document.getElementById('alav-val-${col}').innerText = this.value + 'x'">
        <span id="alav-val-${col}">3x</span>
      </div>
      
      <div class="input-group" style="margin-bottom: 10px;">
        <input type="number" id="val-${col}" placeholder="Tamanho (USDT)" value="10" style="font-size:1rem; padding:10px;">
      </div>

      <!-- MÉTRICAS DO RODAPÉ: TAKER RATIO, Δ OI (15m), FUND -->
      <div class="card-footer-metrics">
        <div>Taker: <span id="gauge-taker-${col}" style="color:#FFF; font-weight:bold;">--</span></div>
        <div>Δ OI: <span id="gauge-delta-oi-${col}" style="color:#FFF; font-weight:bold;">--</span></div>
        <div>Fund: <span id="gauge-fund-${col}" style="color:#FFF; font-weight:bold;">--</span></div>
      </div>

      <div class="actions">
        <button class="btn-buy" onclick="execTrade(${col}, 'BUY')">COMPRAR (LONG)</button>
        <button class="btn-sell" onclick="execTrade(${col}, 'SELL')">VENDER (SHORT)</button>
      </div>

      <button onclick="consultarIaManual(${col})" class="btn-ia-advise" style="width:100%; margin-bottom:8px; padding:10px; background:rgba(212,175,55,0.15); border:1px solid var(--gold); color:var(--gold); border-radius:8px; font-size:0.75rem; font-weight:bold; cursor:pointer;">
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
      --bg: #050814;
      --card-bg: #0c0e15;
      --border: rgba(255, 255, 255, 0.08);
      --text: #F8FAFC;
      --text-muted: #64748B;
      --green: #10B981;
      --red: #EF4444;
      --blue: #3B82F6;
      --gold: #D4AF37;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
    body { background-color: var(--bg); color: var(--text); padding: 10px; }
    
    .header-bar { max-width: 1000px; margin: 0 auto 10px; display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.4); border: 1px solid var(--border); padding: 10px 15px; border-radius: 12px; }
    .header-info { display: flex; gap: 15px; align-items: center; }
    .header-btns { display: flex; gap: 8px; }
    .header-btns button { padding: 6px 12px; font-size: 0.75rem; background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text); border-radius: 6px; cursor: pointer; }

    /* CARROSSEL SUPERIOR COM BUG DE TEXTO CORRIGIDO (ETAPA 2) */
    .volatility-bar { max-width: 1000px; margin: 0 auto 10px; display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; scrollbar-width: thin; scrollbar-color: var(--gold) rgba(0,0,0,0.3); }
    .volatility-bar::-webkit-scrollbar { height: 4px; }
    .volatility-bar::-webkit-scrollbar-thumb { background: var(--gold); border-radius: 4px; }
    .vol-item { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 0.75rem; cursor: pointer; transition: 0.2s; }
    .vol-item:hover { border-color: var(--gold); background: rgba(212, 175, 55, 0.1); }
    .vol-item .sym { font-weight: bold; color: var(--text); }
    .vol-item .pct { font-weight: bold; }

    .bot-control-bar { max-width: 1000px; margin: 0 auto 10px; background: rgba(0,0,0,0.35); border: 1px solid var(--border); border-radius: 10px; padding: 10px 15px; display: flex; flex-direction: column; gap: 8px; }
    .bot-control-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; max-width: 1000px; margin: 0 auto; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 14px; padding: 14px; transition: border-color 0.3s; position: relative; }
    .card.active { border-color: rgba(212, 175, 55, 0.5); box-shadow: 0 0 15px rgba(212, 175, 55, 0.05); }

    .input-group { margin-bottom: 8px; }
    .input-group input { width: 100%; background: rgba(0,0,0,0.3); border: 1px solid var(--border); color: var(--gold); font-size: 0.95rem; padding: 8px; border-radius: 6px; outline: none; text-transform: uppercase; text-align: center; font-weight: bold; }
    .price-display { font-size: 1.25rem; text-align: center; margin: 2px 0 8px; font-weight: 200; color: var(--text); letter-spacing: 1px; }

    .mtf-box { background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; }
    .badge-mtf { font-size: 0.65rem; font-weight: bold; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,0.08); color: var(--text-muted); }
    .candles-row { display: flex; justify-content: space-between; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid var(--border); }
    .candle { display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .candle-label { font-size: 0.65rem; color: var(--text-muted); font-weight: 500; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #334155; }
    .dot.green { background: var(--green); box-shadow: 0 0 6px rgba(16, 185, 129, 0.5); }
    .dot.red { background: var(--red); box-shadow: 0 0 6px rgba(239, 68, 68, 0.5); }

    .flow-panel { background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 10px; font-size: 0.75rem; }
    .flow-title { font-size: 0.65rem; color: var(--gold); font-weight: bold; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; border-bottom: 1px solid rgba(212,175,55,0.2); padding-bottom: 4px; }
    .flow-row { display: flex; justify-content: space-between; margin-bottom: 6px; }

    .setup-quality-box { background: rgba(0,0,0,0.2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }

    .risk-proj-box { background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; }

    .range-group { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; background: rgba(0,0,0,0.2); padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); }
    .range-group label { flex: 1; font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; }
    .range-group input[type="range"] { flex: 2; accent-color: var(--gold); }
    .range-group span { font-size: 0.9rem; color: var(--gold); font-weight: bold; width: 30px; text-align: right; }

    .card-footer-metrics { display: flex; justify-content: space-between; font-size: 0.65rem; color: var(--text-muted); margin-bottom: 10px; padding: 0 4px; text-transform: uppercase; }

    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
    button { padding: 12px; border: none; border-radius: 8px; font-size: 0.8rem; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; color: white; cursor: pointer; transition: 0.2s; outline: none; }
    button:active { transform: scale(0.96); }
    .btn-buy { background: linear-gradient(135deg, #059669 0%, #10B981 100%); }
    .btn-sell { background: linear-gradient(135deg, #DC2626 0%, #EF4444 100%); }
    .btn-close { background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%); }
    .btn-reverse { background: linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%); }

    .pos-card { background: rgba(0,0,0,0.4); border: 1px solid var(--border); border-radius: 12px; padding: 12px; margin-bottom: 12px; display: none; }
    .pos-header { display: flex; justify-content: space-between; font-size: 0.8rem; margin-bottom: 5px; }
    .pos-pnl { font-size: 1.2rem; font-weight: bold; text-align: center; margin: 4px 0; }
    .status { text-align: center; font-size: 0.75rem; color: var(--text-muted); min-height: 1.2rem; }

    .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); backdrop-filter: blur(5px); display: none; justify-content: center; align-items: center; z-index: 999; }
    .modal { background: var(--bg); border: 1px solid var(--border); border-radius: 16px; width: 90%; max-width: 600px; max-height: 80vh; overflow-y: auto; padding: 20px; }
    .modal-head { display: flex; justify-content: space-between; margin-bottom: 15px; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
    .day-block { margin-bottom: 12px; background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; border: 1px solid var(--border); }
    .day-title { display: flex; justify-content: space-between; color: var(--gold); margin-bottom: 8px; font-weight: bold; }
    .trade-row { display: flex; justify-content: space-between; font-size: 0.8rem; margin-bottom: 4px; border-bottom: 1px dashed rgba(255,255,255,0.08); padding-bottom: 4px; }

    @media (max-width: 700px) {
      .grid { grid-template-columns: 1fr; }
      .header-bar { flex-direction: column; gap: 8px; text-align: center; }
    }
  </style>
</head>
<body>

  <!-- MODAL DE CONFIRMAÇÃO ESTÉTICO -->
  <div class="modal-overlay" id="modal-confirm">
    <div class="modal" style="max-width: 400px; text-align: center;">
      <h3 id="modal-confirm-title" style="color: var(--gold); margin-bottom: 15px; font-size: 1.2rem;">Confirmação</h3>
      <div id="modal-confirm-body" style="color: var(--text); font-size: 0.95rem; margin-bottom: 25px; line-height: 1.5;"></div>
      <div style="display: flex; gap: 10px; justify-content: center;" id="modal-confirm-actions">
        <button id="modal-btn-cancel" style="flex: 1; padding: 10px; background: rgba(255,255,255,0.1); color: var(--text); border: 1px solid var(--border); border-radius: 8px; font-weight: bold; cursor: pointer;">CANCELAR</button>
        <button id="modal-btn-ok" style="flex: 1; padding: 10px; background: var(--gold); color: #000; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">CONFIRMAR</button>
      </div>
    </div>
  </div>

  <!-- MODAL DE HISTÓRICO -->
  <div class="modal-overlay" id="modal-hist">
    <div class="modal">
      <div class="modal-head">
        <h3 style="color: var(--gold);">Histórico de Ordens</h3>
        <button onclick="fecharHistorico()" style="background:transparent; border:none; color:var(--text-muted); font-size:1.2rem; cursor:pointer;">&times;</button>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; flex-wrap:wrap; gap:10px;">
        <div style="display:flex; gap:6px;">
          <button id="btn-tab-periodo" onclick="mudarAbaHist('periodo')" style="padding:6px 12px; font-size:0.75rem; background:var(--gold); color:#000; border-radius:6px; font-weight:bold; cursor:pointer;">Agrupado</button>
          <button id="btn-tab-hoje" onclick="mudarAbaHist('hoje')" style="padding:6px 12px; font-size:0.75rem; background:rgba(255,255,255,0.08); color:var(--text); border-radius:6px; cursor:pointer;">Hoje</button>
          <button id="btn-tab-todas" onclick="mudarAbaHist('todas')" style="padding:6px 12px; font-size:0.75rem; background:rgba(255,255,255,0.08); color:var(--text); border-radius:6px; cursor:pointer;">Todas</button>
        </div>
      </div>
      <div id="hist-content">Carregando...</div>
    </div>
  </div>

  <div class="header-bar">
    <div class="header-info">
      <div>
        <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Saldo Futuros</div>
        <div style="font-size:1.1rem; font-weight:bold; color:var(--gold);" id="saldo-total">$ 0.00</div>
      </div>
      <div>
        <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Tokens Gastos</div>
        <div style="font-size:0.9rem; font-weight:bold; color:#A78BFA;" id="total-tokens-val">0</div>
      </div>
    </div>
    
    <!-- PLACAR DE TRADES (SEM DOBRADINHA) -->
    <div style="display:flex; align-items:center; gap:8px; background:rgba(0,0,0,0.35); border:1px solid var(--border); padding:5px 10px; border-radius:8px;">
       <span style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Trades:</span>
       <span id="placar-wins" style="font-size:0.85rem; font-weight:bold; color:var(--green); background:rgba(16,185,129,0.15); border:1px solid rgba(16,185,129,0.3); padding:2px 6px; border-radius:5px;">0 W</span>
       <span style="color:var(--text-muted); font-size:0.75rem;">/</span>
       <span id="placar-losses" style="font-size:0.85rem; font-weight:bold; color:var(--red); background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.3); padding:2px 6px; border-radius:5px;">0 L</span>
       <button onclick="zerarPlacar()" style="padding:2px 6px; font-size:0.65rem; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:var(--text-muted); border-radius:4px; margin-left:4px; cursor:pointer;">ZERAR</button>
    </div>

    <div class="header-btns">
      <button onclick="carregarSaldo()">Atualizar</button>
      <button onclick="abrirHistorico()">Histórico</button>
      <button onclick="fazerLogout()">Sair</button>
    </div>
  </div>

  <!-- BARRA DE MOEDAS VOLÁTEIS (FILTRADA E COM CSS CORRIGIDO) -->
  <div class="volatility-bar" id="vol-bar"></div>

  <!-- BARRA DE CONTROLE DO ROBÔ AUTÔNOMO -->
  <div class="bot-control-bar">
    <div class="bot-control-top">
      <div style="display:flex; align-items:center; gap:10px;">
        <button id="btn-auto-toggle" onclick="toggleAutoBot()" style="padding:8px 14px; font-size:0.75rem; border-radius:8px; border:1px solid var(--green); background:rgba(16, 185, 129, 0.2); color:var(--green); cursor:pointer;">
          LIGAR ROBÔ IA
        </button>
        <span id="auto-status-text" style="font-size:0.8rem; color:var(--text-muted); font-weight:bold;">Robô Desligado</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:0.75rem; color:var(--text-muted);">Memória RAG:</span>
        <span id="auto-rag-badge" style="font-size:0.75rem; color:var(--gold); font-weight:bold; background:rgba(212, 175, 55, 0.15); border:1px solid rgba(212, 175, 55, 0.3); padding:2px 8px; border-radius:5px;">0 trades</span>
      </div>
    </div>
    <div style="font-size:0.7rem; color:var(--text-muted); font-family:monospace; background:rgba(0,0,0,0.2); padding:6px 10px; border-radius:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" id="auto-log-text">
      Nenhum evento registrado.
    </div>
  </div>

  <div class="grid">
    ${renderColHTML(1)}
    ${renderColHTML(2)}
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
          saldoGlobal = data.saldo;
          document.getElementById('saldo-total').innerText = '$ ' + saldoGlobal.toFixed(2);
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
            html += \`<div class="vol-item" onclick="aplicarMoeda('\${item.symbol}')">
              <span class="sym">\${item.symbol.replace('USDT','')}</span>
              <span class="pct" style="color:\${cor};">\${sinal}\${pct.toFixed(1)}%</span>
            </div>\`;
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

        // RSI 15m Wilder & Qualidade do Setup
        document.getElementById('rsi-' + col).innerText = data.rsi || '--';
        const trendEl = document.getElementById('trend-' + col);
        trendEl.innerText = data.qualidadeSetup || '--';
        trendEl.style.color = data.qualidadeCor || 'gray';

        // Projeção de Risco
        document.getElementById('proj-alav-' + col).innerText = (data.leverageSugerida || 3) + 'x';
        document.getElementById('proj-sl-' + col).innerText = '$ ' + (data.slPrice ? data.slPrice.toFixed(4) : '--') + ' (-' + (data.slRoe ? data.slRoe.toFixed(1) : '--') + '%)';
        document.getElementById('proj-be-' + col).innerText = '$ ' + (data.beTriggerPrice ? data.beTriggerPrice.toFixed(4) : '--') + ' (+' + (data.beTriggerPctReal ? data.beTriggerPctReal.toFixed(2) : '--') + '%)';
        document.getElementById('proj-tp-' + col).innerText = '$ ' + (data.tpPrice ? data.tpPrice.toFixed(4) : '--') + ' (+' + (data.tpRoe ? data.tpRoe.toFixed(1) : '--') + '%)';

        // Ajusta slider se vazio
        const alavEl = document.getElementById('alav-' + col);
        if (alavEl && !alavEl.dataset.userModified && data.leverageSugerida) {
          alavEl.value = data.leverageSugerida;
          document.getElementById('alav-val-' + col).innerText = data.leverageSugerida + 'x';
        }

        // Posição Aberta
        const posBox = document.getElementById('pos-' + col);
        if (data.pos) {
          posBox.style.display = 'block';
          const p = data.pos;
          const ladoEl = document.getElementById('pos-lado-' + col);
          ladoEl.innerText = p.lado + " " + p.alavancagem + "x";
          ladoEl.className = p.lado === 'LONG' ? 'text-green' : 'text-red';
          document.getElementById('pos-qty-' + col).innerText = "Qty: " + p.quantidade;

          const pnl = p.pnlNaoRealizado;
          const margem = p.margem || ((p.quantidade * p.precoEntrada) / p.alavancagem);
          let roi = margem > 0 ? (pnl / margem) * 100 : 0;
          const sinal = pnl >= 0 ? '+' : '';
          const pnlEl = document.getElementById('pos-pnl-' + col);
          pnlEl.innerHTML = (pnl >= 0 ? "+$ " : "-$ ") + Math.abs(pnl).toFixed(2) + \` (\${sinal}\${roi.toFixed(2)}%)\`;
          pnlEl.className = "pos-pnl " + (pnl >= 0 ? 'text-green' : 'text-red');
          document.getElementById('pos-pnl-brl-' + col).innerText = 'R$ ' + Math.abs(pnl * brlGlobal).toFixed(2);
          document.getElementById('pos-entry-' + col).innerText = p.precoEntrada.toFixed(4);
        } else {
          posBox.style.display = 'none';
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
            takerEl.innerText = tr.toFixed(2) + 'x ' + (tr >= 1 ? '[C]' : '[V]');
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
          const html = \`
            <div style="font-size:1rem; margin-bottom:10px;">Veredito: <b style="color:\${data.decisao === 'LONG' ? 'var(--green)' : (data.decisao === 'SHORT' ? 'var(--red)' : 'var(--gold)')};">\${data.decisao}</b> (\${data.confianca}% confiança)</div>
            <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:15px;">\${data.motivo}</div>
            <div style="font-size:0.8rem; font-family:monospace; background:rgba(0,0,0,0.3); padding:8px; border-radius:6px; text-align:left;">
              <div>• Alavancagem: \${data.alavancagem}x</div>
              <div>• Stop Loss: $ \${data.slPrice?.toFixed(4)}</div>
              <div>• Take Profit: $ \${data.tpPrice?.toFixed(4)}</div>
              <div>• Breakeven: $ \${data.beTriggerPrice?.toFixed(4)}</div>
            </div>
          \`;
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

      const html = \`
        <div style="font-size:1.1rem; margin-bottom:10px;">Ativo: <b style="color:var(--gold);">\${sym}</b></div>
        <div style="font-size:1.1rem; margin-bottom:10px;">Ordem: <b style="color:\${corLado};">\${txtLado}</b></div>
        <div style="font-size:1.1rem; margin-bottom:10px;">Alavancagem: <b style="color:var(--text);">\${alav}x</b></div>
        <div style="font-size:1.1rem; margin-bottom:20px;">Tamanho Total: <b style="color:var(--text);">\${val} USDT</b></div>
      \`;

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

      if (!(await askConfirm('Fechar Posição', \`Deseja encerrar 100% da posição de <b style='color:var(--gold);'>\${sym}</b> a mercado?\`))) return;

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

      if (!(await askConfirm('Reverter Posição', \`Deseja <b style='color:var(--gold);'>REVERTER</b> a posição de \${sym}?\`))) return;

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
        } else {
          st.innerText = "Erro: " + data.error;
          st.style.color = "var(--red)";
        }
      } catch (e) {
        st.innerText = "Erro";
      }
    }

    // ── ROBÔ AUTÔNOMO E PLACAR ──────────────────────────────────────────
    let autoBotActive = false;

    async function carregarPlacar() {
      try {
        const r = await fetch('/api/win-loss');
        const d = await r.json();
        if (d.success) {
          document.getElementById('placar-wins').innerText = d.wins + ' W';
          document.getElementById('placar-losses').innerText = d.losses + ' L';
        }
      } catch(e) {}
    }

    async function zerarPlacar() {
      if (!(await askConfirm('Zerar Placar', 'Deseja reiniciar a contagem de acertos e erros a partir de agora?'))) return;
      try {
        const r = await fetch('/api/limpar-placar', { method: 'POST' });
        const d = await r.json();
        if (d.success) {
          carregarPlacar();
          askConfirm('✓ Sucesso', 'Placar zerado com sucesso.', true);
        }
      } catch(e) {}
    }

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
                  st.style.color = sl.status.startsWith('ATIVO') ? 'var(--green)' : 'var(--gold)';
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
      if (!(await askConfirm(acao + ' ROBÔ', 'Deseja ' + acao.toLowerCase() + ' o robô autônomo com Gatekeeper e gestão de risco 1:2?'))) return;

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

    // ── HISTÓRICO MODAL ────────────────────────────────────────────────
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
          btn.style.fontWeight = 'bold';
        } else {
          btn.style.background = 'rgba(255,255,255,0.08)';
          btn.style.color = 'var(--text)';
          btn.style.fontWeight = 'normal';
        }
      });
      renderizarAbaHistorico();
    }

    async function carregarHistoricoCompleto() {
      const container = document.getElementById('hist-content');
      container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">Carregando histórico Binance...</div>';
      try {
        const res = await fetch('/api/historico-completo');
        const data = await res.json();
        if (!data.success || !data.trades || data.trades.length === 0) {
          container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">Nenhum trade encontrado.</div>';
          return;
        }
        todosTradesCache = data.trades;
        renderizarAbaHistorico();
      } catch(e) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--red);">Erro ao carregar histórico.</div>';
      }
    }

    function renderizarAbaHistorico() {
      const container = document.getElementById('hist-content');
      if (!todosTradesCache || todosTradesCache.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">Sem registros.</div>';
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
        container.innerHTML = renderListaSimples(hojeTrades, 'Hoje');
      } else if (abaAtualHist === 'todas') {
        container.innerHTML = renderListaSimples(groupedArray, 'Todas as Operações');
      } else {
        container.innerHTML = renderAgrupadoPeriodos(groupedArray);
      }
    }

    function renderListaSimples(lista, titulo) {
      if (lista.length === 0) return \`<div style="text-align:center; padding:20px; color:var(--text-muted);">Nenhum trade encontrado em \${titulo}.</div>\`;
      let html = \`<div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:10px;">Exibindo \${lista.length} ordens (\${titulo})</div>\`;
      lista.forEach(g => {
        const cor = g.pnl > 0 ? 'var(--green)' : (g.pnl < 0 ? 'var(--red)' : 'var(--text-muted)');
        const dataStr = new Date(g.time).toLocaleString('pt-BR');
        html += \`
          <div class="trade-row">
            <div>
              <b style="color:var(--text);">\${g.symbol}</b> <span style="font-size:0.7rem; color:\${g.side === 'BUY' ? 'var(--green)' : 'var(--red)'};">\${g.side}</span>
              <div style="font-size:0.65rem; color:var(--text-muted);">\${dataStr}</div>
            </div>
            <div style="text-align:right;">
              <span style="font-weight:bold; color:\${cor};">\${g.pnl >= 0 ? '+' : ''}$ \${g.pnl.toFixed(2)}</span>
              <div style="font-size:0.65rem; color:var(--text-muted);">Taxa: $ \${g.fee.toFixed(4)}</div>
            </div>
          </div>
        \`;
      });
      return html;
    }

    function renderAgrupadoPeriodos(lista) {
      let totWin = 0, totLoss = 0, totPnl = 0, totFee = 0;
      lista.forEach(g => {
        if (g.hasPnl) {
          if (g.pnl > 0) totWin++;
          else if (g.pnl < 0) totLoss++;
          totPnl += g.pnl;
        }
        totFee += g.fee;
      });

      const winRate = (totWin + totLoss) > 0 ? Math.round((totWin / (totWin + totLoss)) * 100) : 0;
      return \`
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
          <div style="background:rgba(0,0,0,0.3); border:1px solid var(--border); padding:10px; border-radius:8px;">
            <div style="font-size:0.7rem; color:var(--text-muted);">Taxa de Acerto Geral</div>
            <div style="font-size:1.2rem; font-weight:bold; color:\${winRate >= 50 ? 'var(--green)' : 'var(--gold)'};">\${winRate}% <span style="font-size:0.8rem; color:var(--text-muted);">(\${totWin}W / \${totLoss}L)</span></div>
          </div>
          <div style="background:rgba(0,0,0,0.3); border:1px solid var(--border); padding:10px; border-radius:8px;">
            <div style="font-size:0.7rem; color:var(--text-muted);">PnL Realizado Líquido</div>
            <div style="font-size:1.2rem; font-weight:bold; color:\${totPnl >= 0 ? 'var(--green)' : 'var(--red)'};">\${totPnl >= 0 ? '+' : ''}$ \${totPnl.toFixed(2)}</div>
          </div>
        </div>
        \${renderListaSimples(lista.slice(0, 30), 'Últimas 30 Ordens')}
      \`;
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
      setInterval(carregarSaldo, 3600000);
      setInterval(carregarVolateis, 60000);
      setInterval(carregarPlacar, 10000);
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
    app.listen(PORT, () => console.log('Painel Quant Institucional rodando na porta ' + PORT));
  } catch (e) {
    console.error("Erro no boot:", e);
  }
})();
