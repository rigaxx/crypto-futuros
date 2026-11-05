const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });
// Sem senha padrão no código: ACESSO_SENHA ausente = painel não sobe.
if (!process.env.ACESSO_SENHA) {
  console.error('[BOOT] ACESSO_SENHA ausente no .env. Defina ACESSO_SENHA para proteger o painel. Encerrando.');
  process.exit(1);
}

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
const SENHA = process.env.ACESSO_SENHA;
const ROUTER_API_KEY = process.env.ROUTER_API_KEY;
const JEV_API_KEY    = process.env.JEV_API_KEY;
const JEV_URL        = 'https://api.typesafe.ai/v1/systemone';

// Inicializa banco de dados RAG local
rag.initRagDb().catch(e => console.error('[RAG] Erro ao iniciar:', e.message));

// Autenticação HTTP Basic
app.use((req, res, next) => {
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
const BASE_CAPITAL_FILE = path.join(__dirname, '.base_capital_ref.json');

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

const MAX_SLOTS = 2;
const MARGEM_POR_SLOT = 10.0;
const BASE_CAPITAL_SLOTS = MAX_SLOTS * MARGEM_POR_SLOT; // 20.00 USDT
let saldoReferenciaCiclo = 0;
let baseCapitalReferencia = BASE_CAPITAL_SLOTS;
try {
  if (fs.existsSync(BASE_CAPITAL_FILE)) {
    const b = JSON.parse(fs.readFileSync(BASE_CAPITAL_FILE, 'utf8'));
    if (b && parseFloat(b.saldoReferenciaCiclo) > 0) saldoReferenciaCiclo = parseFloat(b.saldoReferenciaCiclo);
    else if (b && parseFloat(b.baseCapital) > 0) saldoReferenciaCiclo = parseFloat(b.baseCapital);
  }
} catch(e) {}


// ── BLOCO 2.1: FUSO HORÁRIO OFICIAL DO BRASIL (UTC-3) ──
function formatarDataBrasil(ts = Date.now()) {
  const t = typeof ts === 'number' ? ts : (parseInt(ts, 10) || Date.now());
  return new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function getInicioHojeBrasil() {
  const spDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return new Date(spDateStr + 'T00:00:00-03:00').getTime();
}

// ── BLOCO 3.1: GRUPO FIXO DE MOEDAS DE ALTA LIQUIDEZ (WHITELIST VIP - 22 PARES) ──
const WHITELIST_VIP = new Set([
  'ENAUSDT', 'ORDERUSDT', 'XNYUSDT', 'INJUSDT', 'NEARUSDT',
  'TAUSDT', 'SOLUSDT', 'SUIUSDT', 'FETUSDT',
  'PENDLEUSDT', 'SEIUSDT', 'LINKUSDT', 'AAVEUSDT',
  'DOGEUSDT', 'ORDIUSDT', 'ARKUSDT', 'PHAUSDT',
  'LUMIAUSDT', 'ONDOUSDT', 'AVAXUSDT', 'QNTUSDT', 'APTUSDT'
]);

// ── BLOCO 3.2: CACHE DE ALINHAMENTO COM O BTCUSDT (0 TOKENS) ──

// Invalidação precoce (audit 44 trades: 9/13 SL nunca passaram de +0.5% MFE): sem tração em 20m e ROI <= -2.0% → sai antes do SL cheio



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

const closedTradeEvents = new Map(); // symbol -> timestamp para travar duplicidades atômicas

// BLOCO 1: Quarentena Anti-Revanche Pós-Loss de 1 Hora (60m)
const LOSS_COOLDOWN_FILE = '/var/www/crypto/.symbol_loss_cooldown.json';
let symbolLossCooldown = {};
try {
  if (fs.existsSync(LOSS_COOLDOWN_FILE)) {
    symbolLossCooldown = JSON.parse(fs.readFileSync(LOSS_COOLDOWN_FILE, 'utf8'));
  }
} catch (e) {}

function salvarLossCooldown() {
  try {
    fs.writeFileSync(LOSS_COOLDOWN_FILE, JSON.stringify(symbolLossCooldown, null, 2));
  } catch(e) {}
}

function registrarDesfechoTrade(symbol, exitReason, roi, pnlUsdt, alvoContext = null) {
  if (!symbol) return;
  if (exitReason === 'SCALP_DESCONHECIDO') return; // scalp sem desfecho conhecido: fora do placar
  const agora = Date.now();
  const ultimoReg = closedTradeEvents.get(symbol);
  if (ultimoReg && (agora - ultimoReg) < 15000) {
    console.log(`[PLACAR-IGNORADO] Desfecho duplicado bloqueado para ${symbol} (${exitReason}) - já registrado há ${agora - ultimoReg}ms.`);
    return;
  }
  closedTradeEvents.set(symbol, agora);
  for (const [s, t] of closedTradeEvents.entries()) {
    if (agora - t > 60000) closedTradeEvents.delete(s);
  }

  const pnlNum = parseFloat(pnlUsdt) || 0;
  const roiNum = parseFloat(roi) || 0;

  // BLOCO 2.2: Contabilidade Real Unificada (50% Parcial + 50% Fechamento)
  const pnlParcialLiq = alvoContext?.pnlParcialLiquido || 0;
  const taxaParcial = alvoContext?.taxaParcial || 0;
  const taxaEstimadaFinal = 0.04;
  // scalp_1m informa o líquido REAL do testnet (taxas maker/taker de cada perna); os demais seguem com a taxa estimada fixa
  const liqReal = alvoContext?.pnlLiquidoReal;
  const temLiqReal = typeof liqReal === 'number' && Number.isFinite(liqReal);
  const pnlLiquidoFinal = temLiqReal ? liqReal : pnlNum - taxaEstimadaFinal;
  const pnlLiquidoTotal = pnlLiquidoFinal + pnlParcialLiq;
  const pnlBrutoTotal = pnlNum + (alvoContext?.pnlParcialBruto || 0);

  const isWin = temLiqReal ? pnlLiquidoTotal > 0 : (pnlLiquidoTotal > 0 && (roiNum > 0.05 || pnlLiquidoTotal > 0.01)); // scalp: W = líquido real > 0
  if (isWin) {
    placarStats.wins = (placarStats.wins || 0) + 1;
  } else if (String(exitReason).startsWith('SCALP_')) {
    placarStats.losses = (placarStats.losses || 0) + 1; // scalp_1m: sem quarentena 1h (não trava o PSAR na mesma moeda)
  } else {
    placarStats.losses = (placarStats.losses || 0) + 1;
    symbolLossCooldown[symbol] = Date.now() + 1 * 60 * 60 * 1000; // 60m (1 hora) de quarentena anti-revanche
    salvarLossCooldown();
    console.log(`[COOLDOWN-POS-LOSS-1H] ${symbol} registrou LOSS (${exitReason} | ROI ${roiNum.toFixed(2)}%). Quarentena anti-revanche ativada por 60 minutos (1h).`);
  }
  placarStats.total = (placarStats.wins || 0) + (placarStats.losses || 0);
  salvarPlacarStats();
  console.log(`[PLACAR-ATUALIZADO] ${symbol} -> ${isWin ? 'WIN (Vencedor)' : 'LOSS (Perdedor)'} (${exitReason}) | PnL Bruto Total: $${pnlBrutoTotal.toFixed(2)} | PnL Líq Total: $${pnlLiquidoTotal.toFixed(2)} (Parcial: +$${pnlParcialLiq.toFixed(2)}) | ROI: ${roiNum.toFixed(2)}% | Total: ${placarStats.wins}W / ${placarStats.losses}L`);
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
  let atual = {};
  try { atual = JSON.parse(fs.readFileSync(AUTOBOT_FILE, 'utf8')) || {}; } catch(e){} // preserva SCALP_1M_ENABLED
  try { fs.writeFileSync(AUTOBOT_FILE, JSON.stringify({ ...atual, enabled: autoBotState.enabled }, null, 2)); } catch(e){}
}

let cooldownMoeda = {};

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

const BLOQUEADOS_SYNTHETIC = ['SAMSUNG', 'COIN', 'SOXL', 'MVLL', 'QNTX', 'TSLA', 'AAPL', 'NVDA', 'HEMI', 'ZECUSDT'];

function isSimboloValido(symbol) {
  if (!symbol || typeof symbol !== 'string') return false;
  if (!symbol.match(/^[A-Z0-9]+USDT$/)) return false;
  if (!WHITELIST_VIP.has(symbol)) return false;
  if (BLOQUEADOS_SYNTHETIC.some(b => symbol.startsWith(b))) return false;
  if (symbolLossCooldown && symbolLossCooldown[symbol] && Date.now() < symbolLossCooldown[symbol]) return false;
  const f = fut.filtrosDe(symbol);
  if (!f) return false;
  if (!f.stepSize || !(f.minQty >= 0)) return false;
  return true;
}

// ── FILTRO DE LIQUIDEZ E QUALIDADE (ETAPA 2) ──────────────────────────
async function validarLiquidezMoeda(symbol) {
  try {
    if (!isSimboloValido(symbol)) {
      return { ok: false, motivo: 'SIMBOLO_INVALIDO_OU_SINTETICO' };
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

    // 1. Veto de Spread Largo (> 0.16% - BLOCO 3.1)
    const spreadPct = ((ask - bid) / bid) * 100;
    if (spreadPct > 0.16) {
      return { ok: false, motivo: `[VETO-SLIPPAGE: SPREAD LARGO] (${spreadPct.toFixed(3)}% > 0.16%)` };
    }

    // 2. Veto de "Moeda de 1 Tick Grosso" (> 0.08% do preço)
    const f = fut.filtrosDe(symbol);
    let tickSize = f ? parseFloat(f.tickSize) : 0;
    if (!(tickSize > 0) && (book.bids.length >= 2 || book.asks.length >= 2)) {
      const diffBid = book.bids.length >= 2 ? Math.abs(parseFloat(book.bids[0][0]) - parseFloat(book.bids[1][0])) : 0;
      const diffAsk = book.asks.length >= 2 ? Math.abs(parseFloat(book.asks[1][0]) - parseFloat(book.asks[0][0])) : 0;
      tickSize = Math.max(diffBid, diffAsk);
    }
    const tickPct = (tickSize / bid) * 100;
    if (tickPct > 0.08) {
      return { ok: false, motivo: `[VETO-TICK-GROSSO] (1 tick = ${tickPct.toFixed(3)}% > 0.08%)` };
    }

    // 3. Liquidez Mínima nos Top 5 Níveis do Book (>= $150 USDT em até 0.15%)
    let volAsksTop5 = 0;
    const maxAskPrice = ask * 1.0015;
    for (const item of (book.asks || []).slice(0, 5)) {
      const p = parseFloat(item[0]);
      const q = parseFloat(item[1]);
      if (p <= maxAskPrice) volAsksTop5 += (p * q);
    }

    let volBidsTop5 = 0;
    const minBidPrice = bid * (1 - 0.0015);
    for (const item of (book.bids || []).slice(0, 5)) {
      const p = parseFloat(item[0]);
      const q = parseFloat(item[1]);
      if (p >= minBidPrice) volBidsTop5 += (p * q);
    }

    if (volAsksTop5 < 150 || volBidsTop5 < 150) {
      return {
        ok: false,
        motivo: `[VETO-LIQUIDEZ-BOOK] Top 5 níveis com < $150 USDT em 0.15% (Asks: $${volAsksTop5.toFixed(0)}, Bids: $${volBidsTop5.toFixed(0)})`
      };
    }

    let flatCandles = 0;
    for (const k of klines5m) {
      const o = parseFloat(k[1]), h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]), v = parseFloat(k[5]);
      if (o === c || h === l || v === 0) flatCandles++;
    }
    if (flatCandles >= 3) {
      return { ok: false, motivo: `ZUMBI (${flatCandles} velas 0%)` };
    }

    return { ok: true, oiVal, spreadPct, tickPct, volAsksTop5, volBidsTop5, flatCandles };
  } catch(e) {
    return { ok: false, motivo: e.message };
  }
}







// ── MONITORAMENTO DE RISCO EM CÓDIGO (1.5s - 0 Tokens, 0ms Delay) ─────
let isMonitoringTick = false;
const closingInProgress = new Set();
const closingStartedAt = {};



// ══════════════════════════════════════════════════════════════════════
// MOTOR PARABOLIC SAR 1M + ESQUELETO DA MOEDA (JEV-AI)
// Slot livre → rank de volatilidade → trava a moeda → espera a VIRADA do SAR (2ª bolinha 1m)
// → janela de 20s (JEV decide; fallback 0 token) → entrada → surfa o SAR → sai só quando o SAR vira contra.
// SEM Take Profit fixo. A IA NÃO é consultada com ordem aberta.
// ══════════════════════════════════════════════════════════════════════
const sarEngine = require('./lib/sarEngine');

const ALAV_PADRAO = 3;
const JANELA_DECISAO_MS = 20000;
const SLOT_LOCK_TIMEOUT_MS = 30 * 60 * 1000;  // destrava por ausência de virada do SAR
const COOLDOWN_SAR_VIRADA_MS = 5000;           // recompra imediata da moeda após virada do SAR
const BE_ATIVA_ROI = 3.00;                     // pico de ROI que arma o breakeven
const BE_PISO_ROI = 1.50;                      // piso de ROI do breakeven
const LIMITE_SAIDA_ESPERA_MS = 5000;           // espera da ordem Limite de saída antes do fallback Market
const slInicialRoi = (alav) => -(5 + (alav || ALAV_PADRAO)); // SL inicial = -(5 + alavancagem)% ROI
const SAIDA_SAR_TICKS = 2;            // leituras consecutivas com o SAR contra a posição (anti-pavio)
const RANK_TTL_MS = 60000;
const KLINES_TTL_MS = 1500;
const FLIP_PROCESSADO = {};            // symbol -> flipCandleTime já tratado (uma decisão por virada)
const slotEmDecisao = { 1: false, 2: false }; // mutex da janela de 20s (impede entrada duplicada)
const esqueletoSlot = { 1: null, 2: null };
const saidaSarTicks = {};
const klines1mCache = {};
let rankCache = { ts: 0, lista: [] };

async function klines1m(sym, ttl = KLINES_TTL_MS) {
  const c = klines1mCache[sym];
  if (c && Date.now() - c.ts < ttl) return c.data;
  const data = await fut.klines(sym, '1m', sarEngine.KLINES_LIMIT);
  klines1mCache[sym] = { ts: Date.now(), data };
  return data;
}

async function atualizarEsqueleto(slotNum, sym, statusSlot) {
  const ks = await klines1m(sym).catch(() => null);
  const esq = sarEngine.construirEsqueleto(slotNum, sym, ks, { statusSlot });
  if (esq) esqueletoSlot[slotNum] = esq;
  return esq;
}

// Ranking de volatilidade real (amplitude 15m recente + movimento recente + volume), cache 60s.
async function rankearVolateis() {
  const now = Date.now();
  if (now - rankCache.ts < RANK_TTL_MS && rankCache.lista.length) return rankCache.lista;
  try {
    const tickers = await fut.ticker24h().catch(() => []);
    const base = tickers
      .filter(t => WHITELIST_VIP.has(t.symbol) && isSimboloValido(t.symbol))
      .map(t => ({ symbol: t.symbol, qv: parseFloat(t.quoteVolume || 0), p24: Math.abs(parseFloat(t.priceChangePercent || 0)) }))
      .filter(t => t.qv > 0)
      .sort((a, b) => b.p24 - a.p24)
      .slice(0, 10);
    const lista = [];
    for (const t of base) {
      const ks = await fut.klines(t.symbol, '15m', 16).catch(() => null);
      if (!ks || ks.length < 8) continue;
      const amp = ks.map(k => ((parseFloat(k[2]) - parseFloat(k[3])) / parseFloat(k[4])) * 100);
      const ampMedia = amp.reduce((a, b) => a + b, 0) / amp.length;
      const c4 = ks.slice(-5);
      const var4 = Math.abs((parseFloat(c4[4][4]) - parseFloat(c4[0][1])) / parseFloat(c4[0][1])) * 100;
      const volFator = Math.sqrt(Math.min(1, t.qv / 2e7));
      lista.push({ symbol: t.symbol, ampMedia15m: ampMedia, var4Velas: var4, score: (ampMedia + 0.5 * var4) * volFator });
    }
    lista.sort((a, b) => b.score - a.score);
    rankCache = { ts: now, lista };
    return lista;
  } catch (e) {
    return rankCache.lista;
  }
}

function moedaLivreParaTravar(sym, now, slotNum) {
  const outro = autoBotState.slots[slotNum === 1 ? 2 : 1];
  if (outro.symbol === sym || outro.targetSymbol === sym) return false;
  if (localAlvos[sym]) return false;
  if (symbolLossCooldown && symbolLossCooldown[sym] && now < symbolLossCooldown[sym]) return false;
  if (cooldownMoeda[sym] && now < cooldownMoeda[sym]) return false;
  return true;
}

// Janela de decisão: JEV (tipado) responde LONG/SHORT/WAIT; se falhar/atrasar, vale a confirmação local (0 token).
async function decidirEntradaSar(esq) {
  const dirSar = sarEngine.direcaoDoSar(esq);
  const local = sarEngine.confirmacaoLocal(esq);
  if (!JEV_API_KEY) return { dir: local.ok ? dirSar : 'WAIT', fonte: 'LOCAL', conf: local.ok ? 60 : 0, motivo: local.motivo };
  try {
    const resp = await axios.post(JEV_URL, {
      model: 'jev-latest',
      state: esq,
      questions: {
        acao: {
          type: 'choice',
          instructions: 'Binance Futures scalp on 1-minute Parabolic SAR flip. The SAR just flipped (2nd consecutive dot). Approve only when EMA9, EMA21 and RSI14 slopes confirm the flip direction. Reject exhausted RSI (>80 long / <20 short) or flat lines.',
          criteria: {
            LONG: 'SAR below price (ABAIXO) after flip; EMA9 rising, EMA21 not falling, RSI14 rising and < 80.',
            SHORT: 'SAR above price (ACIMA) after flip; EMA9 falling, EMA21 not rising, RSI14 falling and > 20.',
            WAIT: 'Lines do not confirm the flip, RSI exhausted, or flip looks like noise.'
          }
        }
      }
    }, { headers: { 'Authorization': `Bearer ${JEV_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 8000, maxRedirects: 0 });
    if (resp.data?.usage) registrarUsoTokens({ prompt_tokens: resp.data.usage.input_tokens || 0, completion_tokens: resp.data.usage.output_tokens || 0, total_tokens: (resp.data.usage.input_tokens || 0) + (resp.data.usage.output_tokens || 0) });
    const ans = resp.data?.answers?.acao;
    const choice = String(ans?.choice || '').toUpperCase();
    const conf = Math.round((Number(ans?.confidence) || 0) * 100);
    if (['LONG', 'SHORT', 'WAIT'].includes(choice)) {
      const aprovado = choice === dirSar && conf >= 65;
      return { dir: aprovado ? choice : 'WAIT', fonte: 'JEV', conf, motivo: `JEV ${choice} ${conf}%` };
    }
  } catch (e) {
    console.error(`[JEV-SAR] ${esq.symbol}: ${e.message} — fallback local`);
  }
  return { dir: local.ok ? dirSar : 'WAIT', fonte: 'LOCAL', conf: local.ok ? 60 : 0, motivo: local.motivo };
}

// Execução maker/limit-chase com vetos de spread, tick grosso e liquidez do book. Retorna {ok, preco, qty, motivo}.
async function executarEntradaSar(sym, dir, alav) {
  if (!autoBotState.enabled) return { ok: false, motivo: 'PSAR desligado (enabled:false): ordem não enviada' }; // guarda: robô desligado durante a janela
  const ladoTrade = dir === 'LONG' ? 'BUY' : 'SELL';
  const posAtual = await fut.posicao(sym).catch(() => null);
  if (posAtual && posAtual.quantidade > 0) return { ok: false, motivo: 'posição já existe' };
  await fut.garantirAlavancagem(sym, alav, 'ISOLATED');
  const book = await fut.livroOfertas(sym, 5);
  const bestBid = parseFloat((book?.bids?.[0] || [])[0]);
  const bestAsk = parseFloat((book?.asks?.[0] || [])[0]);
  if (!bestBid || !bestAsk) return { ok: false, motivo: 'book vazio' };

  const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
  if (spreadPct > 0.16) return { ok: false, motivo: `spread ${spreadPct.toFixed(3)}% > 0.16%` };

  const f = fut.filtrosDe(sym);
  let tick = f ? parseFloat(f.tickSize) : 0;
  if (!(tick > 0) && (book?.bids || []).length >= 2) tick = Math.abs(parseFloat(book.bids[0][0]) - parseFloat(book.bids[1][0]));
  if ((tick / bestBid) * 100 > 0.08) return { ok: false, motivo: 'tick grosso > 0.08%' };

  let volBook = 0;
  const lado = ladoTrade === 'BUY' ? (book.asks || []) : (book.bids || []);
  const limite = ladoTrade === 'BUY' ? bestAsk * 1.0015 : bestBid * 0.9985;
  for (const [p, q] of lado.slice(0, 5)) {
    const pp = parseFloat(p);
    if (ladoTrade === 'BUY' ? pp <= limite : pp >= limite) volBook += pp * parseFloat(q);
  }
  if (volBook < 150) return { ok: false, motivo: `liquidez book $${volBook.toFixed(0)} < $150` };

  const precoExec = ladoTrade === 'BUY' ? bestAsk : bestBid;
  const calc = fut.calcularQuantidade(sym, MARGEM_POR_SLOT, precoExec, alav);
  if (!calc.ok) return { ok: false, motivo: `qty: ${calc.motivo}` };

  let ord = await fut.colocarLimite(sym, ladoTrade, calc.qty, precoExec);
  await new Promise(r => setTimeout(r, 1200));
  try { await fut.cancelarOrdem(sym, ord.orderId); } catch (e) {}
  let st = await fut.consultarOrdem(sym, ord.orderId).catch(() => null);
  let filled = st ? (parseFloat(st.executedQty) || 0) : -1;
  let precoFinal = precoExec;
  if (filled < 0) { // consulta falhou: a Binance é a fonte da verdade
    const pr = await fut.posicao(sym).catch(() => null);
    filled = pr && pr.quantidade > 0 ? pr.quantidade : 0;
  }
  if (filled === 0) {
    const book2 = await fut.livroOfertas(sym, 5);
    const p2 = parseFloat(ladoTrade === 'BUY' ? (book2.asks[0] || [])[0] : (book2.bids[0] || [])[0]);
    if (p2 && Math.abs(p2 - precoExec) / precoExec <= 0.003) {
      const ord2 = await fut.colocarLimite(sym, ladoTrade, calc.qty, p2);
      await new Promise(r => setTimeout(r, 1200));
      try { await fut.cancelarOrdem(sym, ord2.orderId); } catch (e) {}
      st = await fut.consultarOrdem(sym, ord2.orderId).catch(() => null);
      filled = st ? (parseFloat(st.executedQty) || 0) : 0;
      if (!st) { const pr2 = await fut.posicao(sym).catch(() => null); filled = pr2 && pr2.quantidade > 0 ? pr2.quantidade : 0; }
      precoFinal = p2;
    }
  }
  if (filled <= 0) return { ok: false, motivo: 'não preencheu' };
  return { ok: true, preco: precoFinal, qty: filled };
}

// Saída: Limite passivo (espera 5s) -> o que sobrar vai a Market reduceOnly.
async function fecharLimiteComFallback(sym, ladoPos, qty) {
  const ladoOrd = ladoPos === 'LONG' ? 'SELL' : 'BUY';
  try {
    const book = await fut.livroOfertas(sym, 5);
    const preco = parseFloat(ladoPos === 'LONG' ? (book.asks[0] || [])[0] : (book.bids[0] || [])[0]);
    if (preco > 0) {
      const ord = await fut.colocarLimite(sym, ladoOrd, qty, preco, { reduceOnly: true });
      const fim = Date.now() + LIMITE_SAIDA_ESPERA_MS;
      while (Date.now() < fim) {
        await new Promise(r => setTimeout(r, 500));
        const st = await fut.consultarOrdem(sym, ord.orderId).catch(() => null);
        if (st && st.status === 'FILLED') return;
      }
      try { await fut.cancelarOrdem(sym, ord.orderId); } catch (e) {}
    }
  } catch (e) {
    console.warn(`[SAIDA-LIMITE] ${sym}: ${e.message} -> fallback Market`);
  }
  const pr = await fut.posicao(sym).catch(() => null);
  if (pr && pr.quantidade > 0) await fut.fecharMercado(sym, ladoPos, pr.quantidade);
}

function registrarPosicaoSar(sym, dir, alav, exec, esq, slotNum) {
  const isLong = dir === 'LONG';
  const slPrice = exec.preco * (1 + (isLong ? 1 : -1) * (slInicialRoi(alav) / alav) / 100);
  localAlvos[sym] = {
    side: dir,
    entryPrice: exec.preco,
    slPrice,                       // apenas rede de emergência; NÃO existe TP
    leverage: alav,
    quantidade: exec.qty,
    maxRoiReached: 0,
    minRoiReached: 0,
    openTime: Date.now(),
    slot: slotNum,
    sarEntrada: esq.sar1m,
    sarLabel: '[🏄 SURFANDO SAR 1m]',
    parcialExecutada: false,
    pnlParcialBruto: 0,
    pnlParcialLiquido: 0,
    taxaParcial: 0,
    fechando: false,
    fechandoDesde: 0
  };
  salvarAlvos();
  (async () => {
    for (let t = 1; t <= 3; t++) {
      try { await fut.colocarStopLoss(sym, dir, slPrice); localAlvos[sym] && (localAlvos[sym].slNaCorretora = true); return; }
      catch (e) { console.error(`[SL-EMERGENCIA] ${sym} tentativa ${t}/3: ${e.message}`); await new Promise(r => setTimeout(r, 800)); }
    }
    console.error(`[SL-EMERGENCIA] ${sym}: SEM stop na corretora; vale só o monitor de ${slInicialRoi(alav)}% ROI`);
  })();
}

let autoBotLoopRunning = false;
setInterval(async () => {
  if (!autoBotState.enabled || autoBotLoopRunning) return;
  autoBotLoopRunning = true;
  try {
    const now = Date.now();
    for (const slotNum of [1, 2]) {
      const slot = autoBotState.slots[slotNum];

      // Posição aberta: o monitor de 1,5s cuida do SAR; aqui só confere se a posição ainda existe.
      if (slot.symbol) {
        const pos = await fut.posicao(slot.symbol).catch(() => undefined);
        if (pos !== undefined && (!pos || pos.quantidade === 0)) {
          slot.symbol = null; slot.targetSymbol = null; slot.side = null; slot.status = 'LIVRE';
          esqueletoSlot[slotNum] = null;
        } else if (esqueletoSlot[slotNum]) {
          esqueletoSlot[slotNum].statusSlot = 'POSICAO_ABERTA_SURFANDO_SAR';
          slot.status = `[POSIÇÃO ATIVA] ${slot.symbol} (${slot.side} ${slot.leverage}x) — SURFANDO SAR`;
        }
        continue;
      }
      if (slotEmDecisao[slotNum]) continue;
      if (slot.searchCooldownUntil && now < slot.searchCooldownUntil) {
        slot.status = `[COOLDOWN PÓS-SAÍDA] Aguardando ${Math.round((slot.searchCooldownUntil - now) / 1000)}s`;
        continue;
      }

      // 1. Slot sem moeda: ranking de volatilidade e TRAVA
      if (!slot.targetSymbol) {
        const rank = await rankearVolateis();
        const escolhida = rank.find(r => moedaLivreParaTravar(r.symbol, now, slotNum));
        if (!escolhida) { slot.status = 'ESCANEANDO_VOLATILIDADE'; esqueletoSlot[slotNum] = null; continue; }
        const liq = await validarLiquidezMoeda(escolhida.symbol).catch(() => ({ ok: false }));
        if (!liq.ok) { cooldownMoeda[escolhida.symbol] = now + 10 * 60000; continue; }
        slot.targetSymbol = escolhida.symbol;
        slot.lockSince = now;
        console.log(`[SLOT-LOCK] Slot ${slotNum} travou ${escolhida.symbol} (score ${escolhida.score.toFixed(3)} | amp15m ${escolhida.ampMedia15m.toFixed(2)}%)`);
      }

      const sym = slot.targetSymbol;
      if (now - (slot.lockSince || now) > SLOT_LOCK_TIMEOUT_MS) {
        console.log(`[SLOT-LOCK] Slot ${slotNum} soltou ${sym}: sem virada em ${SLOT_LOCK_TIMEOUT_MS / 60000}min`);
        cooldownMoeda[sym] = now + 2 * 60000;
        slot.targetSymbol = null; slot.status = 'ESCANEANDO_VOLATILIDADE'; esqueletoSlot[slotNum] = null;
        continue;
      }

      // 2. Monta/atualiza o esqueleto 1m e espera a virada
      const esq = await atualizarEsqueleto(slotNum, sym, 'AGUARDANDO_VIRADA_SAR');
      if (!esq) { slot.status = 'ERRO_KLINES_1M'; continue; }
      slot.status = `[TOCAIA SAR 1m] ${sym} SAR ${esq.sar1m.posicaoAtual} (${esq.sar1m.bolinhasConsecutivas} bolinha(s))`;
      if (!esq.sar1m.virouAgora || FLIP_PROCESSADO[sym] === esq.sar1m.flipCandleTime) continue;

      // 3. JANELA DE DECISÃO 20s (uma por virada)
      FLIP_PROCESSADO[sym] = esq.sar1m.flipCandleTime;
      slotEmDecisao[slotNum] = true;
      esq.statusSlot = 'JANELA_DECISAO_20S';
      esqueletoSlot[slotNum] = esq;
      slot.status = `[JANELA 20s] ${sym} virou SAR ${esq.sar1m.posicaoAtual} — consultando JEV`;
      try {
        const limite = new Promise(r => setTimeout(() => r(null), JANELA_DECISAO_MS));
        let dec = await Promise.race([decidirEntradaSar(esq), limite]);
        if (!dec) {
          const loc = sarEngine.confirmacaoLocal(esq);
          dec = { dir: loc.ok ? sarEngine.direcaoDoSar(esq) : 'WAIT', fonte: 'LOCAL_TIMEOUT', conf: 60, motivo: loc.motivo };
        }
        if (dec.dir !== 'LONG' && dec.dir !== 'SHORT') {
          console.log(`[SAR-RECUSA] ${sym} (${dec.fonte}): ${dec.motivo}`);
          autoBotState.lastLog = `Slot ${slotNum} (${sym}): virada recusada — ${dec.motivo}`;
          continue; // mantém a trava, aguarda a próxima virada
        }
        // Revalida a virada antes de enviar a ordem (evita repintura do candle em formação)
        const esq2 = await atualizarEsqueleto(slotNum, sym, 'EXECUTANDO_ENTRADA');
        if (!esq2 || sarEngine.direcaoDoSar(esq2) !== dec.dir) {
          console.log(`[SAR-REPINTURA] ${sym}: SAR mudou durante a janela. Entrada abortada.`);
          continue;
        }
        slot.status = `[EXECUTANDO ENTRADA] ${sym} ${dec.dir}`;
        const alav = ALAV_PADRAO;
        const exec = await executarEntradaSar(sym, dec.dir, alav);
        if (!exec.ok) {
          console.log(`[SAR-ENTRADA-FALHOU] ${sym}: ${exec.motivo}`);
          slot.status = `[ENTRADA FALHOU: ${exec.motivo}]`;
          if (exec.motivo.startsWith('spread') || exec.motivo.startsWith('tick') || exec.motivo.startsWith('liquidez') || exec.motivo.startsWith('qty')) {
            cooldownMoeda[sym] = now + 5 * 60000; slot.targetSymbol = null; esqueletoSlot[slotNum] = null;
          }
          continue;
        }
        slot.symbol = sym; slot.side = dec.dir; slot.leverage = alav; slot.openTime = Date.now();
        registrarPosicaoSar(sym, dec.dir, alav, exec, esq2, slotNum);
        esq2.statusSlot = 'POSICAO_ABERTA_SURFANDO_SAR';
        esqueletoSlot[slotNum] = esq2;
        slot.status = `[ATIVO: ${sym} ${dec.dir} ${alav}x] SURFANDO SAR`;
        console.log(`[ORDEM-EXECUTADA] Slot ${slotNum} (${sym}): ${dec.dir} ${alav}x a ${formatarPrecoAtivo(sym, exec.preco)} | Qty ${exec.qty} | ${dec.fonte} ${dec.conf}% | SEM TP — saída na virada do SAR`);
        await rag.salvarEntradaRAG({
          symbol: sym, side: dec.dir, leverage: alav, mode: 'SAR_1M_FLIP', scoreTotal: dec.conf,
          rsi15m: 50, rsi1m: esq2.linhasConfirmacao1m.rsi14_valor,
          emaStatus: `EMA9 ${esq2.linhasConfirmacao1m.ema9_inclinacao} / EMA21 ${esq2.linhasConfirmacao1m.ema21_inclinacao}`,
          sarStatus: `SAR1m ${esq2.sar1m.posicaoAtual}`,
          volRatio: 0, fundingRate: 0, bookRatio: 0, fiboPos: '--', patterns: ['SAR_FLIP_1M'],
          aiThesis: dec.motivo, entryPrice: exec.preco,
          dadosMercado: { rsi: 50, rsi1m: esq2.linhasConfirmacao1m.rsi14_valor, emaStatus: esq2.linhasConfirmacao1m.ema9_inclinacao, sarTendencia: esq2.sar1m.posicaoAtual, volRatio: 0, fundingRate: 0, longPct: 0, fiboPos: '--', padroesDetectados: ['SAR_FLIP_1M'], preco: exec.preco }
        }).catch(() => {});
        autoBotState.lastLog = `Slot ${slotNum}: Entrou ${dec.dir} em ${sym} (${alav}x) na virada do SAR 1m. ${dec.motivo}`;
      } catch (e) {
        console.error(`[SAR-JANELA] ${sym}: ${e.message}`);
      } finally {
        slotEmDecisao[slotNum] = false;
      }
    }
  } catch (e) {
    console.error('[AUTOBOT-LOOP] Erro:', e.message);
  } finally {
    autoBotLoopRunning = false;
  }
}, 3000);

// ── MODO SCALP_1M (slots 3/4, sinal mainnet, execução FAPI) — lib/scalp1m.js ──
const scalpLib = require('./lib/scalp1m');
const mainnetFeed = require('./lib/mainnetFeed');
const scalp1m = scalpLib.criarMotor({
  fut, rag, localAlvos, salvarAlvos, closingInProgress, registrarDesfechoTrade,
  feed: mainnetFeed.criarFeed([]), // universo dinâmico: o motor assina/desassina a cada ranking (15 min)
  rest: mainnetFeed.rest,
  simboloOcupadoPsar: (sym) => [1, 2].some(n => autoBotState.slots[n].symbol === sym || autoBotState.slots[n].targetSymbol === sym),
  configFile: AUTOBOT_FILE,
  logFile: path.join(__dirname, 'logs', 'scalp_1m_decisoes.jsonl'),
  jevKey: JEV_API_KEY, // decisão de compra/venda das 2 escolhidas, 3 s antes da fronteira (sem chave: vale a direção do código)
  jevUrl: JEV_URL,
  marcoZero: () => marcoZero, // ZERAR: contadores do scalp ignoram o que veio antes do marco
  onUsage: (u) => registrarUsoTokens({ prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) }),
  baseOrdens: fut.FAPI // trava: scalp só opera se a base de ordens for testnet
});

// ── MONITOR DE POSIÇÃO ABERTA (1,5s, 0 token): surfa o SAR; sai só na virada contra / emergência / funding ──
setInterval(async () => {
  if (isMonitoringTick) return;
  isMonitoringTick = true;
  try {
    const agoraWd = Date.now();
    for (const sym of Object.keys(localAlvos)) {
      const a = localAlvos[sym];
      if (a && a.modo !== 'scalp_1m' && a.fechando && agoraWd - (a.fechandoDesde || 0) > 10000) {
        console.warn(`[WATCHDOG-FECHANDO] Resetando trava presa em ${sym}`);
        a.fechando = false; closingInProgress.delete(sym); delete closingStartedAt[sym];
      }
    }
    for (const sym of Array.from(closingInProgress)) {
      // scalp_1m fora do watchdog: o motor e o /api/close soltam a trava no finally/catch
      if (localAlvos[sym]?.modo === 'scalp_1m' || Object.values(scalp1m.status().slots).some(s => s.symbol === sym)) continue;
      if (agoraWd - (closingStartedAt[sym] || 0) > 12000) {
        closingInProgress.delete(sym); delete closingStartedAt[sym];
        if (localAlvos[sym]) localAlvos[sym].fechando = false;
      }
    }

    for (const sym of Object.keys(localAlvos)) {
      if (closingInProgress.has(sym)) continue;
      const alvo = localAlvos[sym];
      if (!alvo || alvo.fechando) continue;
      if (alvo.modo === 'scalp_1m') continue; // scalp_1m tem monitor próprio (scalp1m.monitorarTodas)
      try {
        const pos = await fut.posicao(sym);
        if (!pos || pos.quantidade === 0) {
          delete localAlvos[sym]; delete saidaSarTicks[sym]; salvarAlvos();
          continue;
        }
        const ticker = await fut.tickerPreco(sym).catch(() => null);
        const curPrice = (ticker && ticker.price) ? parseFloat(ticker.price) : (parseFloat(pos.precoMarca) || parseFloat(pos.precoEntrada));
        const entryPrice = parseFloat(pos.precoEntrada);
        const alav = pos.alavancagem || 1;
        const isLong = pos.lado === 'LONG';
        const roi = ((curPrice - entryPrice) / entryPrice) * 100 * (isLong ? 1 : -1) * alav;
        const duracaoMs = Date.now() - (alvo.openTime || pos.atualizadoEm || Date.now());
        if (alvo.maxRoiReached === undefined || roi > alvo.maxRoiReached) alvo.maxRoiReached = roi;
        if (alvo.minRoiReached === undefined || roi < alvo.minRoiReached) alvo.minRoiReached = roi;
        alvo.lastRoiPuro = roi;

        const slotNum = alvo.slot || [1, 2].find(s => autoBotState.slots[s].symbol === sym) || 1;
        const esq = await atualizarEsqueleto(slotNum, sym, 'POSICAO_ABERTA_SURFANDO_SAR');
        let sarContra = false;
        if (esq) {
          const dirSar = sarEngine.direcaoDoSar(esq);
          sarContra = dirSar !== pos.lado;
          alvo.sarLabel = `[🏄 SURFANDO SAR 1m: ${esq.sar1m.posicaoAtual} ${esq.sar1m.valorAtual.toFixed(6)} | PICO +${(alvo.maxRoiReached || 0).toFixed(2)}%${sarContra ? ' | ⚠️ SAR CONTRA' : ''}]`;
        }

        let deveFechar = false;
        let motivo = '';

        // 1. Saída principal: SAR virou contra (confirmado em N leituras)
        if (sarContra) {
          saidaSarTicks[sym] = (saidaSarTicks[sym] || 0) + 1;
          if (saidaSarTicks[sym] >= SAIDA_SAR_TICKS) {
            deveFechar = true;
            motivo = `[SAIDA_SAR_VIRADA] SAR 1m virou contra (${esq.sar1m.posicaoAtual}) | ROI ${roi.toFixed(2)}% | Pico +${(alvo.maxRoiReached || 0).toFixed(2)}% | ${Math.round(duracaoMs / 60000)}m`;
          }
        } else {
          saidaSarTicks[sym] = 0;
        }

        // 2. Stop Loss inicial e Breakeven executados pelo monitor (não dependem do algoOrder da corretora)
        const slIni = slInicialRoi(alav);
        if (!deveFechar && alvo.maxRoiReached >= BE_ATIVA_ROI && roi <= BE_PISO_ROI) {
          deveFechar = true;
          motivo = `[BREAKEVEN] Pico +${alvo.maxRoiReached.toFixed(2)}% >= ${BE_ATIVA_ROI}% e ROI ${roi.toFixed(2)}% <= piso +${BE_PISO_ROI}%`;
        } else if (!deveFechar && roi <= slIni) {
          deveFechar = true;
          motivo = `[SL_INICIAL] ROI ${roi.toFixed(2)}% <= ${slIni}%`;
        }

        // 3. Proteção de funding tóxico (mantida)
        if (!deveFechar && roi >= 1.50) {
          const prem = await fut.precoMarca(sym).catch(() => null);
          if (prem) {
            const fr = parseFloat(prem.lastFundingRate || 0);
            const msAteFunding = parseInt(prem.nextFundingTime || 0) - Date.now();
            const pagando = isLong ? (fr > 0.0005) : (fr < -0.0005);
            const toxico = isLong ? (fr > 0.0025) : (fr < -0.0025);
            if ((pagando && msAteFunding > 0 && msAteFunding <= 5 * 60000) || (toxico && duracaoMs >= 60 * 60000)) {
              deveFechar = true;
              motivo = `[SAIDA_PROTECAO_FUNDING] Lucro protegido (+${roi.toFixed(2)}% ROI) p/ evitar funding (${(fr * 100).toFixed(4)}%)`;
            }
          }
        }

        if (!deveFechar) continue;

        // ── FECHAMENTO BLINDADO ──
        if (closingInProgress.has(sym) || alvo.fechando) continue;
        closingInProgress.add(sym);
        closingStartedAt[sym] = Date.now();
        alvo.fechando = true; alvo.fechandoDesde = Date.now();
        const alvoBackup = { ...alvo };
        if (esqueletoSlot[slotNum]) esqueletoSlot[slotNum].statusSlot = 'EXECUTANDO_SAIDA';
        delete localAlvos[sym]; delete saidaSarTicks[sym];
        salvarAlvos();
        try {
          console.log(`[FECHAMENTO SAR] ${sym}: ${motivo}`);
          await fut.cancelarTodasOrdens(sym);
          await fecharLimiteComFallback(sym, pos.lado, pos.quantidade);
          const exitTipo = motivo.includes('SAIDA_SAR_VIRADA') ? 'SAIDA_SAR_VIRADA'
            : motivo.includes('SL_INICIAL') ? 'SL_INICIAL'
            : motivo.includes('BREAKEVEN') ? 'BREAKEVEN'
            : motivo.includes('FUNDING') ? 'SAIDA_PROTECAO_FUNDING' : 'TIMEOUT';
          await rag.salvarSaidaRAG({ symbol: sym, exitPrice: curPrice, exitReason: exitTipo, roiPct: roi, pnlUsdt: pos.pnlNaoRealizado }).catch(() => {});
          registrarDesfechoTrade(sym, exitTipo, roi, pos.pnlNaoRealizado, alvoBackup);
          // Volta ao ranking: o slot libera a moeda e escolhe a mais volátil do momento
          const viradaSar = exitTipo === 'SAIDA_SAR_VIRADA';
          cooldownMoeda[sym] = Date.now() + (viradaSar ? COOLDOWN_SAR_VIRADA_MS : 5 * 60000);
          if (viradaSar) { delete symbolLossCooldown[sym]; salvarLossCooldown(); }
          const s = autoBotState.slots[slotNum];
          if (s.symbol === sym) {
            s.symbol = null; s.side = null; s.targetSymbol = null;
            s.searchCooldownUntil = Date.now() + (viradaSar ? COOLDOWN_SAR_VIRADA_MS : 15000);
            s.status = viradaSar ? 'FECHADO_COOLDOWN_5S' : 'FECHADO_COOLDOWN_15S';
          }
          esqueletoSlot[slotNum] = null;
        } catch (err) {
          console.error(`[FECHAMENTO SAR] Erro ao fechar ${sym}:`, err.message);
          const posRest = await fut.posicao(sym).catch(() => undefined);
          if (posRest === undefined || (posRest && posRest.quantidade > 0)) { // consulta falhou: assume aberta e restaura o monitor
            localAlvos[sym] = alvoBackup; salvarAlvos();
          }
        } finally {
          if (localAlvos[sym]) localAlvos[sym].fechando = false;
          closingInProgress.delete(sym); delete closingStartedAt[sym];
        }
      } catch (e) {
        if (localAlvos[sym]) localAlvos[sym].fechando = false;
        closingInProgress.delete(sym); delete closingStartedAt[sym];
      }
    }
  } finally {
    isMonitoringTick = false;
  }
}, 1500);


// ── SCANNER INTELIGENTE DE CANDIDATOS DA WHITELIST VIP ───────────────────


// ── ROBÔ AUTÔNOMO CONTÍNUO (ETAPA 5: GATEKEEPER + CANDLE 5M) ───────────


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

// Retorno Líquido Base Capital (referência dinâmica sincronizada no reset)
app.get('/api/base-capital-pnl', async (req, res) => {
  try {
    const hojeInicio = getInicioHojeBrasil();
    const marcoRef = Math.max(hojeInicio, marcoZero || 0);
    const ontemInicio = hojeInicio - (24 * 60 * 60 * 1000);
    const ontemFim = hojeInicio - 1;

    const inc = await fut.income({ startTime: ontemInicio, limit: 1000 }).catch(() => []);

    let pnlBrutoHoje = 0, taxaHoje = 0, fundingHoje = 0, countHoje = 0;
    let pnlBrutoOntem = 0, taxaOntem = 0, fundingOntem = 0, countOntem = 0;

    for (const r of inc || []) {
      const t = parseInt(r.time);
      const val = parseFloat(r.income);
      if (r.symbol === 'HEMIUSDT') continue;

      if (t >= marcoRef) {
        if (r.incomeType === 'REALIZED_PNL') { pnlBrutoHoje += val; countHoje++; }
        else if (r.incomeType === 'COMMISSION') { taxaHoje += val; }
        else if (r.incomeType === 'FUNDING_FEE') { fundingHoje += val; }
      } else if (t >= ontemInicio && t <= ontemFim) {
        if (r.incomeType === 'REALIZED_PNL') { pnlBrutoOntem += val; countOntem++; }
        else if (r.incomeType === 'COMMISSION') { taxaOntem += val; }
        else if (r.incomeType === 'FUNDING_FEE') { fundingOntem += val; }
      }
    }

    const pnlLiquidoHoje = pnlBrutoHoje + taxaHoje + fundingHoje;
    const pnlLiquidoOntem = pnlBrutoOntem + taxaOntem + fundingOntem;

    const baseCapitalOperacional = MAX_SLOTS * MARGEM_POR_SLOT; // 20.00 USDT
    const roiHoje = (pnlLiquidoHoje / baseCapitalOperacional) * 100;
    const roiOntem = (pnlLiquidoOntem / baseCapitalOperacional) * 100;

    res.json({
      success: true,
      baseCapital: baseCapitalOperacional,
      baseCapitalOperacional,
      saldoReferenciaCiclo: saldoReferenciaCiclo || 0,
      brl: brlGlobal,
      hoje: {
        dataStr: new Date(marcoRef).toLocaleDateString('pt-BR'),
        pnlBruto: pnlBrutoHoje,
        taxas: taxaHoje,
        funding: fundingHoje,
        pnlLiquido: pnlLiquidoHoje,
        pnlBrl: pnlLiquidoHoje * brlGlobal,
        roiPct: roiHoje,
        tradesCount: countHoje
      },
      ontem: {
        dataStr: new Date(ontemInicio).toLocaleDateString('pt-BR'),
        pnlBruto: pnlBrutoOntem,
        taxas: taxaOntem,
        funding: fundingOntem,
        pnlLiquido: pnlLiquidoOntem,
        pnlBrl: pnlLiquidoOntem * brlGlobal,
        roiPct: roiOntem,
        tradesCount: countOntem
      }
    });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});


// Scanner de Voláteis com Filtro de Liquidez (ETAPA 2)
app.get('/api/volateis', async (req, res) => {
  try {
    const data = await fut.ticker24h();
    const candidatos = data
      .filter(t => isSimboloValido(t.symbol) && parseFloat(t.count || 0) > 1000)
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
    const slotNum = [1, 2].find(n => autoBotState.slots[n].symbol === symbol || autoBotState.slots[n].targetSymbol === symbol) || 0;
    const ks = await klines1m(symbol).catch(() => null);
    const esq = sarEngine.construirEsqueleto(slotNum, symbol, ks, { statusSlot: slotNum && esqueletoSlot[slotNum] ? esqueletoSlot[slotNum].statusSlot : 'AGUARDANDO_VIRADA_SAR' });
    if (!esq) return res.json({ success: false, error: 'Dados 1m insuficientes' });

    let pos = null;
    try {
      const p = await fut.posicao(symbol);
      if (p && p.quantidade > 0) pos = p;
    } catch(e) {}
    let p24 = 0;
    try {
      const t = await fut.ticker24h(symbol);
      p24 = parseFloat((Array.isArray(t) ? t[0] : t)?.priceChangePercent || 0);
    } catch(e) {}

    const alvo = localAlvos[symbol];
    const l = esq.linhasConfirmacao1m;
    const cor = v => (v === 'SUBINDO' ? 'green' : (v === 'CAINDO' ? 'red' : ''));
    const dirSar = sarEngine.direcaoDoSar(esq);
    res.json({
      success: true,
      symbol,
      preco: esq.precoAtual,
      priceChangePercent: p24,
      esqueleto: esq,
      direcaoSar: dirSar,
      intervals: { sar: dirSar === 'LONG' ? 'green' : 'red', ema9: cor(l.ema9_inclinacao), ema21: cor(l.ema21_inclinacao), rsi: cor(l.rsi14_inclinacao) },
      leverageSugerida: ALAV_PADRAO,
      slPrice: alvo?.slPrice || null,
      slRoe: Math.abs(slInicialRoi(alvo?.leverage)),
      beLabel: alvo?.sarLabel || '',
      maxRoiReached: alvo?.maxRoiReached || 0,
      pricePrecision: fut.filtrosDe(symbol)?.pricePrecision ?? 4,
      pos
    });
  } catch(err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

// Esqueleto vivo dos slots (compartilhado com a UI e a IA)
app.get('/api/esqueleto', (req, res) => {
  res.json({ success: true, esqueletos: { 1: esqueletoSlot[1], 2: esqueletoSlot[2] }, slots: autoBotState.slots });
});
app.get('/api/esqueleto/:slot', (req, res) => {
  const n = parseInt(req.params.slot, 10);
  if (n !== 1 && n !== 2) return res.json({ success: false, error: 'slot inválido' });
  res.json({ success: true, esqueleto: esqueletoSlot[n], slot: autoBotState.slots[n] });
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
    const ks = await klines1m(symbol).catch(() => null);
    const esq = sarEngine.construirEsqueleto(0, symbol, ks);
    if (!esq) return res.json({ success: false, error: 'Dados insuficientes' });
    const dec = await decidirEntradaSar(esq);
    res.json({
      success: true,
      symbol,
      decisao: dec.dir,
      aprovado: dec.dir !== 'WAIT',
      confianca: dec.conf,
      alavancagem: ALAV_PADRAO,
      slPrice: null,
      tpPrice: null,
      beTriggerPrice: null,
      motivo: dec.motivo + ' | SAR ' + esq.sar1m.posicaoAtual + ' (' + esq.sar1m.bolinhasConsecutivas + ' bolinha(s))'
    });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});
// Execução Manual de Trade
app.post('/api/trade', async (req, res) => {
  try {
    const { symbol, lado, valorUSDT, alavancagem } = req.body;
    if (!autoBotState.enabled) throw new Error('PSAR desligado (enabled:false): entrada manual PSAR bloqueada'); // guarda PSAR
    if (!isSimboloValido(symbol)) throw new Error('Símbolo inválido');
    if (lado !== 'BUY' && lado !== 'SELL') throw new Error('Lado inválido');
    if (!(parseFloat(valorUSDT) > 0) || parseFloat(valorUSDT) > 100) throw new Error('Valor inválido (0-100 USDT)');
    if (localAlvos[symbol] || [1, 2].some(n => slotEmDecisao[n] && autoBotState.slots[n].targetSymbol === symbol)) throw new Error('Moeda já em operação/decisão no robô');
    const alavCapMan = lado === 'SELL' ? 3 : 4; // mesma assimetria defensiva do autobot: SHORT manual também tetado em 3x
    const alav = Math.min(alavCapMan, Math.max(1, parseInt(alavancagem) || 1));
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
      const dirMan = lado === 'BUY' ? 'LONG' : 'SHORT';
      const slotMan = [1, 2].find(n => autoBotState.slots[n].symbol === symbol || autoBotState.slots[n].targetSymbol === symbol) || 1;
      const esqMan = esqueletoSlot[slotMan] || { sar1m: {} };
      registrarPosicaoSar(symbol, dirMan, alav, { preco, qty: fill }, esqMan, slotMan);
      res.json({ success: true, result: st });
    } else {
      res.json({ success: false, error: 'A ordem limite não pegou (derrapagem > 0.3%).' });
    }
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

app.post('/api/close', async (req, res) => {
  const { symbol } = req.body || {};
  let ehScalp = false, lockScalp = false;
  try {
    if (scalp1m.emEntrada(symbol)) { // scalp em ENTRANDO (com ou sem alvo): nada é cancelado nem fechado
      return res.status(409).json({ success: false, error: 'SCALP_1M em fase ENTRANDO neste símbolo: fechamento manual bloqueado até a entrada terminar. Tente de novo em alguns segundos.' });
    }
    if (closingInProgress.has(symbol)) throw new Error('Fechamento já em andamento.');
    ehScalp = localAlvos[symbol]?.modo === 'scalp_1m'; // lido antes dos awaits
    if (ehScalp && !scalp1m.travaOk(symbol, 'API_CLOSE')) { // trava testnet do motor: nenhuma ordem enviada
      return res.status(400).json({ success: false, error: 'SCALP_1M: base de ordens não é testnet; fechamento não enviado.' });
    }
    closingInProgress.add(symbol); closingStartedAt[symbol] = Date.now(); lockScalp = ehScalp;
    const pos = await fut.posicao(symbol);
    if (!pos || pos.quantidade === 0) {
      if (ehScalp) {
        try { scalp1m.liberarSlot(symbol); } catch (e) {}
      }
      delete saidaSarTicks[symbol];
      Reflect.deleteProperty(localAlvos, symbol);
      salvarAlvos();
      await fut.cancelarTodasOrdens(symbol).catch(() => false);
      closingInProgress.delete(symbol); delete closingStartedAt[symbol];
      return res.json({ success: true, aviso: 'Posição já estava zerada na corretora. Alvo e slot limpos.' });
    }
    if (!ehScalp) await fut.cancelarTodasOrdens(symbol);
    let r;
    if (ehScalp) { // scalp: fecha primeiro; stop só cai após o fechamento
      try { r = await fut.fecharMercado(symbol, pos.lado, pos.quantidade); } catch (eF) {
        if (localAlvos[symbol]) localAlvos[symbol].slNaCorretora = true; // stop não cancelado
        console.error(`[SCALP-CLOSE] ${symbol}: fechamento a mercado falhou; stop mantido`);
        throw eF;
      }
      if (!(await fut.cancelarTodasOrdens(symbol, { estrito: true }).catch(() => false))) { // alvo mantido; o motor retenta e grava o desfecho
        console.error(`[SCALP-CLOSE] ${symbol}: cancelamento de ordens falhou após fechar; stop pode seguir na corretora; alvo mantido`);
        const aP = localAlvos[symbol];
        if (aP) {
          if (!(aP.entryPrice > 0)) aP.entryPrice = pos.precoEntrada;
          aP.side = aP.side || pos.lado; aP.quantidade = pos.quantidade;
          scalp1m.marcarCancelPendente(symbol, aP, { fin: ['SCALP_MANUAL', parseFloat(r?.avgPrice)] });
        }
        closingInProgress.delete(symbol); delete closingStartedAt[symbol];
        return res.json({ success: true, result: r, aviso: 'Posição fechada; cancelamento de ordens falhou. Alvo mantido; o motor scalp retenta o cancelamento.' });
      }
    } else r = await fut.fecharMercado(symbol, pos.lado, pos.quantidade);

    const margem = pos.margem || ((pos.quantidade * pos.precoEntrada) / (pos.alavancagem || 1));
    const roi = margem > 0 ? (pos.pnlNaoRealizado / margem) * 100 : 0;
    const alvoBackup = localAlvos[symbol] ? { ...localAlvos[symbol] } : null;
    const pnlBrutoTotal = pos.pnlNaoRealizado + (alvoBackup?.pnlParcialBruto || 0);
    const motivoClose = ehScalp ? 'SCALP_MANUAL' : 'MANUAL_CLOSE'; // scalp: placar sim, sem quarentena 1h nem cooldown 45 min

    registrarDesfechoTrade(symbol, motivoClose, roi, pos.pnlNaoRealizado, alvoBackup);
    if (!ehScalp) cooldownMoeda[symbol] = Date.now() + 2700000;
    if (ehScalp) scalp1m.registrarTradeExterno(symbol, { side: pos.lado, entryPrice: pos.precoEntrada, ...alvoBackup, quantidade: pos.quantidade }, motivoClose, parseFloat(r?.avgPrice)); // linha TRADE no JSONL

    await rag.salvarSaidaRAG({
      symbol,
      exitPrice: pos.precoMarca || pos.precoEntrada,
      exitReason: motivoClose,
      roiPct: roi,
      pnlUsdt: pnlBrutoTotal
    }).catch(() => {});

    delete localAlvos[symbol];
    delete saidaSarTicks[symbol];
    salvarAlvos();
    closingInProgress.delete(symbol); delete closingStartedAt[symbol];
    res.json({ success: true, result: r });
  } catch (err) {
    if (lockScalp) { closingInProgress.delete(symbol); delete closingStartedAt[symbol]; } // watchdog não solta trava scalp
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

app.post('/api/tp-sl', (req, res) => res.json({ success: false, error: 'Sem TP/SL manual: a saída é a virada do Parabolic SAR 1m.' }));
app.post('/api/reverse', async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!autoBotState.enabled) throw new Error('PSAR desligado (enabled:false): reversão bloqueada'); // guarda PSAR: nada é fechado nem aberto
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
    // Reversão vira nova posição SAR: registra alvo (monitor + stop de emergência)
    const novoLado = origSide === 'LONG' ? 'SHORT' : 'LONG';
    const posNova = await fut.posicao(symbol).catch(() => null);
    const slotRev = [1, 2].find(n => autoBotState.slots[n].symbol === symbol || autoBotState.slots[n].targetSymbol === symbol) || 1;
    if (posNova && posNova.quantidade > 0) {
      registrarPosicaoSar(symbol, novoLado, alav, { preco: parseFloat(posNova.precoEntrada), qty: posNova.quantidade }, esqueletoSlot[slotRev] || { sar1m: {} }, slotRev);
    }
    res.json({ success: true, result: r2 });
  } catch (err) {
    res.json({ success: false, error: fut.detalheErro(err) });
  }
});

// Slots PSAR 1/2 ocultos no painel: robô desligado e nenhuma posição PSAR ativa (slot ou alvo não-scalp).
function psarSlotsOcultos() {
  if (autoBotState.enabled) return false;
  if ([1, 2].some(n => autoBotState.slots[n] && autoBotState.slots[n].symbol)) return false;
  return !Object.values(localAlvos).some(a => a && a.modo !== 'scalp_1m');
}

app.get('/api/auto-status', (req, res) => {
  res.json({
    success: true,
    enabled: autoBotState.enabled,
    psarOcultar: psarSlotsOcultos(),
    slots: autoBotState.slots,
    lastLog: autoBotState.lastLog,
    esqueletos: { 1: esqueletoSlot[1], 2: esqueletoSlot[2] },
    topCandidatos: (rankCache.lista || []).slice(0, 10).map(c => ({
      symbol: c.symbol,
      modoDetectado: 'SAR_1M',
      modoLabel: 'SAR 1m',
      directionalScore: 0,
      scoreEfetivo: Number(c.score.toFixed(3)),
      atrPct15m: Number(c.ampMedia15m.toFixed(3)),
      rvol15m: 0
    })),
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

app.get('/api/scalp-1m', (req, res) => {
  res.json({ success: true, ...scalp1m.status() });
});

app.post('/api/scalp-1m', (req, res) => {
  try {
    const enabled = scalp1m.definirEnabled(!!req.body?.enabled);
    res.json({ success: true, enabled });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
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

app.post('/api/limpar-placar', async (req, res) => {
  try {
    marcoZero = Date.now();
    try { fs.writeFileSync(MARCO_ZERO_FILE, marcoZero.toString()); } catch(e){}

    placarStats = { wins: 0, losses: 0, total: 0, pnlHoje: 0 };
    salvarPlacarStats();
    try { scalp1m.zerarContadores(); } catch(e) {} // Win Rate, taxas e histórico de turnos do Sniper 2 min recomeçam do zero

    // Mantém estritamente 20.00 USDT de Base Capital Operacional e guarda o saldo total da carteira em separado
    const baseCapitalOperacional = MAX_SLOTS * MARGEM_POR_SLOT;
    try {
      const acc = await fut.assinado('get', '/fapi/v2/account').catch(() => null);
      const walletBal = parseFloat(acc?.totalWalletBalance || acc?.totalMarginBalance || 0);
      if (walletBal > 0) {
        saldoReferenciaCiclo = walletBal;
      }
      try {
        fs.writeFileSync(BASE_CAPITAL_FILE, JSON.stringify({
          baseCapital: baseCapitalOperacional,
          saldoReferenciaCiclo: saldoReferenciaCiclo || walletBal || 0,
          timestamp: marcoZero
        }, null, 2));
      } catch(e){}
    } catch(e) {}

    res.json({
      success: true,
      wins: 0,
      losses: 0,
      total: 0,
      pnlHoje: 0,
      marcoZero,
      saldoReferenciaCiclo,
      baseCapital: baseCapitalOperacional,
      baseCapitalOperacional
    });
  } catch(err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/historico-completo', async (req, res) => {
  try {
    const inc = await fut.income({ limit: 1000 }).catch(() => []);
    const dbTrades = await db.all("SELECT * FROM trades_rag WHERE exit_time IS NOT NULL ORDER BY exit_time DESC LIMIT 300");

    const trades = (dbTrades || []).map(t => {
      const symInc = inc.filter(r => r.symbol === t.symbol && r.time >= (t.entry_time - 15000) && r.time <= (t.exit_time + 15000));
      let realPnl = 0, comm = 0;
      symInc.forEach(r => {
        if (r.incomeType === 'REALIZED_PNL') realPnl += parseFloat(r.income);
        if (r.incomeType === 'COMMISSION') comm += Math.abs(parseFloat(r.income));
      });

      const finalPnl = (symInc.length > 0 && Math.abs(realPnl) > 0) ? realPnl : (parseFloat(t.pnl_usdt) || 0);
      const finalFee = comm > 0 ? comm : 0.02;

      const netPnl = finalPnl - finalFee;
      return {
        id: t.id,
        orderId: t.id,
        symbol: t.symbol,
        side: t.side,
        leverage: t.leverage || 1,
        mode: t.mode || '',
        entryPrice: t.entry_price,
        exitPrice: t.exit_price,
        entryTime: t.entry_time,
        time: t.exit_time,
        dataBrasil: formatarDataBrasil(t.exit_time || t.entry_time),
        roi: parseFloat(t.roi_pct) || 0,
        pnl: finalPnl,
        netPnl: netPnl,
        fee: finalFee,
        exitReason: t.exit_reason || '',
        result: (netPnl > 0 ? 'WIN' : 'LOSS')
      };
    });

    res.json({ success: true, count: trades.length, trades, marcoZero });
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
          <input type="text" id="sym-${col}" placeholder="MOEDA (EX: BTC)" oninput="onUserType(${col})" onfocus="onUserType(${col})" autocomplete="off">
          <span class="pct-badge" id="pct-24h-${col}">--%</span>
        </div>
        <div class="modo-badge" id="modo-badge-${col}">[AGUARDANDO SETUP]</div>
      </div>

      <!-- PREÇO ATUAL GRANDE E DESTACADO -->
      <div class="price-display" id="price-${col}">$ 0.0000</div>

      <!-- POSIÇÃO ABERTA (MOVIDA PARA O TOPO: ALTO DESTAQUE VISUAL COM GLOW) -->
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
      
      <!-- PARABOLIC SAR 1m + LINHAS DE CONFIRMAÇÃO -->
      <div class="mtf-box">
        <div class="mtf-header">
          <span class="mtf-title">PARABOLIC SAR 1m + LINHAS DE CONFIRMAÇÃO</span>
          <span id="mtf-status-${col}" class="badge-mtf">CARREGANDO...</span>
        </div>
        <div class="candles-row" id="candles-${col}">
          ${['sar','ema9','ema21','rsi'].map(tf => `
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
            <div class="target-title">STOP EMERGÊNCIA</div>
            <div class="target-val" id="proj-sl-${col}">--</div>
          </div>
          <div class="target-box target-be">
            <div class="target-title">SEM CATRACA</div>
            <div class="target-val" id="proj-be-${col}">--</div>
          </div>
          <div class="target-box target-tp">
            <div class="target-title">SEM TP: SAÍDA NA VIRADA SAR</div>
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
      flex-wrap: nowrap;
      gap: 12px;
      box-shadow: 0 4px 25px rgba(0,0,0,0.45);
    }
    .header-stat-group {
      display: flex;
      align-items: center;
      gap: 20px;
      flex-wrap: nowrap;
      flex: 1 1 auto;
      min-width: 0;
    }
    .stat-box { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
    .stat-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 700; white-space: nowrap; }
    .stat-value-gold { font-size: 1.55rem; font-weight: 900; color: var(--gold); letter-spacing: 0.5px; white-space: nowrap; }
    .stat-sub { font-size: 0.85rem; color: var(--blue); font-weight: 700; white-space: nowrap; }

    /* PLACAR DE TRADES INSTITUCIONAL COM WIN RATE (LARGURA FIXA RÍGIDA) */
    .placar-box {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 5px;
      background: rgba(0,0,0,0.45);
      border: 1px solid var(--border);
      padding: 8px 10px;
      border-radius: 12px;
      flex: 0 0 auto;
      width: auto;
      min-width: fit-content;
      box-sizing: border-box;
    }
    .placar-box .stat-label { flex-shrink: 0; margin-right: 2px; }
    .badge-win { font-size: 0.95rem; font-weight: 800; color: var(--green); background: rgba(16,185,129,0.2); border: 1px solid rgba(16,185,129,0.4); padding: 4px 6px; border-radius: 6px; flex: 0 0 58px; width: 58px; text-align: center; white-space: nowrap; }
    .badge-loss { font-size: 0.95rem; font-weight: 800; color: var(--red); background: rgba(239,68,68,0.2); border: 1px solid rgba(239,68,68,0.4); padding: 4px 6px; border-radius: 6px; flex: 0 0 58px; width: 58px; text-align: center; white-space: nowrap; }
    .badge-wr { font-size: 0.8rem; font-weight: 800; color: var(--gold); background: rgba(212,175,55,0.18); border: 1px solid rgba(212,175,55,0.35); padding: 4px 6px; border-radius: 6px; flex: 0 0 58px; width: 58px; text-align: center; white-space: nowrap; }
    .btn-zerar {
      padding: 5px 8px;
      font-size: 0.72rem;
      background: rgba(239,68,68,0.15);
      border: 1px solid rgba(239,68,68,0.4);
      color: var(--red);
      border-radius: 6px;
      cursor: pointer;
      font-weight: 800;
      transition: 0.2s;
      flex: 0 0 54px;
      width: 54px;
      text-align: center;
    }
    .btn-zerar:hover { background: var(--red); color: #FFF; }

    .header-btns {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: nowrap;
      flex-shrink: 0;
    }
    .header-btns button {
      padding: 10px 16px;
      font-size: 0.85rem;
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 10px;
      cursor: pointer;
      font-weight: 700;
      transition: 0.2s;
      white-space: nowrap;
      flex-shrink: 0;
    }
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

    /* SCALP 1M: CICLO DE 5 MIN (tela principal com PSAR desligado: body.modo-scalp) */
    .scalp-turno-bar {
      background: linear-gradient(180deg, rgba(13,17,28,0.95) 0%, rgba(9,12,20,0.98) 100%);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 10px 14px;
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr);
      gap: 8px;
      font-size: 0.82rem;
    }
    body.modo-scalp { padding: 6px; height: 100vh; min-height: 0; overflow: hidden; }
    body.modo-scalp .container { max-width: 1366px; height: 100%; gap: 0; }
    body.modo-scalp .perf-header-bar, body.modo-scalp .volatility-bar, body.modo-scalp .bot-control-bar,
    body.modo-scalp #psar-off-nota, body.modo-scalp #psar-grid { display: none !important; }
    body.modo-scalp .scalp-turno-bar { height: calc(100vh - 12px); overflow: hidden; }
    .sc-topo { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; row-gap: 4px; }
    .sc-placar { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
    .sc-placar .badge-win, .sc-placar .badge-loss, .sc-placar .badge-wr { font-size: 0.78rem; padding: 2px 5px; flex: 0 0 auto; width: auto; min-width: 46px; text-align: center; }
    .sc-kpis { display: flex; align-items: center; gap: 4px; flex: 1 1 auto; min-width: 0; flex-wrap: wrap; row-gap: 4px; overflow: visible; }
    .sc-kpi { display: flex; flex-direction: column; gap: 1px; flex: 0 0 auto; padding: 3px 7px; background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 8px; white-space: nowrap; }
    .sc-kpi b { font-size: 0.88rem; white-space: nowrap; font-weight: 900; font-variant-numeric: tabular-nums; }
    .sc-btns { display: flex; gap: 4px; flex: 0 0 auto; white-space: nowrap; }
    .sc-btns button { padding: 5px 8px; font-size: 0.7rem; white-space: nowrap; border-radius: 7px; background: rgba(255,255,255,0.06); color: var(--text); border: 1px solid var(--border); cursor: pointer; font-weight: 700; }
    .scalp-tag { font-size: 0.72rem; font-weight: 900; letter-spacing: 1px; color: var(--purple); background: rgba(167,139,250,0.15); border: 1px solid rgba(167,139,250,0.4); padding: 3px 8px; border-radius: 7px; white-space: nowrap; }
    .scalp-estado { font-size: 0.75rem; font-weight: 800; color: var(--text-muted); white-space: nowrap; }
    .sc-centro { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 18px; background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 10px; padding: 6px 16px; }
    .sc-relogio { font-size: 3.1rem; line-height: 1; font-weight: 900; color: var(--gold); font-family: monospace; font-variant-numeric: tabular-nums; }
    .sc-fase-box { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .sc-fase { font-size: 1.35rem; font-weight: 900; letter-spacing: 2px; }
    .sc-fase-ABERTO { color: var(--green); }
    .sc-fase-ANALISE { color: var(--blue); }
    .sc-fase-CONFIRMACAO { color: var(--gold); }
    .sc-fase-sub { font-size: 0.78rem; color: var(--text-muted); font-weight: 700; }
    .sc-fase-sub b { color: var(--text); font-family: monospace; font-size: 0.95rem; }
    .sc-barra { position: relative; display: grid; grid-template-columns: 40fr 50fr 10fr; height: 8px; border-radius: 4px; overflow: hidden; }
    .sc-barra i { display: block; opacity: 0.35; }
    .sc-b-aberto { background: var(--green); }
    .sc-b-analise { background: var(--blue); }
    .sc-b-conf { background: var(--gold); }
    .sc-barra-pos { position: absolute; top: 0; bottom: 0; width: 3px; background: #FFF; left: 0; }
    .sc-turno-box { display: grid; grid-template-columns: auto auto; gap: 2px 10px; align-items: baseline; }
    .scalp-num { font-size: 0.9rem; font-weight: 900; color: var(--text); white-space: nowrap; }
    .scalp-mini { font-size: 0.7rem; color: var(--text-muted); font-weight: 700; }
    .scalp-chip { font-size: 0.7rem; font-weight: 800; padding: 2px 7px; border-radius: 6px; white-space: nowrap; display: inline-block; }
    .scalp-chip-pos { color: var(--green); background: rgba(16,185,129,0.18); border: 1px solid rgba(16,185,129,0.4); }
    .scalp-chip-neg { color: var(--red); background: rgba(239,68,68,0.18); border: 1px solid rgba(239,68,68,0.4); }
    .scalp-chip-neutro { color: var(--text-muted); background: rgba(255,255,255,0.05); border: 1px solid var(--border); }
    .scalp-slots { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .scalp-slot { display: grid; grid-template-columns: auto 1fr auto; grid-template-rows: auto auto; gap: 4px 12px; align-items: center; background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 10px; padding: 8px 14px; font-family: monospace; min-height: 74px; }
    .scalp-slot-livre { opacity: 0.55; }
    .scalp-slot-orfa { border-color: rgba(239,68,68,0.55); }
    .scalp-slot-long { border-color: rgba(16,185,129,0.45); }
    .scalp-slot-short { border-color: rgba(239,68,68,0.45); }
    .scalp-slot-n { font-size: 0.68rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
    .scalp-moeda { font-size: 1.25rem; font-weight: 900; color: var(--text); }
    .scalp-pnl { font-size: 1.35rem; font-weight: 900; text-align: right; font-variant-numeric: tabular-nums; }
    .scalp-dir { font-size: 0.72rem; font-weight: 900; padding: 2px 8px; border-radius: 6px; }
    .scalp-long { color: var(--green); background: rgba(16,185,129,0.18); }
    .scalp-short { color: var(--red); background: rgba(239,68,68,0.18); }
    .scalp-campo { white-space: nowrap; font-size: 0.78rem; }
    .scalp-status { font-size: 0.7rem; font-weight: 800; color: var(--blue); text-align: right; }
    .sc-baixo { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 8px; min-height: 0; align-items: start; }
    /* Ranking das 20: 2 colunas de 10 linhas compactas, sem barra de rolagem (cabe em 1366x768 a 100%) */
    .sc-rank2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
    .sc-rank2 .sc-tab { font-size: 0.7rem; table-layout: fixed; }
    .sc-rank2 .sc-tab th { padding: 1px 3px; font-size: 0.6rem; }
    .sc-rank2 .sc-tab td { padding: 1px 3px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; }
    .sc-rank2 .sc-tab td:nth-child(6), .sc-rank2 .sc-tab td:last-child { overflow: visible; }
    .sc-rank2 .scalp-chip { font-size: 0.6rem; padding: 0 4px; }
    .sc-rank2 .scalp-dir { font-size: 0.6rem; padding: 0 5px; }
    .sc-painel { background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
    .sc-tit { font-size: 0.7rem; font-weight: 900; color: var(--gold); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .sc-tab { width: 100%; border-collapse: collapse; font-family: monospace; font-size: 0.78rem; }
    .sc-tab th { text-align: left; font-size: 0.66rem; color: var(--text-muted); font-weight: 800; text-transform: uppercase; padding: 2px 6px; border-bottom: 1px solid var(--border); }
    .sc-tab td { padding: 3px 6px; border-bottom: 1px solid rgba(255,255,255,0.04); white-space: nowrap; }
    .sc-tab tr.sc-pos td { color: var(--green); }
    .sc-tab tr.sc-neg td { color: var(--red); }
    .sc-tab tr.sc-neutro td { color: var(--text-muted); }
    .sc-tab td.sc-num { text-align: right; font-variant-numeric: tabular-nums; }
    .sc-rolagem { flex: 1 1 auto; min-height: 0; max-height: 210px; overflow-y: auto; overflow-x: hidden; }
    .sc-rolagem .sc-tab th { position: sticky; top: 0; background: var(--bg); z-index: 1; }

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
    .card.active:not(.has-pos) { border-color: rgba(212, 175, 55, 0.55); box-shadow: 0 0 25px rgba(212, 175, 55, 0.1); }
    .card.has-pos-win { border-color: rgba(16, 185, 129, 0.75) !important; box-shadow: 0 0 25px rgba(16, 185, 129, 0.3) !important; }
    .card.has-pos-loss { border-color: rgba(239, 68, 68, 0.75) !important; box-shadow: 0 0 25px rgba(239, 68, 68, 0.3) !important; }

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

    @media (max-width: 960px) {
      .grid { grid-template-columns: 1fr; }
      .scalp-slots { grid-template-columns: 1fr; }
      .sc-baixo { grid-template-columns: 1fr; }
      .perf-header-bar { flex-direction: column; text-align: center; flex-wrap: wrap; }
      .header-stat-group { justify-content: center; flex-wrap: wrap; }
      .header-btns { justify-content: center; flex-wrap: wrap; }
      .placar-box { flex: 0 0 auto; width: auto; min-width: auto; max-width: none; }
      .hist-summary-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body class="${psarSlotsOcultos() ? 'modo-scalp' : ''}">

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

  <!-- MODAL DE BASE CAPITAL (20 USDT) -->
  <div class="modal-overlay" id="modal-base-capital">
    <div class="modal" style="max-width: 480px; text-align: center;">
      <div class="modal-head">
        <div style="text-align: left;">
          <h3 style="color: var(--gold); font-size: 1.25rem; margin-bottom: 2px;">Performance Base Capital</h3>
          <span style="font-size: 0.78rem; color: var(--text-muted); font-weight: 600;">2 slots x 10 USDT = <b style="color:#FFF;">20 USDT Base</b></span>
        </div>
        <button onclick="fecharBaseCapital()" style="background:transparent; border:none; color:var(--text-muted); font-size:1.5rem; cursor:pointer;">&times;</button>
      </div>

      <!-- NAVEGADOR DE ABAS COM SETAS (ONTEM / HOJE) -->
      <div style="display:flex; justify-content:space-between; align-items:center; margin: 15px 0 20px 0; background: rgba(0,0,0,0.35); border: 1px solid var(--border); border-radius: 12px; padding: 6px 10px;">
        <button id="bc-nav-prev" onclick="navegarBaseCapital(-1)" style="padding: 6px 12px; font-size: 1.1rem; background: rgba(255,255,255,0.06); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; color: var(--text);">&larr;</button>
        <div style="display:flex; gap: 8px;">
          <button id="bc-tab-ontem" onclick="mudarAbaBaseCapital('ontem')" style="padding: 7px 18px; font-size: 0.82rem; font-weight: 700; border-radius: 8px; border: none; cursor: pointer; background: transparent; color: var(--text-muted);">ONTEM</button>
          <button id="bc-tab-hoje" onclick="mudarAbaBaseCapital('hoje')" style="padding: 7px 18px; font-size: 0.82rem; font-weight: 800; border-radius: 8px; border: none; cursor: pointer; background: var(--gold); color: #000;">HOJE</button>
        </div>
        <button id="bc-nav-next" onclick="navegarBaseCapital(1)" style="padding: 6px 12px; font-size: 1.1rem; background: rgba(255,255,255,0.06); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; color: var(--text);">&rarr;</button>
      </div>

      <!-- CONTEÚDO DINÂMICO -->
      <div id="bc-conteudo">
        <div style="padding: 30px; color: var(--text-muted); font-weight: 600;">Carregando dados...</div>
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
          <button id="btn-tab-periodo" onclick="mudarAbaHist('periodo')" style="padding:8px 16px; font-size:0.8rem; background:var(--gold); color:#000; border-radius:8px; font-weight:800; cursor:pointer;">Ciclo Atual</button>
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
        <button onclick="abrirBaseCapital()" style="background: rgba(212, 175, 55, 0.16); border: 1px solid var(--gold); color: var(--gold); font-weight: 800;">Base Capital</button>
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

    <!-- SCALP 1M: CICLO DE 5 MIN (tela principal com PSAR desligado) -->
    <div class="scalp-turno-bar" id="scalp-turno-bar">
      <div class="sc-topo">
        <span class="scalp-tag">SCALP 1M</span>
        <span id="scalp-estado" class="scalp-estado">Carregando...</span>
        <div class="sc-placar" title="Placar de trades (persistente): W / L / win rate"><span class="badge-win" id="scalp-placar-w">0 W</span><span class="scalp-mini">/</span><span class="badge-loss" id="scalp-placar-l">0 L</span><span class="badge-wr" id="scalp-placar-wr">0% WR</span></div>
        <div class="sc-kpis" id="scalp-hoje"></div>
        <div class="sc-btns"><button onclick="abrirBaseCapital()" style="color: var(--gold); border-color: var(--gold);">Base 20 USDT</button><button onclick="zerarPlacar()" title="Zerar placar e marco zero">ZERAR</button><button onclick="abrirHistorico()">Histórico</button><button onclick="fazerLogout()">Sair</button></div>
      </div>
      <div class="sc-centro">
        <div class="sc-relogio" id="scalp-relogio">--:--</div>
        <div class="sc-fase-box">
          <span id="scalp-fase" class="sc-fase">--</span>
          <span class="sc-fase-sub">fase termina em <b id="scalp-contagem">--:--</b> · ciclo fecha em <b id="scalp-ciclo-resta">--:--</b></span>
          <div class="sc-barra"><i class="sc-b-aberto"></i><i class="sc-b-analise"></i><i class="sc-b-conf"></i><span id="scalp-barra-pos" class="sc-barra-pos"></span></div>
        </div>
        <div class="sc-turno-box">
          <span class="scalp-mini">Turno</span><span id="scalp-turno-num" class="scalp-num">--</span>
          <span class="scalp-mini">Soma do turno</span><span id="scalp-soma-turno" class="scalp-num">--</span>
          <span class="scalp-mini">Próximas</span><span id="scalp-proximas" class="scalp-num">--</span>
        </div>
      </div>
      <div class="scalp-slots" id="scalp-slots"></div>
      <div class="sc-baixo">
        <div class="sc-painel"><div class="sc-tit">Ranking ao vivo · <span id="scalp-ranking-n">20</span> moedas · <span id="scalp-rotacao" class="scalp-mini">lista troca em -- ciclos</span></div><div class="sc-rank2"><table class="sc-tab" id="scalp-ranking"></table><table class="sc-tab" id="scalp-ranking-b"></table></div></div>
        <div class="sc-painel"><div class="sc-tit">Últimos 10 turnos</div><table class="sc-tab" id="scalp-historico"></table></div>
      </div>
    </div>

    <!-- GRELHA DOS CARTÕES (1 E 2) -->
    <div id="psar-off-nota" style="display:none; margin:6px 0; font-size:12px; color:var(--text-muted);">PSAR desligado</div>
    <div class="grid" id="psar-grid">
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
      [1, 2].forEach(col => {
        const el = document.getElementById('card-' + col);
        if (!el) return;
        el.classList.toggle('active', col === c);
        if (!el.classList.contains('has-pos')) {
          el.style.borderColor = (col === c ? 'rgba(212, 175, 55, 0.55)' : 'var(--card-border)');
          el.style.boxShadow = (col === c ? '0 0 25px rgba(212, 175, 55, 0.1)' : '0 4px 20px rgba(0,0,0,0.35)');
        }
      });
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
          window.listaVolateisCache = d.data;
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

          // Preenchimento inicial inteligente dos slots sem permitir duplicidade
          let s1 = (document.getElementById('sym-1')?.value || '').trim().toUpperCase();
          let s2 = (document.getElementById('sym-2')?.value || '').trim().toUpperCase();
          if (!s1 && d.data.length > 0) {
            s1 = d.data[0].symbol;
            document.getElementById('sym-1').value = s1;
            debouncedLoad(1);
          }
          if ((!s2 || s2 === s1) && d.data.length > 1) {
            s2 = (d.data.find(item => item.symbol !== s1)?.symbol) || 'SOLUSDT';
            document.getElementById('sym-2').value = s2;
            debouncedLoad(2);
          }
        }
      } catch(e) {}
    }

    let lastUserInteraction = { 1: 0, 2: 0 };
    let cardHasPosition = { 1: false, 2: false };
    let cardHasActiveSetup = { 1: false, 2: false };
    let lastAutoRotateTime = { 1: 0, 2: 0 };

    function onUserType(col) {
      lastUserInteraction[col] = Date.now();
      debouncedLoad(col);
    }

    function aplicarMoeda(sym) {
      const outroCol = (colunaAtiva === 1 ? 2 : 1);
      const outroSym = (document.getElementById('sym-' + outroCol)?.value || '').trim().toUpperCase();
      if (sym && sym === outroSym) {
        askConfirm('Par em Uso', 'O par <b style="color:var(--gold);">' + sym + '</b> já está ativo no Slot ' + outroCol + '. Escolha outro par para evitar duplicidade.', true);
        return;
      }
      lastUserInteraction[colunaAtiva] = Date.now();
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
      if (document.body.classList.contains('modo-scalp')) return; // PSAR fora da tela: cards 1/2 não buscam MTF
      let sym = document.getElementById('sym-' + col).value.trim().toUpperCase();
      if (!sym) return;
      if (!sym.endsWith('USDT')) sym += 'USDT';

      const outroCol = (col === 1 ? 2 : 1);
      const outroSym = (document.getElementById('sym-' + outroCol)?.value || '').trim().toUpperCase();
      if (sym === outroSym) {
        const candAlt = (window.dTopCandidatos && window.dTopCandidatos.find(c => c.symbol !== sym)?.symbol) ||
                        (window.listaVolateisCache && window.listaVolateisCache.find(c => c.symbol !== sym)?.symbol) ||
                        'SOLUSDT';
        console.warn('[ANTI-DUPLICIDADE loadData] Slot ' + col + ' e Slot ' + outroCol + ' com ' + sym + '. Trocando Slot ' + col + ' para ' + candAlt);
        document.getElementById('sym-' + col).value = candAlt;
        debouncedLoad(col);
        return;
      }
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
        ['sar','ema9','ema21','rsi'].forEach(tf => {
          const dot = document.getElementById('dot-' + col + '-' + tf);
          if (dot) dot.className = "dot " + (data.intervals[tf] || "");
        });

        // Badge Alinhamento MTF
        const mtfBadge = document.getElementById('mtf-status-' + col);
        if (mtfBadge) {
          const e1 = data.esqueleto;
          mtfBadge.innerText = e1 ? ('SAR ' + e1.sar1m.posicaoAtual + ' · ' + e1.sar1m.bolinhasConsecutivas + ' bolinha(s)' + (e1.sar1m.virouAgora ? ' · VIROU' : '')) : '--';
          mtfBadge.style.color = (e1 && e1.sar1m.virouAgora) ? 'var(--green)' : 'var(--gold)';
        }

        // Painel SAR 1m / linhas de confirmação
        const eq = data.esqueleto;
        if (eq) {
          const lc = eq.linhasConfirmacao1m;
          document.getElementById('ema-align-' + col).innerText = 'EMA9 ' + lc.ema9_inclinacao + ' | EMA21 ' + lc.ema21_inclinacao;
          const distEl = document.getElementById('dist-ema-' + col);
          distEl.innerText = eq.statusSlot;
          distEl.style.color = eq.sar1m.virouAgora ? 'var(--green)' : '#FFF';
          document.getElementById('atr-pct-' + col).innerText = 'Vol 1m: ' + eq.volatilidade1mPct.toFixed(2) + '%';
          document.getElementById('adx-rvol-' + col).innerText = 'SAR: ' + Number(eq.sar1m.valorAtual).toFixed(data.pricePrecision || 4) + ' (ant: ' + eq.sar1m.posicaoAnterior + ')';
          document.getElementById('rsi-' + col).innerText = lc.rsi14_valor + ' ' + lc.rsi14_inclinacao;
          const trendEl = document.getElementById('trend-' + col);
          const ehLong = data.direcaoSar === 'LONG';
          trendEl.innerHTML = '<span style="color:' + (ehLong ? 'var(--green)' : 'var(--red)') + '; font-weight:800;">SAR ' + (ehLong ? 'ALTA [COMPRA]' : 'BAIXA [VENDA]') + '</span>';
          const modoBadge = document.getElementById('modo-badge-' + col);
          if (modoBadge) {
            modoBadge.innerText = eq.sar1m.virouAgora ? '[SAR VIROU AGORA]' : '[AGUARDANDO VIRADA SAR]';
            const corModo = eq.sar1m.virouAgora ? 'var(--green)' : 'var(--text-muted)';
            modoBadge.style.color = corModo;
            modoBadge.style.borderColor = corModo;
            modoBadge.style.background = 'rgba(255,255,255,0.06)';
            cardHasActiveSetup[col] = !!eq.sar1m.virouAgora;
          }
        }

        // Projeção de Risco Quantitativo
        document.getElementById('proj-alav-' + col).innerText = (data.leverageSugerida || 3) + 'x';
        document.getElementById('proj-entry-' + col).innerText = '$ ' + parseFloat(data.preco).toFixed(4);
        document.getElementById('proj-sl-' + col).innerText = data.slPrice ? ('$ ' + data.slPrice.toFixed(data.pricePrecision || 4) + ' (-' + data.slRoe + '%)') : ('-' + data.slRoe + '% ROI');
        document.getElementById('proj-be-' + col).innerText = '--';
        document.getElementById('proj-tp-' + col).innerText = 'Lucro livre';

        // Ajusta slider se vazio
        const alavEl = document.getElementById('alav-' + col);
        if (alavEl && !alavEl.dataset.userModified && data.leverageSugerida) {
          alavEl.value = data.leverageSugerida;
          document.getElementById('alav-val-' + col).innerText = data.leverageSugerida + 'x';
        }

        // ── POSIÇÃO ABERTA (ALTO DESTAQUE VISUAL COM GLOW) ──
        const posBox = document.getElementById('pos-' + col);
        const cardEl = document.getElementById('card-' + col);
        const outroCol = (col === 1 ? 2 : 1);
        const outroSlotSym = window.dAutoBotSlots ? window.dAutoBotSlots[outroCol]?.symbol : null;
        const pertenceOutroSlot = outroSlotSym && outroSlotSym === sym;

        if (data.pos && parseFloat(data.pos.quantidade) !== 0 && !pertenceOutroSlot) {
          cardHasPosition[col] = true;
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
            cardEl.classList.add('has-pos');
            cardEl.classList.toggle('has-pos-win', isProfit);
            cardEl.classList.toggle('has-pos-loss', !isProfit);
            cardEl.style.borderColor = isProfit ? 'rgba(16, 185, 129, 0.75)' : 'rgba(239, 68, 68, 0.75)';
            cardEl.style.boxShadow = '0 0 25px ' + (isProfit ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)');
          }

          const prec = data.pricePrecision || 4;
          document.getElementById('pos-entry-' + col).innerText = '$ ' + Number(p.precoEntrada).toFixed(prec);

          // Banner de Status da Posição (Trava Curta -1.0% ROI / Respiro Livre até +2.20%)
          const beEl = document.getElementById('pos-be-status-' + col);
          if (beEl) {
            beEl.style.display = 'block';
            beEl.className = 'pos-be-banner';
            const maxR = (data.maxRoiReached || 0).toFixed(2);

            beEl.style.background = 'rgba(16, 185, 129, 0.15)';
            beEl.style.borderColor = 'var(--green)';
            beEl.style.color = 'var(--green)';
            beEl.innerText = data.beLabel || ('[🏄 SURFANDO SAR 1m | PICO +' + maxR + '%]');
          }
        } else {
          cardHasPosition[col] = false;
          posBox.style.display = 'none';
          const beEl = document.getElementById('pos-be-status-' + col);
          if (beEl) beEl.style.display = 'none';
          if (cardEl) {
            cardEl.classList.remove('has-pos', 'has-pos-win', 'has-pos-loss');
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
              '<div>• Saída: virada do Parabolic SAR 1m (sem TP fixo)</div>' +

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

    async function fecharSlotAgora(sym) {
      sym = String(sym || '').trim().toUpperCase();
      if (!sym) return;
      if (!sym.endsWith('USDT')) sym += 'USDT';
      if (!(await askConfirm('Fechar agora', 'Encerrar 100% de <b style="color:var(--gold);">' + escHtml(sym) + '</b> a mercado?'))) return;
      try {
        const res = await fetch('/api/close', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ symbol: sym }) });
        const data = await res.json();
        if (!data.success) alert('Erro ao fechar ' + sym + ': ' + (data.error || res.status));
        try { carregarSaldo(); carregarPlacar(); } catch (e) {}
      } catch (e) { alert('Erro ao fechar ' + sym + ': ' + e.message); }
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
      if (!(await askConfirm('⚠️ Reset Total de Ciclo', 'Deseja ZERAR o placar e marco zero (mantendo Base Capital Operacional de 20.00 USDT)?'))) return;
      try {
        const r = await fetch('/api/limpar-placar', { method: 'POST' });
        const d = await r.json();
        if (d.success) {
          document.getElementById('placar-wins').innerText = '0 W';
          document.getElementById('placar-losses').innerText = '0 L';
          const wrEl = document.getElementById('placar-wr');
          if (wrEl) wrEl.innerText = '0% WR';
          historicoMarcoZero = d.marcoZero || Date.now();
          carregarSaldo();
          carregarPlacar();
          if (typeof carregarBaseCapital === 'function') carregarBaseCapital();
          if (typeof carregarHistoricoCompleto === 'function') carregarHistoricoCompleto();
          askConfirm('✓ Sucesso', 'Ciclo resetado com sucesso! Placar e Marco Zero sincronizados na Base Operacional de 20.00 USDT.', true);
        }
      } catch(e) {}
    }

    // ── SCALP 1M: CICLO SNIPER DE 2 MIN (GET /api/scalp-1m a cada 1 s; relógio avança no cliente) ──
    let scalpDados = null, scalpRecebidoEm = 0, scalpBuscando = false;
    function escHtml(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
    function scalpUsd(v) {
      if (v == null || !isFinite(v)) return '--';
      return (v >= 0 ? '+$ ' : '-$ ') + Math.abs(v).toFixed(4);
    }
    function scalpPct(v) { return v == null || !isFinite(v) ? '--' : Number(v).toFixed(1) + '%'; }
    function scalpCor(v) { return v == null || !isFinite(v) || v === 0 ? 'var(--text-muted)' : (v > 0 ? 'var(--green)' : 'var(--red)'); }
    function scalpPreco(v) {
      if (v == null || !isFinite(v)) return '--';
      const n = Number(v);
      return n >= 100 ? n.toFixed(2) : (n >= 1 ? n.toFixed(4) : n.toFixed(5));
    }
    function scalpMmss(ms) {
      const s = Math.max(0, Math.ceil(ms / 1000));
      return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }
    function scalpRelogio(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      return String(Math.floor(s / 60)) + ':' + String(s % 60).padStart(2, '0');
    }
    function scalpDirHtml(dir) {
      if (dir !== 'LONG' && dir !== 'SHORT') return '<span class="scalp-mini">' + escHtml(dir || '--') + '</span>';
      return '<span class="scalp-dir ' + (dir === 'LONG' ? 'scalp-long' : 'scalp-short') + '">' + escHtml(dir) + '</span>';
    }
    const SCALP_STATUS_TXT = { ENTRANDO: 'Entrando (GTX)', ATIVO: 'Ativo', SAINDO_LIMITE: 'Saindo (limite)', FECHANDO: 'Fechando', ORFA: 'Órfã' };
    const SCALP_TURNO_TXT = { AGUARDANDO: 'aguardando', AVALIANDO: 'avaliando', ENTRANDO: 'entrando', ATIVO: 'em curso', FECHADO: 'fechado', VAZIO: 'vazio' };
    const SCALP_FASE_TXT = { ABERTO: 'ABERTO', ANALISE: 'ANÁLISE', CONFIRMACAO: 'CONFIRMAÇÃO' };

    async function atualizarScalpTurno() {
      if (scalpBuscando) return;
      scalpBuscando = true;
      try {
        const r = await fetch('/api/scalp-1m');
        const d = await r.json();
        if (d && d.success) { scalpDados = d; scalpRecebidoEm = Date.now(); renderScalpTurno(); }
      } catch (e) {
        const el = document.getElementById('scalp-estado');
        if (el) { el.textContent = 'Sem conexão com o painel'; el.style.color = 'var(--red)'; }
      } finally {
        scalpBuscando = false;
      }
    }

    function renderScalpTurno() {
      const d = scalpDados;
      if (!d) return;
      const decorrido = Date.now() - scalpRecebidoEm;
      const ta = d.turnoAtual || {};
      const cfg = d.config || {};
      const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; return el; };
      // Placar W/L no topo do scalp: espelha os contadores de carregarPlacar() (/api/win-loss), que ficam na barra oculta
      [['placar-wins', 'scalp-placar-w'], ['placar-losses', 'scalp-placar-l'], ['placar-wr', 'scalp-placar-wr']].forEach(([de, para]) => {
        const o = document.getElementById(de); if (o) setTxt(para, o.textContent);
      });
      const estadoEl = document.getElementById('scalp-estado');
      if (estadoEl) {
        if (!d.enabled) { estadoEl.textContent = 'Desligado'; estadoEl.style.color = 'var(--text-muted)'; }
        else if (!d.testnet) { estadoEl.textContent = 'Bloqueado: base não é testnet'; estadoEl.style.color = 'var(--red)'; }
        else { estadoEl.textContent = 'Ligado · testnet'; estadoEl.style.color = 'var(--green)'; }
      }
      // Relógio do ciclo Sniper: 0:00-0:20 ABERTO, 0:20-1:40 ANÁLISE, 1:40-2:00 CONFIRMAÇÃO
      const cicloMs = cfg.turnoMs || 120000, iniAnalise = cfg.faseAnaliseIniMs || 20000, iniConf = cfg.faseConfirmacaoIniMs || 100000;
      const dentro = (((d.ciclo && d.ciclo.dentroMs) || 0) + decorrido) % cicloMs;
      const fase = dentro < iniAnalise ? 'ABERTO' : (dentro < iniConf ? 'ANALISE' : 'CONFIRMACAO');
      const fimFase = fase === 'ABERTO' ? iniAnalise : (fase === 'ANALISE' ? iniConf : cicloMs);
      setTxt('scalp-relogio', scalpRelogio(dentro));
      const faseEl = setTxt('scalp-fase', SCALP_FASE_TXT[fase]);
      if (faseEl) faseEl.className = 'sc-fase sc-fase-' + fase;
      setTxt('scalp-contagem', scalpMmss(fimFase - dentro));
      setTxt('scalp-ciclo-resta', scalpMmss(cicloMs - dentro));
      const barra = document.getElementById('scalp-barra-pos');
      if (barra) barra.style.left = (dentro / cicloMs * 100).toFixed(2) + '%';
      setTxt('scalp-turno-num', ta.numero ? '#' + ta.numero + ' · ' + (SCALP_TURNO_TXT[ta.status] || ta.status) : '--');
      const somaEl = document.getElementById('scalp-soma-turno');
      if (somaEl) {
        const st = ta.somaTurno || {};
        somaEl.innerHTML = '<span style="color:' + scalpCor(st.testnet) + ';">' + escHtml(scalpUsd(st.testnet)) + '</span>' +
          '<span class="scalp-mini"> ' + escHtml(String(st.trades || 0)) + ' op.</span>';
      }
      const proxEl = document.getElementById('scalp-proximas');
      if (proxEl) {
        const px = d.proximas || [];
        proxEl.innerHTML = px.length
          ? px.map(p => escHtml(p.simbolo) + ' ' + scalpDirHtml(p.direcao)).join(' ')
          : '<span class="scalp-mini">' + (fase === 'CONFIRMACAO' ? 'confirmando...' : '--') + '</span>';
      }
      // Topo: saldo, PnL do dia, taxas, win rate, expectativa
      const hojeEl = document.getElementById('scalp-hoje');
      if (hojeEl && d.hoje) {
        const h = d.hoje;
        const g = d.jev || {};
        const kpi = (rot, val, cor) => '<div class="sc-kpi"><span class="scalp-mini">' + escHtml(rot) + '</span><b' + (cor ? ' style="color:' + cor + ';"' : '') + '>' + val + '</b></div>';
        hojeEl.innerHTML =
          kpi('Saldo', escHtml('$ ' + Number(saldoGlobal || 0).toFixed(2))) +
          kpi('PnL do dia', escHtml(scalpUsd(h.pnlLiquido)), scalpCor(h.pnlLiquido)) +
          kpi('Taxas', escHtml('$ ' + Number(h.taxasPagas || 0).toFixed(4))) +
          kpi('Win rate', escHtml(scalpPct(h.winRatePorOperacao)) + ' <span class="scalp-mini">' + escHtml(h.operacoes) + ' op.</span>') +
          kpi('Expectativa / op.', escHtml(scalpUsd(h.expectativaLiquidaMediaPorOperacao)), scalpCor(h.expectativaLiquidaMediaPorOperacao)) +
          kpi('Turnos', escHtml(h.turnos) + ' <span class="scalp-mini">' + escHtml(h.positivos) + '+ ' + escHtml(h.negativos) + '− ' + escHtml(h.turnosVazios) + 'v</span>') +
          kpi('Jev = código', escHtml(scalpPct(g.taxaConcorda === null || g.taxaConcorda === undefined ? null : g.taxaConcorda * 100)) + ' <span class="scalp-mini">' + escHtml(g.concorda || 0) + '/' + escHtml(g.comOpiniao || 0) + (g.ativo === false ? ' · sem chave' : '') + '</span>') +
          kpi('Latência Jev', escHtml(g.latenciaMediaMs === null || g.latenciaMediaMs === undefined ? '--' : g.latenciaMediaMs + ' ms') + ' <span class="scalp-mini">' + escHtml(g.timeouts || 0) + ' timeout</span>') +
          kpi('Maker ent./saí.', escHtml(scalpPct(d.maker_entrada_pct)) + ' <span class="scalp-mini">/</span> ' + escHtml(scalpPct(d.maker_saida_pct)));
      }
      // Cards dos slots 3 e 4
      const slotsEl = document.getElementById('scalp-slots');
      if (slotsEl) {
        const porSlot = {};
        (ta.slots || []).forEach(s => { porSlot[s.slot] = s; });
        slotsEl.innerHTML = [3, 4].map(n => {
          const s = porSlot[n];
          if (!s) return '<div class="scalp-slot scalp-slot-livre"><span class="scalp-slot-n">Slot ' + (n - 2) + '</span><span class="scalp-mini">LIVRE</span><span></span></div>';
          const seg = s.segundosRestantes == null ? null : Math.max(0, s.segundosRestantes - Math.floor(decorrido / 1000));
          const cls = s.status === 'ORFA' ? ' scalp-slot-orfa' : (s.direcao === 'LONG' ? ' scalp-slot-long' : ' scalp-slot-short');
          return '<div class="scalp-slot' + cls + '">' +
            '<span class="scalp-slot-n">Slot ' + (n - 2) + '</span>' +
            '<span><span class="scalp-moeda">' + escHtml(s.moeda) + '</span> ' + scalpDirHtml(s.direcao) + '</span>' +
            '<span class="scalp-pnl" style="color:' + scalpCor(s.pnlAoVivo) + ';">' + escHtml(scalpUsd(s.pnlAoVivo)) + (s.pnlAoVivo == null ? '' : ' <small>(' + escHtml((s.pnlAoVivo / 10 * 100).toFixed(2)) + '% margem)</small>') + '</span>' +
            '<span class="scalp-status">' + escHtml(SCALP_STATUS_TXT[s.status] || s.status) + ' <button class="btn-close" style="padding:2px 8px;font-size:0.65rem;margin-left:6px;" data-sym="' + escHtml(s.moeda) + '" onclick="fecharSlotAgora(this.dataset.sym)">FECHAR AGORA</button></span>' +
            '<span class="scalp-campo"><span class="scalp-mini">Entrada</span> ' + escHtml(scalpPreco(s.precoEntrada)) + '</span>' +
            '<span class="scalp-campo" style="text-align:right;"><span class="scalp-mini">Restam</span> <b>' + (seg == null ? '--' : escHtml(seg + ' s')) + '</b>' + (seg == null ? '' : '<div class="sc-barra" style="margin-top:3px;"><span style="display:block;height:100%;width:' + Math.round(100 * seg / ((cfg.holdMs || 120000) / 1000)) + '%;background:var(--gold);"></span></div>') + '</span>' +
          '</div>';
        }).join('');
      }
      // Ranking ao vivo: as 20 da lista com rodízio, em 2 colunas de 10 linhas (sem barra de rolagem)
      const rkEl = document.getElementById('scalp-ranking');
      const rkB = document.getElementById('scalp-ranking-b');
      if (rkEl && rkB) {
        const uni = d.universo || [];
        const origem = {}; uni.forEach(u => { origem[u.simbolo] = u.origem; });
        const analisado = (d.ranking || []).length > 0;
        // Antes da 1ª análise do processo: mostra a lista montada (volume/ATR) sem score/direção
        const rk = analisado ? d.ranking : uni.map(u => ({ simbolo: u.simbolo, volume_24h: u.volume_24h, atr: u.atr_pct, score: null, direcao: null, condicoes_ok: null }));
        const nEl = document.getElementById('scalp-ranking-n');
        if (nEl) nEl.textContent = String(rk.length || (d.simbolos || []).length || 20);
        const rotEl = document.getElementById('scalp-rotacao');
        const rot = d.rotacao || {};
        if (rotEl) rotEl.textContent = rot.ciclosRestantes == null ? 'lista troca em -- ciclos' : (rot.ciclosRestantes === 0 ? 'lista troca agora' : 'lista troca em ' + rot.ciclosRestantes + (rot.ciclosRestantes === 1 ? ' ciclo' : ' ciclos'));
        const fmtVol = (v) => { const n = Number(v); return !Number.isFinite(n) || v == null ? '--' : (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : (n / 1e6).toFixed(0) + 'M'); };
        const cab = '<tr><th style="width:6%">#</th><th style="width:19%">Moeda</th><th style="width:11%">Vol 24h</th><th style="width:11%">ATR%</th><th style="width:10%">Score</th><th style="width:14%">Dir.</th><th style="width:8%">C</th><th style="width:21%">Selo</th></tr>';
        const linha = (c, i) => {
          const selos = (c.fora1Ciclo ? '<span class="scalp-chip scalp-chip-neg" title="Prejuízo, zero ou erro: fora só do próximo ciclo">fora 1 ciclo</span>' : '') +
            (!c.fora1Ciclo && origem[c.simbolo] === 'REPETIDA' ? '<span class="scalp-mini" title="Repetiu da lista anterior">repetiu</span>' : '') +
            (!c.fora1Ciclo && (origem[c.simbolo] === 'NOVA' || origem[c.simbolo] === 'ATR_PROXIMO') ? '<span class="scalp-mini" style="color:var(--green);" title="Entrou na lista agora">nova</span>' : '');
          const nome = String(c.simbolo).replace(/USDT$/, '');
          return '<tr title="' + escHtml(c.simbolo) + (c.bloqueio ? ' · ' + escHtml(c.bloqueio) + ' ' + escHtml(c.bloqueio_detalhe || '') : '') + '"><td>' + escHtml(i + 1) + '</td><td>' + escHtml(nome) +
            (c.bloqueio ? ' <span class="scalp-chip scalp-chip-neg">!</span>' : '') + '</td><td class="sc-num">' + escHtml(fmtVol(c.volume_24h)) + '</td><td class="sc-num">' +
            escHtml(Number.isFinite(Number(c.atr)) && c.atr != null ? Number(c.atr).toFixed(3) : '--') + '</td><td class="sc-num">' + escHtml(c.score == null ? '--' : Number(c.score).toFixed(2)) + '</td><td>' +
            (c.direcao ? scalpDirHtml(c.direcao) : '<span class="scalp-mini">--</span>') + '</td><td class="sc-num">' + escHtml(c.condicoes_ok == null ? '-' : c.condicoes_ok + '/5') + '</td><td>' + (selos || '<span class="scalp-mini">--</span>') + '</td></tr>';
        };
        const metade = Math.ceil(Math.max(rk.length, 20) / 2);
        const vazio = '<tr><td colspan="8" class="scalp-mini">aguardando a lista de 20 moedas...</td></tr>';
        rkEl.innerHTML = cab + (rk.length ? rk.slice(0, metade).map((c, i) => linha(c, i)).join('') : vazio);
        rkB.innerHTML = cab + rk.slice(metade).map((c, i) => linha(c, i + metade)).join('');
      }
      // Histórico dos últimos 10 turnos
      const hiEl = document.getElementById('scalp-historico');
      if (hiEl) {
        const hs = (d.historico || []).slice(0, 10);
        hiEl.innerHTML = '<tr><th>Turno</th><th>Moedas</th><th>Direção</th><th>Soma líq.</th></tr>' + (hs.length
          ? hs.map(u => {
              const cls = u.vazio || u.positivo == null ? 'sc-neutro' : (u.positivo ? 'sc-pos' : 'sc-neg');
              const moedas = (u.moedas || []).length ? (u.moedas || []).map(escHtml).join(' / ') : 'VAZIO';
              const dirs = u.vazio ? escHtml(u.motivo || '') : (u.direcoes || []).map(escHtml).join(' / ');
              return '<tr class="' + cls + '"><td>#' + escHtml(u.numero) + '</td><td>' + moedas + '</td><td>' + dirs + '</td><td class="sc-num">' + escHtml(u.vazio ? '--' : scalpUsd(u.somaLiquida)) + '</td></tr>';
            }).join('')
          : '<tr><td colspan="4" class="scalp-mini">sem turnos hoje</td></tr>');
      }
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
          window.dAutoBotSlots = d.slots;
          window.dTopCandidatos = d.topCandidatos || [];
          // PSAR desligado e sem posição PSAR (o servidor só conta slots 1/2 e alvos não-scalp): a tela vira só o scalp.
          // Sem checar a posição dos cards 1/2: eles carregam ETH/SOL do localStorage e a posição SCALP nessas moedas mantinha o PSAR na tela.
          const psarOcultar = d.psarOcultar === true;
          document.body.classList.toggle('modo-scalp', psarOcultar);
          const psarGrid = document.getElementById('psar-grid');
          if (psarGrid) psarGrid.style.display = psarOcultar ? 'none' : '';

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

            // Trava estrita de desduplicação frontal: ambos slots nunca podem ter o mesmo par
            const s1 = (document.getElementById('sym-1')?.value || '').trim().toUpperCase();
            const s2 = (document.getElementById('sym-2')?.value || '').trim().toUpperCase();
            if (s1 && s2 && s1 === s2) {
              const s1TemPos = !!(d.slots && d.slots[1] && d.slots[1].symbol === s1);
              const colTrocar = s1TemPos ? 2 : 1;
              const candAlternativo = (d.topCandidatos && d.topCandidatos.find(c => c.symbol !== s1)?.symbol) ||
                                      (window.listaVolateisCache && window.listaVolateisCache.find(c => c.symbol !== s1)?.symbol) ||
                                      'SOLUSDT';
              console.warn('[DESDUPLICAÇÃO] Ambos slots estavam com ' + s1 + '. Trocando Slot ' + colTrocar + ' para ' + candAlternativo);
              document.getElementById('sym-' + colTrocar).value = candAlternativo;
              debouncedLoad(colTrocar);
            }
          } else {
            btn.innerText = 'LIGAR ROBÔ IA';
            btn.style.background = 'rgba(16, 185, 129, 0.2)';
            btn.style.borderColor = 'var(--green)';
            btn.style.color = 'var(--green)';
            statusTxt.innerText = 'Robô Desligado';
            statusTxt.style.color = 'var(--text-muted)';
          }

          // ── AUTO-ROTAÇÃO VISUAL DOS 2 CARDS NA TELA (Item 4) ──
          const nowTime = Date.now();
          [1, 2].forEach(col => {
            const sl = d.slots ? d.slots[col] : null;
            const temPosicaoAberta = cardHasPosition[col] || !!(sl && sl.symbol);
            const semSetupAtivo = !cardHasActiveSetup[col];
            const tempoSemEdicao = nowTime - (lastUserInteraction[col] || 0);
            const tempoDesdeRotacao = nowTime - (lastAutoRotateTime[col] || 0);

            // Condição: Slot SEM posição aberta na Binance + Card com [SEM SETUP ATIVO] + Usuário sem digitar nos últimos 2 minutos
            if (!temPosicaoAberta && semSetupAtivo && tempoSemEdicao >= 120000 && tempoDesdeRotacao >= 15000) {
              if (d.topCandidatos && d.topCandidatos.length > 0) {
                const outroCol = (col === 1 ? 2 : 1);
                const outroSym = (document.getElementById('sym-' + outroCol)?.value || '').trim().toUpperCase();
                const curSym = (document.getElementById('sym-' + col)?.value || '').trim().toUpperCase();

                const candIdeal = d.topCandidatos.find(c => c.symbol !== outroSym && c.symbol !== curSym) ||
                                  d.topCandidatos.find(c => c.symbol !== outroSym);

                if (candIdeal && candIdeal.symbol && candIdeal.symbol !== curSym) {
                  console.log('[AUTO-ROTAÇÃO] Card ' + col + ' [SEM SETUP: ' + curSym + '] -> Rotacionando para: ' + candIdeal.symbol + ' (' + candIdeal.modoLabel + ')');
                  const symInput = document.getElementById('sym-' + col);
                  if (symInput) {
                    symInput.value = candIdeal.symbol;
                    lastAutoRotateTime[col] = nowTime;
                    debouncedLoad(col);
                  }
                }
              }
            }
          });

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


    // ── MODAL BASE CAPITAL (20 USDT) ──
    let baseCapitalCache = null;
    let abaBaseCapital = 'hoje';

    function abrirBaseCapital() {
      document.getElementById('modal-base-capital').style.display = 'flex';
      carregarBaseCapital();
    }

    function fecharBaseCapital() {
      document.getElementById('modal-base-capital').style.display = 'none';
    }

    function mudarAbaBaseCapital(aba) {
      abaBaseCapital = aba;
      atualizarNavBaseCapital();
      renderizarBaseCapital();
    }

    function navegarBaseCapital(dir) {
      if (dir < 0) {
        mudarAbaBaseCapital('ontem');
      } else {
        mudarAbaBaseCapital('hoje');
      }
    }

    function atualizarNavBaseCapital() {
      const btnOntem = document.getElementById('bc-tab-ontem');
      const btnHoje = document.getElementById('bc-tab-hoje');
      const arrowPrev = document.getElementById('bc-nav-prev');
      const arrowNext = document.getElementById('bc-nav-next');
      if (!btnOntem || !btnHoje || !arrowPrev || !arrowNext) return;

      if (abaBaseCapital === 'ontem') {
        btnOntem.style.background = 'var(--gold)';
        btnOntem.style.color = '#000';
        btnOntem.style.fontWeight = '800';
        btnHoje.style.background = 'transparent';
        btnHoje.style.color = 'var(--text-muted)';
        btnHoje.style.fontWeight = '700';

        arrowPrev.style.opacity = '0.35';
        arrowPrev.style.cursor = 'not-allowed';
        arrowNext.style.opacity = '1';
        arrowNext.style.cursor = 'pointer';
      } else {
        btnHoje.style.background = 'var(--gold)';
        btnHoje.style.color = '#000';
        btnHoje.style.fontWeight = '800';
        btnOntem.style.background = 'transparent';
        btnOntem.style.color = 'var(--text-muted)';
        btnOntem.style.fontWeight = '700';

        arrowPrev.style.opacity = '1';
        arrowPrev.style.cursor = 'pointer';
        arrowNext.style.opacity = '0.35';
        arrowNext.style.cursor = 'not-allowed';
      }
    }

    async function carregarBaseCapital() {
      const container = document.getElementById('bc-conteudo');
      if (!container) return;
      container.innerHTML = '<div style="padding:30px; color:var(--text-muted); font-weight:600;">Carregando dados da Binance...</div>';
      atualizarNavBaseCapital();
      try {
        const res = await fetch('/api/base-capital-pnl');
        const data = await res.json();
        if (data.success) {
          baseCapitalCache = data;
          renderizarBaseCapital();
        } else {
          container.innerHTML = '<div style="padding:30px; color:var(--red); font-weight:700;">Erro: ' + escHtml(data.error || 'Falha ao carregar') + '</div>';
        }
      } catch(e) {
        container.innerHTML = '<div style="padding:30px; color:var(--red); font-weight:700;">Falha de comunicação</div>';
      }
    }

    function renderizarBaseCapital() {
      if (!baseCapitalCache) return;
      const container = document.getElementById('bc-conteudo');
      if (!container) return;
      const d = baseCapitalCache[abaBaseCapital];
      if (!d) return;

      const isProfit = d.pnlLiquido >= 0;
      const cor = isProfit ? 'var(--green)' : 'var(--red)';
      const glow = isProfit ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)';
      const bgCard = isProfit
        ? 'linear-gradient(180deg, rgba(16,185,129,0.12) 0%, rgba(6,78,59,0.2) 100%)'
        : 'linear-gradient(180deg, rgba(239,68,68,0.12) 0%, rgba(127,29,29,0.2) 100%)';
      const sinal = isProfit ? '+' : '';
      const sinalUsdt = d.pnlLiquido >= 0 ? '+$ ' : '-$ ';
      const sinalBrl = d.pnlBrl >= 0 ? '+R$ ' : '-R$ ';

      const brlRate = baseCapitalCache.brl || 5.20;
      const baseOp = baseCapitalCache.baseCapitalOperacional || baseCapitalCache.baseCapital || 20.00;
      const baseBrl = (baseOp * brlRate).toFixed(2);

      let html = '<div style="background:' + bgCard + '; border: 1.5px solid ' + cor + '; border-radius: 16px; padding: 20px; box-shadow: 0 0 25px ' + glow + '; margin-bottom: 20px;">' +
          '<div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">' +
            abaBaseCapital.toUpperCase() + ' (' + d.dataStr + ')' +
          '</div>' +
          '<div style="font-size: 2.8rem; font-weight: 900; color: ' + cor + '; text-shadow: 0 0 20px ' + glow + '; margin: 4px 0; font-family: monospace;">' +
            sinal + d.roiPct.toFixed(2) + '%' +
          '</div>' +
          '<div style="font-size: 1.35rem; font-weight: 800; color: #FFF; margin-bottom: 4px;">' +
            sinalUsdt + Math.abs(d.pnlLiquido).toFixed(2) + ' USDT' +
          '</div>' +
          '<div style="font-size: 1.05rem; font-weight: 700; color: ' + (isProfit ? '#34D399' : '#F87171') + '; margin-bottom: 12px;">' +
            sinalBrl + Math.abs(d.pnlBrl).toFixed(2) + ' BRL' +
          '</div>' +
          '<div style="font-size: 0.78rem; color: var(--text-muted); border-top: 1px dashed rgba(255,255,255,0.12); padding-top: 10px;">' +
            'Capital Base Operacional: <b style="color:var(--gold);">' + Number(baseOp).toFixed(2) + ' USDT (2x 10 USDT)</b> (R$ ' + baseBrl + ')' +
          '</div>' +
        '</div>';

      html += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">' +
          '<div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 10px; padding: 10px; text-align: center;">' +
            '<div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">PnL Operacional</div>' +
            '<div style="font-size: 1rem; font-weight: 800; color: ' + (d.pnlBruto >= 0 ? 'var(--green)' : 'var(--red)') + '; font-family: monospace; margin-top: 2px;">' +
              (d.pnlBruto >= 0 ? '+$ ' : '-$ ') + Math.abs(d.pnlBruto).toFixed(2) +
            '</div>' +
          '</div>' +
          '<div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 10px; padding: 10px; text-align: center;">' +
            '<div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Taxas Corretagem</div>' +
            '<div style="font-size: 1rem; font-weight: 800; color: var(--gold); font-family: monospace; margin-top: 2px;">' +
              '-$ ' + Math.abs(d.taxas).toFixed(2) +
            '</div>' +
          '</div>' +
          '<div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 10px; padding: 10px; text-align: center;">' +
            '<div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Funding Fee</div>' +
            '<div style="font-size: 1rem; font-weight: 800; color: ' + (d.funding >= 0 ? 'var(--green)' : 'var(--gold)') + '; font-family: monospace; margin-top: 2px;">' +
              (d.funding >= 0 ? '+$ ' : '-$ ') + Math.abs(d.funding).toFixed(4) +
            '</div>' +
          '</div>' +
          '<div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 10px; padding: 10px; text-align: center;">' +
            '<div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Ordens no Dia</div>' +
            '<div style="font-size: 1rem; font-weight: 800; color: var(--text); font-family: monospace; margin-top: 2px;">' +
              d.tradesCount + ' trades' +
            '</div>' +
          '</div>' +
        '</div>';

      container.innerHTML = html;
    }

    let historicoMarcoZero = 0;

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
        if (!btn) return;
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
        historicoMarcoZero = data.marcoZero || 0;
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

      if (abaAtualHist === 'hoje') {
        const marcoRef = historicoMarcoZero || 0;
        const hojeTrades = todosTradesCache.filter(g => {
          const t = g.time || g.entryTime;
          return t && (t >= marcoRef);
        });
        container.innerHTML = renderAbaComResumo(hojeTrades, 'Hoje', 'Operações do Ciclo Atual (Hoje)');
      } else if (abaAtualHist === 'todas') {
        container.innerHTML = renderAbaComResumo(todosTradesCache, 'Todas', 'Todas as Operações');
      } else {
        const cicloTrades = (historicoMarcoZero && historicoMarcoZero > 0)
          ? todosTradesCache.filter(g => g.time >= historicoMarcoZero)
          : [];
        const listaPeriodo = cicloTrades.length > 0 ? cicloTrades : [];
        container.innerHTML = renderAbaComResumo(listaPeriodo, 'Ciclo Atual', 'Operações do Ciclo Atual');
      }
    }

    function renderAbaComResumo(lista, titulo, subtitulo) {
      if (!lista || lista.length === 0) {
        return '<div style="text-align:center; padding:30px; color:var(--text-muted); font-weight:600;">Nenhum trade encontrado em ' + subtitulo + '.</div>';
      }

      let totWin = 0, totLoss = 0, totPnl = 0, totFee = 0;
      lista.forEach(g => {
        if (g.pnl > 0.0001 || g.result === 'WIN') totWin++;
        else totLoss++;
        totPnl += g.pnl;
        totFee += (g.fee || 0);
      });

      const winRate = (totWin + totLoss) > 0 ? Math.round((totWin / (totWin + totLoss)) * 100) : 0;
      let html = '<div class="hist-summary-grid">' +
          '<div class="hist-stat-card">' +
            '<div class="hist-stat-title">Taxa de Acerto (' + titulo + ')</div>' +
            '<div class="hist-stat-val" style="color:' + (winRate >= 50 ? 'var(--green)' : 'var(--gold)') + ';">' + winRate + '% <span class="hist-stat-count">(' + totWin + 'W / ' + totLoss + 'L)</span></div>' +
          '</div>' +
          '<div class="hist-stat-card">' +
            '<div class="hist-stat-title">PnL Líquido (' + titulo + ')</div>' +
            '<div class="hist-stat-val" style="color:' + (totPnl >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + (totPnl >= 0 ? '+$ ' : '-$ ') + Math.abs(totPnl).toFixed(2) + '</div>' +
          '</div>' +
          '<div class="hist-stat-card">' +
            '<div class="hist-stat-title">Corretagem (' + titulo + ')</div>' +
            '<div class="hist-stat-val text-gold">-$ ' + totFee.toFixed(2) + '</div>' +
          '</div>' +
        '</div>';

      html += renderListaSimples(lista.slice(0, 80), subtitulo);
      return html;
    }

    function renderListaSimples(lista, titulo) {
      if (lista.length === 0) return '<div style="text-align:center; padding:30px; color:var(--text-muted); font-weight:600;">Nenhum trade encontrado em ' + titulo + '.</div>';
      let html = '<div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:14px; font-weight:700;">Exibindo ' + lista.length + ' operações (' + titulo + ')</div>';
      lista.forEach(g => {
        const isWin = g.pnl > 0.0001 || g.result === 'WIN';
        const cor = isWin ? '#10B981' : '#EF4444';
        const borderCor = isWin ? 'var(--green)' : 'var(--red)';
        const bgBadge = isWin ? 'rgba(16,185,129,0.18)' : 'rgba(239,68,68,0.18)';
        const dataStr = g.dataBrasil || new Date(g.time || g.entryTime).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const tag = isWin ? 'WIN' : 'LOSS';
        let motivoFmt = g.exitReason || '';
        if (motivoFmt.includes('SAIDA_SAR_VIRADA')) {
          motivoFmt = '🏄 VIRADA SAR';
        } else if (motivoFmt.includes('CATRACA') || motivoFmt === 'BREAKEVEN') {
          motivoFmt = '🛡️ CATRACA';
        } else if (motivoFmt.includes('RESGATE')) {
          motivoFmt = '🚑 RESGATE REPIQUE';
        } else if (motivoFmt.includes('TP_FUNIL')) {
          motivoFmt = '⏳ TP FUNIL';
        } else if (motivoFmt.includes('SL_FUNIL')) {
          motivoFmt = '⏳ SL FUNIL';
        }
        const motivoTxt = motivoFmt ? ('[' + motivoFmt + ']') : '';
        const roiVal = parseFloat(g.roi || 0);
        const roiTxt = (roiVal >= 0 ? '+' : '') + roiVal.toFixed(2) + '% ROI';
        const isShort = String(g.side).toUpperCase() === 'SHORT';
        const sideTxt = (g.side || 'TRADE') + (g.leverage ? (' ' + g.leverage + 'x') : '');

        const pEntrada = g.entryPrice ? ('$' + Number(g.entryPrice).toFixed(4)) : '--';
        const pSaida = g.exitPrice ? ('$' + Number(g.exitPrice).toFixed(4)) : '--';

        html += '<div class="trade-card-row" style="border-left: 4px solid ' + borderCor + ';">' +
            '<div class="trade-left">' +
              '<div class="trade-sym-row">' +
                '<span class="trade-sym">' + g.symbol + '</span>' +
                '<span class="trade-side-pill ' + (isShort ? 'pill-sell' : 'pill-buy') + '">' + sideTxt + '</span>' +
                '<span class="trade-tag-pill" style="color:' + cor + '; background:' + bgBadge + ';">' + tag + '</span>' +
                '<span style="font-size:0.75rem; color:var(--text-muted); font-family:monospace; margin-left:4px;">' + motivoTxt + ' ' + roiTxt + '</span>' +
              '</div>' +
              '<div class="trade-date">' + dataStr + ' • Entrada: ' + pEntrada + ' &rarr; Saída: ' + pSaida + '</div>' +
            '</div>' +
            '<div class="trade-right">' +
              '<div class="trade-pnl" style="color:' + cor + ';">' + (g.pnl >= 0 ? '+$ ' : '-$ ') + Math.abs(g.pnl).toFixed(2) + '</div>' +
              '<div class="trade-fee">Taxa: $ ' + Number(g.fee).toFixed(4) + '</div>' +
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
      let s1 = localStorage.getItem('sym-1');
      let s2 = localStorage.getItem('sym-2');
      if (s1 && s2 && s1 === s2) {
        s2 = null;
        localStorage.removeItem('sym-2');
      }
      if (s1 && s1 !== 'undefined' && s1 !== 'null') {
        document.getElementById('sym-1').value = s1;
        debouncedLoad(1);
      }
      if (s2 && s2 !== 'undefined' && s2 !== 'null') {
        document.getElementById('sym-2').value = s2;
        debouncedLoad(2);
      }
      carregarSaldo();
      carregarVolateis();
      carregarPlacar();
      atualizarStatusAutoBot();
      setInterval(carregarSaldo, 15000);
      setInterval(carregarVolateis, 60000);
      setInterval(carregarPlacar, 5000);
      setInterval(atualizarStatusAutoBot, 3000);
      atualizarScalpTurno();
      setInterval(atualizarScalpTurno, 1000); // /api/scalp-1m a cada 1 s
      setInterval(renderScalpTurno, 250);     // contagem regressiva no cliente
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
      // BLOCO 1.1: Limpeza atômica de travas de fechamento em memória no boot
      closingInProgress.clear();

      const posAtivas = await fut.todasPosicoes();
      const posComQtd = (Array.isArray(posAtivas) ? posAtivas : []).filter(p => parseFloat(p.positionAmt) !== 0);

      // BLOCO 1.3: Limpeza imediata de posições antigas travadas (MUSDT, fora da WHITELIST_VIP ou zumbi antigo de QNTUSDT)
      const scalpBoot = new Set(); // posições scalp_1m: nunca entram nos slots PSAR
      for (const p of posComQtd) {
        const alvoExistente = localAlvos[p.symbol];
        const duracaoBootMs = Date.now() - (alvoExistente?.openTime || p.atualizadoEm || Date.now());
        const isZombieQNT = (p.symbol === 'QNTUSDT' && duracaoBootMs > 2 * 3600 * 1000);

        if (alvoExistente?.modo === 'scalp_1m') {
          // Turno scalp em andamento: NÃO fecha a Market. Alvo mantido; o motor scalp retoma o monitoramento
          // (scalp1m.iniciar): limite aos 1:40, Market aos 2:00; openTime + HOLD_MS vencido = fecha no 1º ciclo.
          scalpBoot.add(p.symbol);
          if (!scalpLib.ehTestnet(fut.FAPI)) { // trava testnet: nenhuma ordem (nem o rearme do stop)
            console.error(`[SCALP-BOOT] ${p.symbol}: base de ordens não é testnet (${fut.FAPI}); stop scalp não rearmado`);
            continue;
          }
          if (!(alvoExistente.entryPrice > 0)) alvoExistente.entryPrice = p.precoEntrada;
          alvoExistente.slNaCorretora = false; // confere na corretora: stop ausente = rearma (stop_pct do alvo)
          const slOk = await scalp1m.garantirStopOrfa(p.symbol, alvoExistente, p).catch(() => false);
          console.warn(`[SCALP-BOOT] ${p.symbol}: turno scalp_1m em andamento (${p.lado} ${p.quantidade}); alvo mantido, monitor scalp retoma; stop ${slOk ? 'na corretora' : 'pendente: rearme no 1º ciclo do monitor'}`);
          continue;
        }
        if (p.symbol === 'MUSDT' || !WHITELIST_VIP.has(p.symbol) || isZombieQNT) {
          if (!scalpLib.ehTestnet(fut.FAPI)) { // trava testnet no ramo genérico: nenhuma ordem fora do testnet
            console.error(`[BOOT-LIMPEZA-ZUMBI] ${p.symbol}: base de ordens não é testnet (${fut.FAPI}); fechamento/cancelamento não enviado`);
            continue;
          }
          console.warn(`[BOOT-LIMPEZA-ZUMBI] Encerrando posição travada/fora da whitelist no boot: ${p.symbol} (${p.lado} ${p.quantidade})`);
          await fut.cancelarTodasOrdens(p.symbol).catch(() => {});
          await fut.fecharMercado(p.symbol, p.lado, p.quantidade).catch(e => {
            console.error(`[BOOT] Erro ao fechar ${p.symbol}:`, e.message);
          });
          const margem = p.margem || ((p.quantidade * p.precoEntrada) / (p.alavancagem || 1));
          const roiFinal = margem > 0 ? (p.pnlNaoRealizado / margem) * 100 : 0;
          const limpeza = scalpLib.limpezaBoot(alvoExistente, isZombieQNT);
          await rag.salvarSaidaRAG({
            symbol: p.symbol,
            exitPrice: p.precoMarca || p.precoEntrada,
            exitReason: limpeza.exitReason,
            roiPct: roiFinal,
            pnlUsdt: p.pnlNaoRealizado + (alvoExistente?.pnlParcialBruto || 0)
          }).catch(() => {});
          registrarDesfechoTrade(p.symbol, limpeza.exitReason, roiFinal, p.pnlNaoRealizado, alvoExistente);
          delete localAlvos[p.symbol];
          if (limpeza.cooldownMs > 0) cooldownMoeda[p.symbol] = Date.now() + limpeza.cooldownMs;
        }
      }
      salvarAlvos();

      // Posições remanescentes válidas
      const posValidas = (await fut.todasPosicoes().catch(() => []))
        .filter(p => parseFloat(p.positionAmt) !== 0 && WHITELIST_VIP.has(p.symbol))
        .filter(p => {
          // Scalp sem alvo (qualquer moeda, sem alvo algum, alavancagem 5x ou ilegível): fora dos slots PSAR, cai no ALERTA abaixo.
          const scalpSemAlvo = scalpLib.posicaoScalpSemAlvo(p, localAlvos[p.symbol]);
          if (!scalpSemAlvo && !scalpBoot.has(p.symbol) && localAlvos[p.symbol]?.modo !== 'scalp_1m') return true;
          if (localAlvos[p.symbol]?.modo === 'scalp_1m') { // alvo mantido: o monitor scalp assume (scalp1m.iniciar)
            console.log(`[SCALP-BOOT] ${p.symbol}: posição scalp_1m (${p.lado} ${p.quantidade}) mantida e monitorada pelo motor scalp; fora dos slots PSAR.`);
          } else {
            console.error(`[SCALP-BOOT] ALERTA ${p.symbol}: posição scalp_1m aberta SEM GESTÃO (${p.lado} ${p.quantidade}); fora dos slots PSAR. Fechar manualmente.`);
          }
          return false;
        });

      for (let idx = 0; idx < posValidas.length; idx++) {
        const p = posValidas[idx];
        if (idx < 2) {
          const sNum = idx + 1;
          autoBotState.slots[sNum].symbol = p.symbol;
          autoBotState.slots[sNum].targetSymbol = p.symbol;
          autoBotState.slots[sNum].side = p.lado;
          autoBotState.slots[sNum].leverage = p.alavancagem;
          autoBotState.slots[sNum].openTime = localAlvos[p.symbol]?.openTime || p.atualizadoEm || Date.now();
          autoBotState.slots[sNum].status = `[POSIÇÃO ATIVA] ${p.symbol} (${p.lado} ${p.alavancagem}x)`;
          console.log(`[BOOT] Slot ${sNum} sincronizado com posição existente: ${p.symbol} (${p.lado} ${p.alavancagem}x)`);

          if (!localAlvos[p.symbol]) {
            const pEntrada = parseFloat(p.precoEntrada);
            const isLong = p.lado === 'LONG';
            const alav = p.alavancagem || 1;
            registrarPosicaoSar(p.symbol, p.lado, alav, { preco: pEntrada, qty: Math.abs(parseFloat(p.positionAmt) || p.quantidade || 0) }, { sar1m: {} }, sNum);
            localAlvos[p.symbol].openTime = Date.now();
            salvarAlvos();
          }
        } else if (!scalpLib.ehTestnet(fut.FAPI)) { // trava testnet: nenhuma ordem fora do testnet
          console.error(`[BOOT-ORFÃ] ${p.symbol}: base de ordens não é testnet (${fut.FAPI}); fechamento não enviado`);
        } else {
          console.warn(`[BOOT-ORFÃ] Posição órfã detectada na Binance além dos 2 slots: ${p.symbol} (${p.lado} ${p.quantidade}). Encerrando imediatamente a mercado...`);
          await fut.cancelarTodasOrdens(p.symbol);
          await fut.fecharMercado(p.symbol, p.lado, p.quantidade).catch(e => {
            console.error(`[BOOT-ORFÃ] Erro ao fechar órfã ${p.symbol}:`, e.message);
          });
        }
      }
    } catch(e) {
      console.error('[BOOT] Erro ao sincronizar posições:', e.message);
    }

    // Aquece o ranking de volatilidade (o motor SAR assume daqui)
    rankearVolateis().catch(() => {});
    scalp1m.iniciar(); // flag SCALP_1M_ENABLED OFF = só o timer ocioso

    app.listen(PORT, () => console.log('Painel Quant Institucional rodando na porta ' + PORT));
  } catch (e) {
    console.error("Erro no boot:", e);
  }
})();
