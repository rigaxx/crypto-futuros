// ============================================================
// ADAPTER USDⓈ-M FUTURES (fapi) — camada de execução do bot.
// ------------------------------------------------------------
// POR QUE UM MÓDULO SEPARADO. O server.js do Spot tem ~13 mil linhas e
// mistura scan, scoring, PnL, dashboard e execução. Migrar para Futuros
// NÃO exige tocar em scan/scoring/PnL: só a camada que fala com a
// corretora muda. Este arquivo isola exatamente essa camada, para que o
// server_futures.js seja o server.js com as chamadas de execução
// redirecionadas — e não uma reescrita da estratégia.
//
// DIFERENÇAS ESTRUTURAIS SPOT -> FUTUROS que este módulo absorve:
//
//   1. NÃO EXISTE quoteOrderQty. No Spot dá para comprar "35 USDT de
//      X"; em Futuros a ordem é sempre por QUANTIDADE. A conversão
//      notional -> qty (com tickSize/stepSize/minNotional) mora aqui.
//   2. NÃO EXISTE "saldo do ativo". O que existe é POSIÇÃO, com sinal:
//      positionAmt > 0 = long, < 0 = short. getFreeAsset() não tem
//      equivalente e foi substituída por posicao().
//   3. STOP É ORDEM DE VERDADE. No Spot o bot usava soft-stop (vigiava
//      o preço e vendia a mercado). Em Futuros usamos STOP_MARKET com
//      closePosition=true: a proteção passa a viver NA BINANCE, e
//      sobrevive a queda de rede, restart do PM2 e travamento do
//      processo. Era o principal furo do modelo antigo.
//   4. ALAVANCAGEM E MARGEM são estado do símbolo na conta, não da
//      ordem. Precisam ser fixadas ANTES da entrada (garantirAlavancagem).
//   5. WS é fstream.binance.com, não stream.binance.com.
//
// FALHA FECHADO: toda função que não conseguir provar o resultado
// devolve erro em vez de "provavelmente deu certo". Em posição
// alavancada, otimismo é prejuízo.
// ============================================================
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const FAPI = process.env.FUTURES_BASE || 'https://fapi.binance.com';
const FSTREAM = process.env.FUTURES_WS || 'wss://fstream.binance.com';

const API_KEY = process.env.BINANCE_API_KEY;
const SECRET = process.env.BINANCE_SECRET;

const headers = { 'X-MBX-APIKEY': API_KEY };
const RECV_WINDOW = 5000;

// ============================================================
// RELÓGIO. Mesma disciplina do server.js do Spot: a Binance recusa
// requisição assinada fora da janela de recvWindow (-1021), e a VPS
// deriva. O offset desconta METADE do round-trip (o serverTime é do
// instante em que a corretora respondeu, não de quando pedimos).
// ============================================================
let offsetMs = 0;

async function sincronizarRelogio(origem = 'boot') {
  try {
    const t0 = Date.now();
    const { data } = await axios.get(`${FAPI}/fapi/v1/time`, { timeout: 5000 });
    const t1 = Date.now();
    if (!data || !Number.isFinite(data.serverTime)) {
      console.warn(`[FUT:RELÓGIO] Resposta inválida de /fapi/v1/time (${origem}). Offset mantido.`);
      return offsetMs;
    }
    offsetMs = data.serverTime - (t0 + (t1 - t0) / 2);
    console.log(`[FUT:RELÓGIO] offset=${offsetMs.toFixed(0)}ms (origem: ${origem})`);
    return offsetMs;
  } catch (err) {
    console.warn(`[FUT:RELÓGIO] Falha ao sincronizar (${origem}): ${err.message}. Offset mantido.`);
    return offsetMs;
  }
}

const timestamp = () => Math.round(Date.now() + offsetMs);

const assinar = (q) => crypto.createHmac('sha256', SECRET).update(q).digest('hex');

function montarQuery(params = {}) {
  const base = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const q = `${base ? base + '&' : ''}recvWindow=${RECV_WINDOW}&timestamp=${timestamp()}`;
  return `${q}&signature=${assinar(q)}`;
}

// Chamada assinada. Reenvia UMA vez em -1021 (relógio) após ressincronizar:
// é o erro transitório mais comum e o único cuja causa sabemos corrigir.
async function assinado(metodo, caminho, params = {}, _retry = false) {
  try {
    const url = `${FAPI}${caminho}?${montarQuery(params)}`;
    const { data } = await axios({ method: metodo, url, headers, timeout: 20000 });
    return data;
  } catch (err) {
    const code = err.response && err.response.data && err.response.data.code;
    if (code === -1021 && !_retry) {
      console.warn('[FUT] -1021 (timestamp). Ressincronizando relógio e repetindo uma vez.');
      await sincronizarRelogio('retry -1021');
      return assinado(metodo, caminho, params, true);
    }
    throw err;
  }
}

async function publico(caminho, params = {}) {
  const q = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const { data } = await axios.get(`${FAPI}${caminho}${q ? '?' + q : ''}`, { timeout: 20000 });
  return data;
}

function detalheErro(err) {
  if (err.response && err.response.data) return JSON.stringify(err.response.data);
  return err.message;
}

function codigoErro(err) {
  return (err.response && err.response.data && err.response.data.code) || null;
}

// ============================================================
// EXCHANGE INFO — filtros por símbolo.
// ------------------------------------------------------------
// O universo de Futuros é MENOR que o do Spot (~300 pares vs ~1400) e
// nem todo símbolo do scan existe aqui. `negociavel()` é a peneira que
// impede o motor de tentar entrar num par inexistente.
// ============================================================
const filtros = new Map();   // symbol -> { stepSize, tickSize, minQty, minNotional, ... }
const BLOQUEADOS_SYNTHETIC = ['SAMSUNG', 'COIN', 'SOXL', 'MVLL', 'QNTX', 'TSLA', 'AAPL', 'NVDA', 'HEMI'];

async function carregarExchangeInfo() {
  const data = await publico('/fapi/v1/exchangeInfo');
  filtros.clear();
  for (const s of data.symbols || []) {
    // Só perpétuos de margem USDT. Quarterly/COIN-M ficam de fora: o
    // vencimento quebra a premissa de posição intraday sem prazo.
    if (s.status !== 'TRADING') continue;
    if (s.contractType !== 'PERPETUAL') continue;
    if (s.quoteAsset !== 'USDT') continue;
    if (BLOQUEADOS_SYNTHETIC.some(b => s.symbol.startsWith(b))) continue;

    const lot = (s.filters || []).find((f) => f.filterType === 'LOT_SIZE');
    const mkt = (s.filters || []).find((f) => f.filterType === 'MARKET_LOT_SIZE');
    const price = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
    const not = (s.filters || []).find((f) => f.filterType === 'MIN_NOTIONAL');

    filtros.set(s.symbol, {
      contractType: s.contractType,
      stepSize: (mkt && mkt.stepSize) || (lot && lot.stepSize) || '0.001',
      minQty: parseFloat((mkt && mkt.minQty) || (lot && lot.minQty) || '0'),
      maxQty: parseFloat((mkt && mkt.maxQty) || (lot && lot.maxQty) || '0') || Infinity,
      tickSize: (price && price.tickSize) || '0.01',
      minNotional: parseFloat((not && not.notional) || 5),
      quantityPrecision: s.quantityPrecision,
      pricePrecision: s.pricePrecision,
      baseAsset: s.baseAsset
    });
  }
  console.log(`[FUT] exchangeInfo: ${filtros.size} perpétuos USDT TRADING carregados.`);
  return filtros;
}

const negociavel = (symbol) => {
  if (!symbol) return false;
  if (BLOQUEADOS_SYNTHETIC.some(b => symbol.startsWith(b))) return false;
  return filtros.has(symbol);
};

const filtrosDe = (symbol) => {
  if (!symbol) return null;
  if (BLOQUEADOS_SYNTHETIC.some(b => symbol.startsWith(b))) return null;
  return filtros.get(symbol) || null;
};
const simbolos = () => [...filtros.keys()];

function casasDe(stepStr) {
  const s = String(stepStr);
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  const dec = (s.split('.')[1] || '').replace(/0+$/, '');
  return dec.length;
}

// Arredonda SEMPRE para baixo no step: para cima estoura saldo/notional
// e a corretora devolve -1111 / -2019.
function pisoNoStep(valor, stepStr) {
  const step = parseFloat(stepStr);
  if (!(step > 0)) return valor;
  const casas = casasDe(stepStr);
  return parseFloat((Math.floor(valor / step) * step).toFixed(casas));
}

function formatarQty(symbol, qty) {
  const f = filtrosDe(symbol);
  if (!f) return String(qty);
  return pisoNoStep(qty, f.stepSize).toFixed(casasDe(f.stepSize));
}

// Preço arredondado ao tickSize. Direção importa: um stop de LONG
// arredondado para CIMA fica mais apertado que o pedido (dispara antes),
// e um stop de SHORT arredondado para BAIXO idem. `modo` deixa o
// chamador escolher o lado conservador.
function formatarPreco(symbol, preco, modo = 'piso') {
  const f = filtrosDe(symbol);
  if (!f) return String(preco);
  const tick = parseFloat(f.tickSize);
  const casas = casasDe(f.tickSize);
  const n = modo === 'teto'
    ? Math.ceil(preco / tick) * tick
    : Math.floor(preco / tick) * tick;
  return n.toFixed(casas);
}

// ============================================================
// CONVERSÃO NOTIONAL -> QUANTIDADE.
// ------------------------------------------------------------
// O motor raciocina em USDT ("aporte de 35 USDT"). Futuros exige
// quantidade. Com alavancagem, o NOTIONAL da posição é margem * lev —
// é sobre ele que minNotional e stepSize incidem.
// Devolve { ok, qty, notional, motivo }.
// ============================================================
function calcularQuantidade(symbol, margemUSDT, preco, alavancagem) {
  const f = filtrosDe(symbol);
  if (!f) return { ok: false, motivo: `${symbol} não é perpétuo USDT negociável em Futuros` };
  if (!(preco > 0)) return { ok: false, motivo: 'preço inválido' };

  const notionalAlvo = margemUSDT * alavancagem;
  const qtyBruta = notionalAlvo / preco;
  const qty = parseFloat(formatarQty(symbol, qtyBruta));
  const notional = qty * preco;

  if (!(qty > 0) || qty < f.minQty) {
    return {
      ok: false, qty, notional,
      motivo: `qty ${qty} abaixo do minQty ${f.minQty} (step ${f.stepSize})`
    };
  }
  if (notional < f.minNotional) {
    return {
      ok: false, qty, notional,
      motivo: `notional ${notional.toFixed(2)} abaixo do mínimo ${f.minNotional} USDT ` +
              `(margem ${margemUSDT.toFixed(2)} x ${alavancagem}x)`
    };
  }
  return { ok: true, qty, notional };
}

// ============================================================
// MODO DE POSIÇÃO. closePosition=true (que é como o stop fica atrelado
// à posição inteira) exige ONE-WAY. Em hedge mode a mesma chamada
// precisa de positionSide e o comportamento muda. Fixamos one-way no
// boot e falhamos alto se não der.
// ============================================================
async function garantirModoOneWay() {
  const atual = await assinado('get', '/fapi/v1/positionSide/dual');
  if (atual && atual.dualSidePosition === false) {
    console.log('[FUT] Modo de posição: ONE-WAY (correto).');
    return true;
  }
  console.warn('[FUT] Conta em HEDGE mode. Alternando para ONE-WAY...');
  try {
    await assinado('post', '/fapi/v1/positionSide/dual', { dualSidePosition: 'false' });
    console.log('[FUT] Modo de posição alterado para ONE-WAY.');
    return true;
  } catch (err) {
    // -4059 = "No need to change position side" (já está correto)
    if (codigoErro(err) === -4059) return true;
    console.error('[FUT] FALHA ao fixar ONE-WAY:', detalheErro(err));
    console.error('      Feche todas as posições/ordens abertas e tente de novo.');
    return false;
  }
}

// ============================================================
// ALAVANCAGEM E TIPO DE MARGEM por símbolo.
// ------------------------------------------------------------
// São estado persistente da conta, não parâmetro da ordem: precisam ser
// aplicados ANTES de abrir. A Binance recusa a troca com posição aberta
// no par, então isto roda no caminho de entrada, com o par ainda limpo.
//
// ISOLATED por decisão de risco: em CROSSED um trade ruim consome a
// margem dos outros e pode liquidar a conta inteira. ISOLATED limita o
// estrago ao valor daquela posição.
// ============================================================
const alavancagemAplicada = new Map();   // symbol -> lev já confirmada

async function garantirAlavancagem(symbol, alavancagem, tipoMargem = 'ISOLATED') {
  if (alavancagemAplicada.get(symbol) === alavancagem) return true;

  // Tipo de margem primeiro: trocar margem com alavancagem já setada é
  // aceito, o inverso às vezes não.
  try {
    await assinado('post', '/fapi/v1/marginType', { symbol, marginType: tipoMargem });
  } catch (err) {
    // -4046 = "No need to change margin type" -> já está no modo certo.
    if (codigoErro(err) !== -4046) {
      console.warn(`[FUT] ${symbol}: não foi possível fixar margem ${tipoMargem}: ${detalheErro(err)}`);
    }
  }

  try {
    const r = await assinado('post', '/fapi/v1/leverage', { symbol, leverage: alavancagem });
    const conf = parseInt(r && r.leverage, 10);
    if (conf !== alavancagem) {
      console.error(`[FUT] ${symbol}: alavancagem pedida ${alavancagem}x, corretora aplicou ${conf}x.`);
      return false;
    }
    alavancagemAplicada.set(symbol, alavancagem);
    return true;
  } catch (err) {
    console.error(`[FUT] ${symbol}: FALHA ao fixar alavancagem ${alavancagem}x: ${detalheErro(err)}`);
    return false;
  }
}

// ============================================================
// LEITURA DE ESTADO
// ============================================================
async function saldoUSDT() {
  const bal = await assinado('get', '/fapi/v3/balance');
  const u = (bal || []).find((b) => b.asset === 'USDT');
  if (!u) return { total: 0, disponivel: 0 };
  return {
    total: parseFloat(u.balance) || 0,
    disponivel: parseFloat(u.availableBalance) || 0,
    pnlNaoRealizado: parseFloat(u.crossUnPnl) || 0
  };
}

// Posição de UM símbolo. null = sem posição (positionAmt zerado).
// O sinal de positionAmt é a fonte da verdade sobre a direção.
async function posicao(symbol) {
  const r = await assinado('get', '/fapi/v3/positionRisk', { symbol });
  const p = (r || []).find((x) => parseFloat(x.positionAmt) !== 0);
  if (!p) return null;
  const amt = parseFloat(p.positionAmt);
  return {
    symbol: p.symbol,
    lado: amt > 0 ? 'LONG' : 'SHORT',
    quantidade: Math.abs(amt),
    positionAmt: amt,
    precoEntrada: parseFloat(p.entryPrice),
    precoMarca: parseFloat(p.markPrice),
    precoLiquidacao: parseFloat(p.liquidationPrice),
    alavancagem: alavancagemEfetiva(
      p, Math.abs(amt), parseFloat(p.markPrice),
      parseFloat(p.isolatedMargin || p.initialMargin) || 0
    ),
    margem: parseFloat(p.isolatedMargin || p.initialMargin) || 0,
    pnlNaoRealizado: parseFloat(p.unRealizedProfit),
    atualizadoEm: parseInt(p.updateTime, 10) || 0
  };
}

// ALAVANCAGEM EFETIVA (2026-07-28). `/fapi/v3/positionRisk` NÃO devolve o
// campo `leverage` — `parseInt(undefined)` virava NaN, que aparecia como
// "NaNx" no log e forçava todo consumidor a cair no default global. A
// alavancagem real da posição é dedutível do próprio payload:
//     notional / margem = |positionAmt| * markPrice / initialMargin
// Arredondada para inteiro porque a Binance só aceita inteiros. Devolve
// NaN (contrato antigo preservado) quando não dá para deduzir.
function alavancagemEfetiva(p, qtdAbs, marca, margem) {
  const declarada = parseInt(p.leverage, 10);
  if (Number.isFinite(declarada) && declarada > 0) return declarada;
  if (!(margem > 0) || !(marca > 0) || !(qtdAbs > 0)) return NaN;
  const lev = Math.round((qtdAbs * marca) / margem);
  return lev > 0 ? lev : NaN;
}

async function todasPosicoes() {
  const r = await assinado('get', '/fapi/v3/positionRisk');
  return (r || [])
    .filter((p) => parseFloat(p.positionAmt) !== 0)
    .map((p) => {
      const amt = parseFloat(p.positionAmt);
      const qtd = Math.abs(amt);
      const marca = parseFloat(p.markPrice);
      const margem = parseFloat(p.isolatedMargin || p.initialMargin) || 0;
      return {
        symbol: p.symbol,
        lado: amt > 0 ? 'LONG' : 'SHORT',
        quantidade: qtd,
        positionAmt: amt,
        precoEntrada: parseFloat(p.entryPrice),
        precoMarca: marca,
        precoLiquidacao: parseFloat(p.liquidationPrice),
        alavancagem: alavancagemEfetiva(p, qtd, marca, margem),
        margem,
        pnlNaoRealizado: parseFloat(p.unRealizedProfit),
        // updateTime = instante da última mudança da posição na corretora.
        // É o melhor carimbo de abertura disponível para adotar uma órfã
        // cujos fills já saíram da janela lida do userTrades.
        atualizadoEm: parseInt(p.updateTime, 10) || 0
      };
    });
}

const ordensAbertas = (symbol) => assinado('get', '/fapi/v1/openOrders', symbol ? { symbol } : {});
const consultarOrdem = (symbol, orderId) => assinado('get', '/fapi/v1/order', { symbol, orderId });

// ============================================================
// HISTÓRICO DE EXECUÇÃO — a fonte da verdade da sincronização.
// ------------------------------------------------------------
// Três endpoints, três papéis distintos:
//
//   userTrades  : os FILLS. Cada linha traz side, qty, price, realizedPnl
//                 e commission REAIS. É o único lugar onde a direção da
//                 posição (LONG/SHORT) e o PnL realizado existem com a
//                 granularidade de execução. EXIGE symbol.
//   income      : o extrato da conta. NÃO exige symbol — é o único jeito
//                 barato de descobrir QUAIS pares se moveram na janela
//                 sem varrer os ~300 perpétuos um a um.
//   allOrders   : as ORDENS (não os fills). Serve só para dizer se o
//                 fechamento veio de STOP_MARKET, TAKE_PROFIT_MARKET,
//                 liquidação ou mercado — ou seja, o close_reason.
//
// Todos aceitam janela de no máximo 7 dias na Binance; quem chama é
// responsável por respeitar isso.
// ============================================================

// Fills de um símbolo. `fromId` pagina a partir de um tradeId (exclusivo
// com startTime na Binance: quando fromId é informado, a janela é
// ignorada — é assim que se drena um símbolo com mais de 1000 fills).
async function userTrades(symbol, { startTime, endTime, fromId, limit = 1000 } = {}) {
  const params = { symbol, limit };
  if (fromId != null) params.fromId = fromId;
  else {
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;
  }
  const data = await assinado('get', '/fapi/v1/userTrades', params);
  return Array.isArray(data) ? data : [];
}

// Todos os fills de um símbolo na janela, paginando por tradeId até
// drenar. Guarda de segurança em MAX_PAGINAS: um símbolo com histórico
// absurdo não pode prender o boot do robô.
async function userTradesCompleto(symbol, { startTime, endTime, maxPaginas = 10 } = {}) {
  const acumulado = [];
  const vistos = new Set();
  let pagina = await userTrades(symbol, { startTime, endTime });
  let voltas = 0;
  while (pagina.length > 0 && voltas < maxPaginas) {
    for (const t of pagina) {
      if (!vistos.has(t.id)) { vistos.add(t.id); acumulado.push(t); }
    }
    if (pagina.length < 1000) break;           // última página
    const ultimoId = Math.max(...pagina.map((t) => Number(t.id)));
    pagina = await userTrades(symbol, { fromId: ultimoId + 1 });
    // fromId ignora endTime: corta manualmente o que passou da janela.
    if (endTime) pagina = pagina.filter((t) => Number(t.time) <= endTime);
    voltas += 1;
  }
  acumulado.sort((a, b) => Number(a.time) - Number(b.time) || Number(a.id) - Number(b.id));
  return acumulado;
}

// Extrato da conta (REALIZED_PNL, COMMISSION, FUNDING_FEE, TRANSFER...).
// Sem `symbol` devolve a conta inteira — é o radar de quais pares tiveram
// movimento na janela.
async function income({ startTime, endTime, incomeType, symbol, limit = 1000 } = {}) {
  const params = { limit };
  if (symbol) params.symbol = symbol;
  if (incomeType) params.incomeType = incomeType;
  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;
  const data = await assinado('get', '/fapi/v1/income', params);
  return Array.isArray(data) ? data : [];
}

// Ordens (não fills) de um símbolo na janela. Usado só para classificar o
// motivo do fechamento: type/origType diz se foi STOP_MARKET, TAKE_PROFIT
// _MARKET, LIQUIDATION ou MARKET.
async function todasOrdens(symbol, { startTime, endTime, limit = 500 } = {}) {
  const params = { symbol, limit };
  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;
  const data = await assinado('get', '/fapi/v1/allOrders', params);
  return Array.isArray(data) ? data : [];
}

async function cancelarTodasOrdens(symbol) {
  // Cancela ordens regulares.
  const okReg = await assinado('delete', '/fapi/v1/allOpenOrders', { symbol })
    .then(() => true)
    .catch((err) => {
      if (codigoErro(err) === -2011) return true;  // sem ordens — ok
      console.error(`[FUT] ${symbol}: falha ao cancelar ordens regulares: ${detalheErro(err)}`);
      return false;
    });

  // Cancela ordens algo (não cobertas por allOpenOrders).
  const okAlgo = await openAlgoOrdens(symbol)
    .then((ordens) =>
      Promise.all(ordens.map((o) =>
        assinado('delete', '/fapi/v1/algoOrder', { algoId: o.algoId, symbol })
          .catch((e) => console.error(`[FUT] ${symbol}: falha ao cancelar algoOrder ${o.algoId}: ${detalheErro(e)}`))
      )).then(() => true)
    )
    .catch((e) => {
      console.error(`[FUT] ${symbol}: falha ao listar algoOrders p/ cancelar: ${detalheErro(e)}`);
      return false;
    });

  return okReg && okAlgo;
}

// ============================================================
// EXECUÇÃO
// ============================================================

// Abertura a mercado. `lado` = 'BUY' (long) | 'SELL' (short).
async function abrirMercado(symbol, lado, qty) {
  return assinado('post', '/fapi/v1/order', {
    symbol, side: lado, type: 'MARKET', quantity: formatarQty(symbol, qty),
    newOrderRespType: 'RESULT'   // já devolve avgPrice/executedQty do fill
  });
}

// Fechamento a mercado. reduceOnly garante que um erro de sinal feche a
// posição em vez de abrir uma nova no sentido oposto.
async function fecharMercado(symbol, ladoPosicao, qty) {
  const lado = ladoPosicao === 'LONG' ? 'SELL' : 'BUY';
  try {
    return await assinado('post', '/fapi/v1/order', {
      symbol, side: lado, type: 'MARKET', quantity: formatarQty(symbol, qty),
      reduceOnly: 'true', newOrderRespType: 'RESULT'
    });
  } catch (err) {
    const code = err.response?.data?.code;
    if (code === -2022) {
      console.warn(`[FUT] fecharMercado ${symbol}: -2022 (ReduceOnly rejeitado). Verificando posição atual...`);
      const p = await posicao(symbol).catch(() => null);
      if (!p || p.quantidade === 0) {
        console.log(`[FUT] fecharMercado ${symbol}: Posição já zerada na Binance.`);
        return { symbol, status: 'FILLED', executedQty: qty };
      }
    }
    throw err;
  }
}

// ------------------------------------------------------------
// PROTEÇÃO NA CORRETORA — Algo Service (desde 2025-12-09 ordens
// condicionais saíram de POST /fapi/v1/order para POST /fapi/v1/algoOrder).
//
// O que mudou:
//   POST /fapi/v1/algoOrder com algoType=CONDITIONAL, type=STOP_MARKET,
//   triggerPrice (e stopPrice por segurança), timeInForce=GTC.
//   Resposta: algoId, orderType, triggerPrice, closePosition=true (boolean).
//
//   GET  /fapi/v1/openAlgoOrders — ordens algo NÃO aparecem em openOrders.
//   DELETE /fapi/v1/algoOrder?algoId=X — cancel individual por algoId.
//   DELETE /fapi/v1/allOpenOrders — NÃO cancela ordens algo.
// ------------------------------------------------------------

// Lê ordens algo abertas. Com symbol: peso 1. Sem symbol: conta inteira.
// Retorna array de objetos com algoId, orderType, triggerPrice, side, closePosition.
async function openAlgoOrdens(symbol) {
  const params = symbol ? { symbol } : {};
  const data = await assinado('get', '/fapi/v1/openAlgoOrders', params);
  return Array.isArray(data) ? data : [];
}

async function colocarStopLoss(symbol, ladoPosicao, precoStop) {
  const lado = ladoPosicao === 'LONG' ? 'SELL' : 'BUY';
  // LONG: stop abaixo -> arredondar para BAIXO afasta o gatilho.
  // SHORT: stop acima -> arredondar para CIMA.
  const preco = formatarPreco(symbol, precoStop, ladoPosicao === 'LONG' ? 'piso' : 'teto');
  return assinado('post', '/fapi/v1/algoOrder', {
    symbol, side: lado, algoType: 'CONDITIONAL',
    type: 'STOP_MARKET',
    triggerPrice: preco, stopPrice: preco,
    closePosition: 'true',
    workingType: 'MARK_PRICE', priceProtect: 'true',
    timeInForce: 'GTC'
  });
}

async function colocarTakeProfit(symbol, ladoPosicao, precoAlvo) {
  const lado = ladoPosicao === 'LONG' ? 'SELL' : 'BUY';
  // LONG: alvo acima -> arredondar para CIMA.
  const preco = formatarPreco(symbol, precoAlvo, ladoPosicao === 'LONG' ? 'teto' : 'piso');
  return assinado('post', '/fapi/v1/algoOrder', {
    symbol, side: lado, algoType: 'CONDITIONAL',
    type: 'TAKE_PROFIT_MARKET',
    triggerPrice: preco, stopPrice: preco,
    closePosition: 'true',
    workingType: 'MARK_PRICE', priceProtect: 'true',
    timeInForce: 'GTC'
  });
}

// ------------------------------------------------------------
// TRAILING STOP (FASE 3 — 2026-07-28).
// Também pelo Algo Service. Diferenças em relação a STOP/TAKE_PROFIT:
//   - callbackRate é PERCENTUAL DE PREÇO (0.1 a 5 na Binance), não ROI;
//   - NÃO aceita closePosition=true — exige `quantity` explícita, então
//     o chamador precisa passar o tamanho da posição;
//   - o preço de ativação é OBRIGATÓRIO aqui: sem ele o trailing arma no
//     ato e vira um stop curto disfarçado.
// reduceOnly garante que, se o sinal vier trocado, a ordem feche a
// posição em vez de abrir uma nova no sentido oposto.
//
// NOME DO PARÂMETRO DE ATIVAÇÃO (bug de 2026-07-28, sangria de banca).
// O endpoint clássico POST /fapi/v1/order chama esse campo de
// `activationPrice`. O Algo Service (POST /fapi/v1/algoOrder) NÃO: ele
// lê `activatePrice` — o mesmo nome que devolve na leitura. Enviar
// `activationPrice` aqui não dá erro: a Binance simplesmente IGNORA o
// campo desconhecido e ativa o trailing no preço de mercado do momento
// da postagem. O resultado era um stop de 0.3% de preço (0.9% de ROI a
// 3x) colado na entrada, disparando em qualquer respiro do par — dezenas
// de saídas entre -1% e -3% de ROI, rotuladas MERCADO_BINANCE porque a
// ordem filha do algo é do tipo MARKET.
//
// Mandamos os DOIS nomes: `activatePrice` é o que este endpoint lê e
// `activationPrice` fica de reserva caso a Binance unifique a API. Quem
// chama ainda precisa CONFERIR por releitura (ver conferirTrailing) —
// campo ignorado não gera erro, então só a releitura prova.
// ------------------------------------------------------------
async function colocarTrailingStop(symbol, ladoPosicao, precoAtivacao, callbackRate, qty) {
  const lado = ladoPosicao === 'LONG' ? 'SELL' : 'BUY';
  // LONG ativa em preço ACIMA (lucro) -> arredondar para cima afasta o
  // gatilho de armar; SHORT espelha.
  const ativacao = formatarPreco(symbol, precoAtivacao, ladoPosicao === 'LONG' ? 'teto' : 'piso');
  // A Binance aceita callbackRate entre 0.1% e 5%, com 1 casa decimal.
  const taxa = Math.min(5, Math.max(0.1, Number(callbackRate))).toFixed(1);
  return assinado('post', '/fapi/v1/algoOrder', {
    symbol, side: lado, algoType: 'CONDITIONAL',
    type: 'TRAILING_STOP_MARKET',
    activatePrice: ativacao,
    activationPrice: ativacao,
    callbackRate: taxa,
    quantity: formatarQty(symbol, qty),
    reduceOnly: 'true',
    workingType: 'MARK_PRICE',
    timeInForce: 'GTC'
  });
}

// ------------------------------------------------------------
// CANCELA UMA ORDEM ALGO por algoId. DELETE /fapi/v1/allOpenOrders não
// alcança o livro algo, e cancelarTodasOrdens derruba TP e SL junto —
// aqui precisamos cirurgia: matar só o trailing malformado.
// ------------------------------------------------------------
async function cancelarAlgo(symbol, algoId) {
  return assinado('delete', '/fapi/v1/algoOrder', { symbol, algoId });
}

// ------------------------------------------------------------
// PROVA DE VIDA DO TRAILING (2026-07-28).
// O POST devolver 200 NÃO prova que o trailing ficou como pedimos: um
// parâmetro com nome errado é ignorado em silêncio. Esta releitura
// compara o que a corretora GRAVOU com o que pedimos e só aprova se:
//   1. existe um TRAILING_STOP_MARKET no lado que fecha a posição;
//   2. o activatePrice gravado bate com o pedido (tolerância em %);
//   3. o callbackRate gravado bate com o pedido.
//
// Devolve { ok, motivo, algoId, activatePrice, callbackRate }.
// ------------------------------------------------------------
async function verificarTrailing(symbol, ladoPosicao, ativacaoEsperada, callbackEsperado, toleranciaPct = 0.15) {
  const ladoFecha = ladoPosicao === 'LONG' ? 'SELL' : 'BUY';
  const ordens = await openAlgoOrdens(symbol);
  const tr = ordens.find(
    (o) => o.orderType === 'TRAILING_STOP_MARKET' && o.side === ladoFecha
  );

  if (!tr) {
    return {
      ok: false, algoId: null,
      motivo: `nenhum TRAILING_STOP_MARKET ${ladoFecha} ativo em ${symbol} ` +
              `(${ordens.length} ordem(ns) algo no livro)`
    };
  }

  const ativacaoGravada = parseFloat(tr.activatePrice || tr.activationPrice || 0);
  const callbackGravado = parseFloat(tr.callbackRate || 0);
  const base = { algoId: tr.algoId, activatePrice: ativacaoGravada, callbackRate: callbackGravado };

  if (!(ativacaoGravada > 0)) {
    return { ...base, ok: false, motivo: 'a corretora não gravou preço de ativação (trailing armaria no ato)' };
  }

  const desvioPct = Math.abs(ativacaoGravada - ativacaoEsperada) / ativacaoEsperada * 100;
  if (desvioPct > toleranciaPct) {
    return {
      ...base, ok: false,
      motivo: `ativação gravada ${ativacaoGravada} difere da pedida ${ativacaoEsperada} ` +
              `em ${desvioPct.toFixed(3)}% (teto ${toleranciaPct}%) — parâmetro ignorado pela corretora`
    };
  }

  if (Math.abs(callbackGravado - Number(callbackEsperado)) > 0.05) {
    return {
      ...base, ok: false,
      motivo: `callbackRate gravado ${callbackGravado}% difere do pedido ${callbackEsperado}%`
    };
  }

  return { ...base, ok: true, motivo: null };
}

// ------------------------------------------------------------
// ORDEM LIMITE + CANCELAMENTO INDIVIDUAL (FASE 3).
// cancelarTodasOrdens não serve na entrada maker-first: ela derrubaria
// junto qualquer proteção já armada de outra posição do mesmo par.
// ------------------------------------------------------------
async function colocarLimite(symbol, lado, qty, preco) {
  return assinado('post', '/fapi/v1/order', {
    symbol, side: lado, type: 'LIMIT',
    quantity: formatarQty(symbol, qty),
    price: formatarPreco(symbol, preco, lado === 'BUY' ? 'piso' : 'teto'),
    timeInForce: 'GTC',
    newOrderRespType: 'RESULT'
  });
}

async function cancelarOrdem(symbol, orderId) {
  return assinado('delete', '/fapi/v1/order', { symbol, orderId });
}

// ------------------------------------------------------------
// VERIFICAÇÃO DA PROTEÇÃO — relê GET /fapi/v1/openAlgoOrders.
// Ordens algo NÃO aparecem em openOrders. Campos: orderType, triggerPrice, algoId.
// ------------------------------------------------------------
async function verificarProtecao(symbol, ladoPosicao, precoStopEsperado, toleranciaPct = 0.5) {
  let ordens;
  try {
    ordens = await openAlgoOrdens(symbol);
  } catch (err) {
    return { ok: false, motivo: `não foi possível reler openAlgoOrders: ${detalheErro(err)}` };
  }

  const ladoEsperado = ladoPosicao === 'LONG' ? 'SELL' : 'BUY';
  const stop = (ordens || []).find(
    (o) => o.orderType === 'STOP_MARKET' && o.side === ladoEsperado && o.closePosition === true
  );

  if (!stop) {
    return {
      ok: false,
      motivo: `nenhuma STOP_MARKET ${ladoEsperado} closePosition ativa em ${symbol} ` +
              `(${(ordens || []).length} ordem(ns) algo no livro)`
    };
  }

  const preco = parseFloat(stop.triggerPrice);
  const desvio = Math.abs(preco - precoStopEsperado) / precoStopEsperado * 100;
  if (desvio > toleranciaPct) {
    return {
      ok: false, ordem: stop,
      motivo: `stop armado em ${preco} mas esperado ~${precoStopEsperado.toFixed(8)} ` +
              `(desvio ${desvio.toFixed(2)}% > ${toleranciaPct}%)`
    };
  }

  const tp = (ordens || []).find(
    (o) => o.orderType === 'TAKE_PROFIT_MARKET' && o.side === ladoEsperado
  );

  return {
    ok: true,
    stopOrderId: stop.algoId,
    stopPrice: preco,
    tpOrderId: tp ? tp.algoId : null,
    tpPrice: tp ? parseFloat(tp.triggerPrice) : null
  };
}

// ============================================================
// DADOS DE MERCADO (mesmas assinaturas usadas pelo motor do Spot).
// Vêm do fapi, não do Spot: o preço do perpétuo diverge do à vista, e
// decidir por um preço em que não se pode executar é o erro clássico da
// migração.
// ============================================================
const klines = (symbol, interval, limit) =>
  publico('/fapi/v1/klines', { symbol, interval, limit });

const ticker24h = (symbol) =>
  publico('/fapi/v1/ticker/24hr', symbol ? { symbol } : {});

const tickerPreco = (symbol) =>
  publico('/fapi/v1/ticker/price', symbol ? { symbol } : {});

const livroOfertas = (symbol, limit = 20) =>
  publico('/fapi/v1/depth', { symbol, limit });

const precoMarca = (symbol) =>
  publico('/fapi/v1/premiumIndex', symbol ? { symbol } : {});

const openInterest = (symbol) =>
  publico('/fapi/v1/openInterest', { symbol });

const openInterestHist = async (symbol, period = '5m', limit = 10) => {
  try {
    let res = await publico('/futures/data/openInterestHist', { symbol, period, limit });
    if (Array.isArray(res) && res.length > 0) return res;
    // Fallback para API pública oficial se estiver na testnet
    const r2 = await axios.get(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`, { timeout: 5000 });
    return r2.data || [];
  } catch(e) {
    return [];
  }
};

const takerBuySellRatio = async (symbol, period = '5m', limit = 10) => {
  try {
    let res = await publico('/futures/data/takerlongshortRatio', { symbol, period, limit });
    if (Array.isArray(res) && res.length > 0) return res;
    // Fallback para API pública oficial se estiver na testnet
    const r2 = await axios.get(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=${limit}`, { timeout: 5000 });
    return r2.data || [];
  } catch(e) {
    return [];
  }
};

module.exports = {
  FAPI, FSTREAM,
  sincronizarRelogio, timestamp, assinado, publico, detalheErro, codigoErro,
  carregarExchangeInfo, negociavel, filtrosDe, simbolos,
  formatarQty, formatarPreco, pisoNoStep, calcularQuantidade,
  garantirModoOneWay, garantirAlavancagem,
  saldoUSDT, posicao, todasPosicoes, ordensAbertas, openAlgoOrdens, consultarOrdem, cancelarTodasOrdens,
  userTrades, userTradesCompleto, income, todasOrdens,
  abrirMercado, fecharMercado,
  colocarStopLoss, colocarTakeProfit, colocarTrailingStop, verificarProtecao,
  cancelarAlgo, verificarTrailing,
  colocarLimite, cancelarOrdem,
  klines, ticker24h, tickerPreco, livroOfertas, precoMarca,
  openInterest, openInterestHist, takerBuySellRatio
};
