// Motor Parabolic SAR 1m + Esqueleto da Moeda (compartilhado: script, UI, /api/esqueleto, 9Router/JEV).
// Puro: recebe klines 1m da Binance ([openTime, o, h, l, c, v, ...]) e devolve o esqueleto.
const ti = require('technicalindicators');

const SAR_STEP = 0.02;
const SAR_MAX = 0.2;
const KLINES_LIMIT = 120;
const SLOPE_LAG = 2;
const SLOPE_EPS = 0.0004;

function inclinacao(arr) {
  if (!arr || arr.length <= SLOPE_LAG) return 'PLANA';
  const atual = arr[arr.length - 1];
  const ant = arr[arr.length - 1 - SLOPE_LAG];
  if (!isFinite(atual) || !isFinite(ant) || ant === 0) return 'PLANA';
  const rel = (atual - ant) / Math.abs(ant);
  if (rel > SLOPE_EPS) return 'SUBINDO';
  if (rel < -SLOPE_EPS) return 'CAINDO';
  return 'PLANA';
}

// "ABAIXO" = bolinha abaixo do candle (alta/compra); "ACIMA" = bolinha acima (baixa/venda).
function posicaoSar(sarVal, high, low) {
  return sarVal < (high + low) / 2 ? 'ABAIXO' : 'ACIMA';
}

// A vela final pode estar em formação; `apenasFechadas` descarta-a para decisões sem repintura.
function construirEsqueleto(slot, symbol, klines, opts = {}) {
  if (!Array.isArray(klines) || klines.length < 40) return null;
  const ks = opts.apenasFechadas ? klines.slice(0, -1) : klines;
  const highs = ks.map(k => parseFloat(k[2]));
  const lows = ks.map(k => parseFloat(k[3]));
  const closes = ks.map(k => parseFloat(k[4]));
  const n = ks.length;
  const ok = a => a.every(v => Number.isFinite(v));
  if (!ok(highs) || !ok(lows) || !ok(closes) || closes.some(c => c <= 0)) return null;

  const sarArr = ti.PSAR.calculate({ high: highs, low: lows, step: SAR_STEP, max: SAR_MAX });
  if (!sarArr || sarArr.length < 3) return null;
  const off = n - sarArr.length;
  const posArr = sarArr.map((v, i) => posicaoSar(v, highs[i + off], lows[i + off]));

  const posAtual = posArr[posArr.length - 1];
  let bolinhas = 1;
  for (let i = posArr.length - 2; i >= 0 && posArr[i] === posAtual; i--) bolinhas++;
  const idxVirada = posArr.length - bolinhas - 1;
  const houveVirada = idxVirada >= 0;
  const posAnterior = houveVirada ? posArr[idxVirada] : posAtual;
  // Abertura da vela da 1ª bolinha: identifica a virada de forma única (evita repetir entrada)
  const idxPrimeira = posArr.length - bolinhas + off;
  const flipCandleTime = parseInt(ks[Math.max(0, idxPrimeira)][0], 10);
  if (!Number.isFinite(flipCandleTime) || !sarArr.every(v => Number.isFinite(v))) return null;

  const ema9 = ti.EMA.calculate({ period: 9, values: closes });
  const ema21 = ti.EMA.calculate({ period: 21, values: closes });
  const rsi = ti.RSI.calculate({ period: 14, values: closes });
  const rsiAtual = rsi.length ? rsi[rsi.length - 1] : 50;
  let rsiIncl = 'CAINDO';
  if (rsi.length > SLOPE_LAG) rsiIncl = rsiAtual >= rsi[rsi.length - 1 - SLOPE_LAG] ? 'SUBINDO' : 'CAINDO';

  const janela = Math.min(15, n);
  let somaAmp = 0;
  for (let i = n - janela; i < n; i++) somaAmp += ((highs[i] - lows[i]) / closes[i]) * 100;

  return {
    slot,
    symbol,
    precoAtual: closes[n - 1],
    volatilidade1mPct: Number((somaAmp / janela).toFixed(3)),
    sar1m: {
      valorAtual: sarArr[sarArr.length - 1],
      posicaoAtual: posAtual,
      posicaoAnterior: posAnterior,
      bolinhasConsecutivas: bolinhas,
      virouAgora: houveVirada && bolinhas === 2,
      flipCandleTime
    },
    linhasConfirmacao1m: {
      ema9_inclinacao: inclinacao(ema9),
      ema21_inclinacao: inclinacao(ema21),
      rsi14_valor: Number(rsiAtual.toFixed(1)),
      rsi14_inclinacao: rsiIncl
    },
    statusSlot: opts.statusSlot || 'AGUARDANDO_VIRADA_SAR',
    atualizadoEm: Date.now()
  };
}

function direcaoDoSar(esq) {
  if (!esq || !esq.sar1m || !['ABAIXO', 'ACIMA'].includes(esq.sar1m.posicaoAtual)) return null;
  return esq.sar1m.posicaoAtual === 'ABAIXO' ? 'LONG' : 'SHORT';
}

// Confirmação 0-token (fallback se a IA falhar).
function confirmacaoLocal(esq) {
  const dir = direcaoDoSar(esq);
  if (!dir) return { ok: false, dir: null, motivo: 'sem esqueleto' };
  const l = esq.linhasConfirmacao1m;
  const fav = dir === 'LONG' ? 'SUBINDO' : 'CAINDO';
  const contra = dir === 'LONG' ? 'CAINDO' : 'SUBINDO';
  const alinhado = l.ema9_inclinacao === fav && l.rsi14_inclinacao === fav && l.ema21_inclinacao !== contra;
  const extremo = (dir === 'LONG' && l.rsi14_valor > 80) || (dir === 'SHORT' && l.rsi14_valor < 20);
  return { ok: alinhado && !extremo, dir, motivo: !alinhado ? 'EMA9/RSI sem alinhamento' : (extremo ? 'RSI extremo' : 'EMA9+RSI alinhados') };
}

module.exports = { KLINES_LIMIT, construirEsqueleto, direcaoDoSar, confirmacaoLocal, inclinacao };
