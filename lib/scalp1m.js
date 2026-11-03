// ============================================================
// MODO SCALP_1M (separado do PSAR). Slots próprios 3 e 4.
// Sinal: 100% MAINNET (lib/mainnetFeed). Execução: FAPI (testnet).
// CICLO DE 5 MIN alinhado ao relógio (:00, :05, :10...), sempre entra:
//   0:00-2:00 ABERTO       as 2 posições do turno (moedas diferentes, slots 3/4); duração SCALP_DURACAO_MS = 2 min
//   2:00-4:30 ANÁLISE      ranking das 20 a cada 10 s (score normalizado + direção por voto 5 sinais)
//   4:30-5:00 CONFIRMAÇÃO  4:30 ranking final e plano (sem IA); 4:57 (3 s antes) as 2 escolhidas recebem dados frescos e o
//                          Jev decide compra/venda (teto 2,5 s; falha/WAIT = direção do código)
//   5:00                   entra (fronteira seguinte). Gate antigo 5/5 e ATR_BAIXO só são registrados.
// Bloqueio duro (pula a moeda): dados > 3 s, campo ausente, spread > 0,03%.
// "FORA 1 CICLO" (sem geladeira): moeda com prejuízo, zero ou erro técnico fica fora SÓ do ciclo seguinte e volta.
// LISTA DE 20 COM RODÍZIO: a cada 6 ciclos (30 min) monta lista nova a partir dos perpétuos USDT da mainnet
// (fora EXCLUIDOS, símbolo ASCII) com volume >= 50 M, listados há >= 30 dias (onboardDate ausente/inválido = fora:
// fail-closed), spread <= 0,05%, TRADING no testnet e minNotional <= 50 USDT. Prioridade: moedas que NÃO estavam na
// lista anterior com ATR 1m em [0,15%; 0,60%]; completa com as da lista anterior e, por fim, com as de ATR mais
// próximo da faixa (montarLista20). Sempre 20.
// REST mainnet do motor (klines/ranking): fila com intervalo e recuo a >= 70% do peso/min (header X-MBX-USED-WEIGHT-1M).
// Entrada: limite post-only (GTX) no melhor preço maker, reprecificada a cada 3 s; 12 s sem fill = cancela e entra a Market.
// Saída: limite GTX reduceOnly aos 1:40; aos 2:00 cancela e manda o resto a
// Market; stop de emergência = clamp(1,5 x ATR 1m %, 0,30%, 0,90%) na corretora o tempo todo.
// ============================================================
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const EXCLUIDOS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT'];
const SLOTS = [3, 4];
const MARGEM = 10;
const ALAV = 5;
const TURNO_MS = 120000;             // SNIPER 2 MIN: turno de 120 s alinhado ao relógio
const ROTACAO_CICLOS = 15;           // lista de 20 recalculada a cada 15 ciclos de 2 min (30 min); refresh imediato no boot
const RANKING_INTERVALO_MS = ROTACAO_CICLOS * TURNO_MS; // 30 min
const RANKING_MAX = 20;               // sempre 20 moedas na lista
const RANKING_RETRY_MS = 60000;       // falha no refresh: nova tentativa em 1 min
const VOLUME_MIN_USDT = 20_000_000;   // quoteVolume 24h
const IDADE_MIN_LISTAGEM_MS = 30 * 86400000; // listada há menos de 30 dias = fora (onboardDate)
const SIMBOLO_ASCII_RE = /^[A-Z0-9]+USDT$/;  // fora disso (não ASCII, sufixo): fora do universo
const SPREAD_UNIVERSO_MAX_PCT = 0.12; // bookTicker mainnet
const CONCORRENCIA_REST = 8;          // chamadas REST simultâneas (lotes)
const LOG_CAMPO_MS = 30000;           // campo inválido: no máx 1 log por moeda a cada 30 s
const SL_EMERG_PCT = 0.60;           // stop de segurança NA CORRETORA (3,0% ROI a 5x); o SL curto do monitor (0,44%) atua antes
const SL_TETO_PCT = 0.90;            // teto do stop proporcional
const SL_ATR_MULT = 1.5;             // stop = 1,5 x ATR 1m %
const SCALP_DURACAO_MS = 120000;     // duração da posição: aos 2:00 Market
const HOLD_MS = SCALP_DURACAO_MS;
const FIM_ANTECIPA_MS = 2000;        // posição fecha 2 s antes da fronteira seguinte: slots livres na entrada do próximo turno
const FIM_LIMITE_MS = 5000;          // [FIM_TURNO_2M] limite reduceOnly nos últimos 5 s; sem fill = Market
const SAIDA_LIMITE_MS = SCALP_DURACAO_MS - FIM_ANTECIPA_MS - FIM_LIMITE_MS; // idade aproximada em que a limite de fim de turno começa
const TP_PRICE_PCT = 0.32;           // [TP_SNIPER_2M] +1,60% ROI a 5x = +0,32% de preço (limite reduceOnly na corretora)
const BE_GATILHO_ROI = 0.85;         // [BE_RAPIDO_2M] ROI que arma o piso
const BE_PISO_ROI = 0.45;            // piso: cobre as taxas, fecha positivo
const SL_CURTO_ROI = 2.20;           // [SL_CURTO_2M] -2,20% ROI = -0,44% de preço a 5x
const SL_CURTO_PCT = SL_CURTO_ROI / ALAV;
const SL_CURTO_LIMITE_MS = 3000;     // SL curto / virada do Supertrend: limite 3 s -> Market
const ST_PERIODO = 10, ST_MULT = 3;  // Supertrend(10,3) no 1m
const SNIPER_SCORE_MIN = 45;         // score mínimo (0..100) para abrir slot: direção (20) + fluxo (30) já bastam; book/RVol elevam o ranking
const SPREAD_TESTNET_MAX_PCT = 0.60; // spread do book da TESTNET (artificialmente largo): só bloqueia o absurdo
// Whitelist blindada: só moedas com book real na testnet entram no ranking das 20.
const WHITELIST = ['SOLUSDT', 'DOGEUSDT', 'SUIUSDT', 'LINKUSDT', 'AVAXUSDT', 'NEARUSDT', 'APTUSDT', 'INJUSDT', 'ORDIUSDT', 'AAVEUSDT',
  'ONDOUSDT', 'PENDLEUSDT', 'ENAUSDT', 'FETUSDT', 'TIAUSDT', 'ARBUSDT', 'OPUSDT', 'WLDUSDT', 'SEIUSDT', 'TAOUSDT'];
const ORFA_RESOLVE_MS = 15000;       // posição passou 15 s do fim do turno: confere a corretora (fecha a Market ou limpa o slot fantasma)
const ORFA_RETRY_MS = 5000;
const TAKER_RATIO_LONG = 1.05, TAKER_RATIO_SHORT = 0.95; // peso 1: fluxo de agressão (buy/sell)
const BOOK_RATIO_LONG = 1.15, BOOK_RATIO_SHORT = 0.85;   // peso 2: bid/ask top 10
const RVOL_MIN = 1.6;                // peso 3: volume relativo 1m
const PULLBACK_ATR_MULT = 1.2;       // trava anti-topo: distância preço-EMA9(1m) <= 1,2 x ATR
const ENTRADA_FUGA_ABORTA_PCT = 0.15; // sem fill em 8 s e preço fugiu > 0,15%: aborta (não persegue)
const ENTRADA_FUGA_MARKET_PCT = 0.03; // Market só se o preço segue (praticamente) no nível de entrada
const ENTRADA_LIMITE_MS = 8000;      // entrada limite: 8 s no total sem fill = cancela; Market só se o preço não fugiu
const ENTRADA_REPRECO_MS = 3000;     // a cada 3 s sem fill: cancela e recoloca no melhor bid/ask atual
const FASE_ANALISE_INI_MS = 20000;    // 0:20 começa a ANÁLISE (entradas na fronteira ocupam 0:00-0:20)
const FASE_CONFIRMACAO_INI_MS = 100000; // 1:40 começa a CONFIRMAÇÃO
const ANALISE_INTERVALO_MS = 10000;  // ranking das 20 recalculado a cada 10 s
const DESEMPATE_SCORE_PCT = 0.10;    // diferença de score < 10%: vence a de maior volume 24h
const RANKING_TOP = RANKING_MAX;     // status() expõe as 20
const HISTORICO_MAX = 10;
const POLL_MS = 500;                 // consulta da ordem limite de entrada
const TAXA_PCT = 0.05;               // taxa padrão (taker) de calcularPnl
const TAXA_TAKER_PCT = 0.05;
const TAXA_MAKER_PCT = 0.02;
const JEV_URL_PADRAO = 'https://api.typesafe.ai/v1/systemone';
const JEV_ANTECEDENCIA_MS = 3000;    // 4:57: o Jev recebe dados frescos e decide compra/venda das 2 escolhidas
const MOEDAS_PREPARADAS = 3;         // 4:57 prepara sempre 3: 2 titulares + 1 reserva na agulha (Jev só nas 2; a reserva se alguma for recusada)
const JEV_CONF_MIN = 60;             // Jev com WAIT ou confiança < 60% = pula a moeda (falha/timeout/sem chave = vale o código)
const ATR_ENTRADA_MIN_PCT = 0.05;    // ATR 1m < 0,05%: a variação não paga a taxa = pula a moeda
const JEV_TIMEOUT_MS = 2500;         // teto da consulta (termina antes da fronteira); falha/WAIT = vale a direção do código
const MAX_ENTRADAS_TURNO = 2;
const ORFA_IDADE_MS = 2 * HOLD_MS;   // na fronteira (5:00), posição do turno mais velha que isso (4:00) vira órfã
const ORFA_ALERTA_MS = 300000;       // alerta [SCALP-ORFA] aos 5 min de órfã
const COD_GTX_REJEITADA = -5022;
const COD_ORDEM_DESCONHECIDA = -2011;
const ESTADOS_FINAIS = ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'];
const ESPERA_FECHAMENTO_MS = 1200;   // folga para o REST já trazer o candle fechado
const JANELA_MAX_MS = 15000;         // passou disso, a fronteira do turno é ignorada
const ATRASO_MAX_MS = 3000;
const ATR_MIN_PCT = 0.05;            // ranking: ATR 1m % >= 0,05 (inclusive)
const ATR_MAX_PCT = 0.60;            // ranking: ATR 1m % <= 0,60 (inclusive); acima = fora
const PESO_LIMITE_1M = Number(process.env.SCALP_PESO_LIMITE_1M) > 0 ? Number(process.env.SCALP_PESO_LIMITE_1M) : 2400;
const PESO_RECUO_FRACAO = 0.70;      // >= 70% do limite/min: pausa até a janela liberar
const PESO_INTERVALO_MS = 50;        // espaçamento mínimo entre chamadas REST do motor
const PESO_LOG_MS = 30000;           // log de recuo: no máx 1 a cada 30 s
const SPREAD_MAX_PCT = 0.12;           // spread do feed MAINNET (filtro da candidata)
const ROUTER_URL = 'http://127.0.0.1:20128/v1/chat/completions';
const MODELO_GEMINI = 'ag/gemini-3.8-flash-low';
const GEMINI_TIMEOUT_MS = 2000;
const GEMINI_CONFIRMA_MS = 5000;     // teto do Gemini no fluxo de confirmação de direção
const VETO_ALERTA_TAXA = 0.90;
const VETO_AMOSTRA_MIN = 10;
const MOTIVO_MAX = 300;              // motivo do Gemini truncado antes do RAG/JSONL
const MONITOR_MS = 1000;                // monitor a cada 1 s
const MAX_TENTATIVAS_SAIDA = 20;     // teto de tentativas de saída/cancelamento por posição; depois: órfã abandonada
const CAMPOS = [
  'timestamp_dados_ms', 'timestamp_agora_ms', 'preco', 'taker_buy_ratio_60s', 'cvd_delta_60s',
  'book_imbalance_10', 'rvol', 'vwap', 'ema9_5m', 'ema21_5m', 'ema9_15m', 'ema21_15m',
  'atr_1m_pct', 'spread_pct'
];

// ── CÁLCULO DOS CAMPOS (funções puras) ──
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const fechadas = (ks, agora) => (Array.isArray(ks) ? ks : []).filter(k => Number(k[6]) < agora);
const inicioDiaUtc = (t) => Math.floor(t / 86400000) * 86400000;
const cortarMotivo = (m) => (typeof m === 'string' ? m.slice(0, MOTIVO_MAX) : m);
// Trava: o scalp só envia ordens se a base FAPI for testnet: host EXATO (não regex; 'testnet.evil.com' e
// 'fapi.binance.com/testnet' não passam). URL inválida/ausente = false.
const HOSTS_TESTNET = ['testnet.binancefuture.com'];
function ehTestnet(base) {
  try {
    const u = new URL(String(base || '').trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && HOSTS_TESTNET.includes(u.hostname.toLowerCase());
  } catch (e) { return false; }
}
// Boot: scalp órfão fecha sem cooldown 45 min e sem quarentena de loss do PSAR.
const limpezaBoot = (alvo, isZombieQNT) => alvo?.modo === 'scalp_1m'
  ? { exitReason: 'SCALP_BOOT_CLEANUP', cooldownMs: 0 }
  : { exitReason: isZombieQNT ? 'SL_FUNIL_TEMPO' : 'BOOT_CLEANUP', cooldownMs: 2700000 };
// Boot: posição sem alvo e com alavancagem do scalp (5x) ou ilegível = provável scalp sem alvo (sem lista de moedas:
// o PSAR opera no máx 4x). Fica fora dos slots PSAR. Alvo existente (qualquer modo) ou alavancagem != 5x = não é scalp.
const posicaoScalpSemAlvo = (p, alvo) => !!p?.symbol && !alvo
  && (!Number.isFinite(p.alavancagem) || p.alavancagem === ALAV);

// Lotes com limite de concorrência; erro de um item não derruba os outros (fn deve tratar o próprio erro).
async function emLotes(itens, limite, fn) {
  const lista = Array.isArray(itens) ? itens : [];
  const out = new Array(lista.length);
  let i = 0;
  const trab = async () => { while (i < lista.length) { const j = i++; out[j] = await fn(lista[j], j); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limite), lista.length) }, trab));
  return out;
}

// minNotional do testnet cabe na margem 10 x 5x = 50 USDT, com qty arredondada para baixo no stepSize.
function cabeNaMargem(f, preco) {
  const notional = MARGEM * ALAV;
  const minNot = num(f?.minNotional), step = num(f?.stepSize), minQty = num(f?.minQty) || 0;
  if (minNot === null || minNot > notional || !(preco > 0)) return false;
  const qty = step > 0 ? Math.floor(notional / preco / step + 1e-9) * step : notional / preco;
  return qty > 0 && qty >= minQty && qty * preco >= minNot;
}

// Universo (função pura): perpétuo USDT TRADING mainnet, fora EXCLUIDOS, símbolo ASCII, volume, idade, spread,
// existe no testnet, minNotional. filtroTestnet(sym) = filtros do exchangeInfo do testnet (null = não existe/não TRADING).
// Idade: onboardDate ausente/inválido/futuro = IDADE_DESCONHECIDA (fail-closed: fora); < 30 dias = LISTAGEM_RECENTE.
function filtrarUniverso({ info, tickers, books, filtroTestnet, agora = Date.now(), whitelist = null }) {
  const vol = new Map((Array.isArray(tickers) ? tickers : []).map(x => [x.symbol, num(x.quoteVolume)]));
  const bk = new Map((Array.isArray(books) ? books : []).map(x => [x.symbol, x]));
  const lista = [], descartes = {};
  const fora = (m) => { descartes[m] = (descartes[m] || 0) + 1; };
  for (const sm of info?.symbols || []) {
    const sym = sm?.symbol;
    if (!sym || sm.status !== 'TRADING' || sm.contractType !== 'PERPETUAL' || sm.quoteAsset !== 'USDT') continue;
    if (EXCLUIDOS.includes(sym)) { fora('EXCLUIDO'); continue; }
    if (Array.isArray(whitelist) && !whitelist.includes(sym)) { fora('FORA_WHITELIST'); continue; }
    if (!SIMBOLO_ASCII_RE.test(sym)) { fora('SIMBOLO_NAO_ASCII'); continue; }
    const v = vol.get(sym);
    if (!(v >= VOLUME_MIN_USDT)) { fora('VOLUME'); continue; }
    const onb = Number(sm.onboardDate);
    if (!(Number.isFinite(onb) && onb > 0 && onb <= agora)) { fora('IDADE_DESCONHECIDA'); continue; }
    if (agora - onb < IDADE_MIN_LISTAGEM_MS) { fora('LISTAGEM_RECENTE'); continue; }
    const bid = num(bk.get(sym)?.bidPrice), ask = num(bk.get(sym)?.askPrice);
    if (!(bid > 0 && ask >= bid)) { fora('BOOK'); continue; }
    const meio = (bid + ask) / 2;
    const spread = ((ask - bid) / meio) * 100;
    if (spread > SPREAD_UNIVERSO_MAX_PCT) { fora('SPREAD'); continue; }
    let f = null;
    try { f = filtroTestnet ? filtroTestnet(sym) : null; } catch (e) { f = null; }
    if (!f) { fora('FORA_TESTNET'); continue; }
    if (!cabeNaMargem(f, meio)) { fora('MIN_NOTIONAL'); continue; }
    lista.push({ simbolo: sym, volume_24h: v, spread_pct: spread, preco: meio });
  }
  return { lista, descartes };
}

// Faixa de ATR do ranking (inclusive nas pontas): null = dentro; senão o motivo do corte.
function corteAtr(atr) {
  if (!Number.isFinite(atr)) return 'ATR_INVALIDO';
  if (atr < ATR_MIN_PCT) return 'ATR_BAIXO';
  if (atr > ATR_MAX_PCT) return 'ATR_ALTO';
  return null;
}

// Distância do ATR à faixa [ATR_MIN_PCT, ATR_MAX_PCT] (0 = dentro).
const distanciaFaixaAtr = (atr) => (atr < ATR_MIN_PCT ? ATR_MIN_PCT - atr : (atr > ATR_MAX_PCT ? atr - ATR_MAX_PCT : 0));

// RODÍZIO: monta a lista de `max` (20) moedas a partir do universo já filtrado (com atr_pct e volume_24h).
// Prioridade: (1) NOVAS = não estavam na lista anterior, ATR em [0,15%; 0,60%], por ATR decrescente;
// (2) REPETIDAS = as da lista anterior que seguem no universo (dentro da faixa primeiro, por ATR decrescente;
//     depois as de ATR mais próximo da faixa); (3) ATR_PROXIMO = demais de ATR mais próximo da faixa.
// ATR inválido nunca entra. Sempre `max` se o universo tiver `max` moedas com ATR válido.
// Cada item ganha origem: 'NOVA' | 'REPETIDA' | 'ATR_PROXIMO' (a mesma moeda não repete na lista).
function montarLista20(universo, anterior = [], max = RANKING_MAX) {
  const ant = new Set(Array.isArray(anterior) ? anterior : []);
  const validas = (Array.isArray(universo) ? universo : []).filter(c => c && c.simbolo && Number.isFinite(c.atr_pct));
  const porAtr = (a, b) => b.atr_pct - a.atr_pct || (b.volume_24h || 0) - (a.volume_24h || 0);
  const porDist = (a, b) => distanciaFaixaAtr(a.atr_pct) - distanciaFaixaAtr(b.atr_pct) || porAtr(a, b);
  const dentro = (c) => corteAtr(c.atr_pct) === null;
  const novas = validas.filter(c => !ant.has(c.simbolo) && dentro(c)).sort(porAtr).map(c => ({ ...c, origem: 'NOVA' }));
  const rep = validas.filter(c => ant.has(c.simbolo));
  const repetidas = [...rep.filter(dentro).sort(porAtr), ...rep.filter(c => !dentro(c)).sort(porDist)].map(c => ({ ...c, origem: 'REPETIDA' }));
  const proximas = validas.filter(c => !ant.has(c.simbolo) && !dentro(c)).sort(porDist).map(c => ({ ...c, origem: 'ATR_PROXIMO' }));
  return [...novas, ...repetidas, ...proximas].slice(0, max);
}

// Stop proporcional: clamp(1,5 x ATR 1m %, 0,30, 0,90); ATR ausente/inválido = 0,30.
function stopPctDeAtr(atr) {
  if (!(Number.isFinite(atr) && atr > 0)) return SL_EMERG_PCT;
  return Math.min(SL_TETO_PCT, Math.max(SL_EMERG_PCT, SL_ATR_MULT * atr));
}

// Peso REST de /fapi/v1/klines pelo limit (tabela da Binance).
const pesoKlines = (limit) => (limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10);

// Controle de peso REST compartilhado (mainnet): fila com intervalo mínimo entre chamadas e recuo (pausa) quando
// o peso usado no minuto + o da chamada atinge >= fracao x limite. Usado = maior entre o header
// X-MBX-USED-WEIGHT-1M (lerHeader() -> { peso, ts }, válido no minuto corrente) e a estimativa local (60 s).
function criarControlePeso(o = {}) {
  const agora = o.agora || (() => Date.now());
  const dormir = o.dormir || ((ms) => new Promise(r => setTimeout(r, ms)));
  const limite = o.limite > 0 ? o.limite : PESO_LIMITE_1M;
  const fracao = o.fracao > 0 ? o.fracao : PESO_RECUO_FRACAO;
  const intervaloMs = Number.isFinite(o.intervaloMs) ? o.intervaloMs : PESO_INTERVALO_MS;
  const lerHeader = o.lerHeader || (() => null);
  const log = o.log || ((m) => console.warn(m));
  const gastos = [];
  let fila = Promise.resolve();
  let ultimaChamada = -Infinity, ultimoLog = -Infinity, pausas = 0;
  const local = (t) => {
    while (gastos.length && gastos[0].t <= t - 60000) gastos.shift();
    return gastos.reduce((a, g) => a + g.w, 0);
  };
  const header = (t) => {
    let h = null;
    try { h = lerHeader(); } catch (e) { h = null; }
    return h && Number.isFinite(h.peso) && Number.isFinite(h.ts) && Math.floor(h.ts / 60000) === Math.floor(t / 60000) ? h.peso : 0;
  };
  const usado = (t) => Math.max(local(t), header(t));
  async function vez(w) {
    const teto = limite * fracao;
    for (let i = 0; i < 10; i++) { // no máx 10 pausas por chamada (cada uma libera a janela)
      const t = agora();
      const hU = header(t), lU = local(t);
      if (Math.max(hU, lU) + w < teto) break;
      const espera = hU >= lU || !gastos.length
        ? (Math.floor(t / 60000) + 1) * 60000 - t + 100   // header: a janela da Binance vira no minuto
        : gastos[0].t + 60000 - t + 1;                    // estimativa local: até o gasto mais antigo sair
      pausas++;
      if (t - ultimoLog >= PESO_LOG_MS) {
        ultimoLog = t;
        log(`[SCALP-PESO] peso REST ${Math.max(hU, lU)}/${limite} (>= ${Math.round(fracao * 100)}%): pausa ${Math.ceil(espera / 1000)}s`);
      }
      await dormir(Math.max(1, espera));
    }
    const e = ultimaChamada + intervaloMs - agora();
    if (e > 0) await dormir(e);
    ultimaChamada = agora();
    gastos.push({ t: ultimaChamada, w });
  }
  // Serializa só a liberação (vez); a chamada roda fora da fila.
  async function executar(w, fn) {
    const minha = fila.then(() => vez(w));
    fila = minha.catch(() => {});
    await minha;
    return fn();
  }
  return { executar, status: () => ({ usado: usado(agora()), limite, recuoPct: fracao * 100, pausas }) };
}

function ema(valores, periodo) {
  if (!Array.isArray(valores) || valores.length < periodo) return null;
  let e = valores.slice(0, periodo).reduce((a, b) => a + b, 0) / periodo;
  const k = 2 / (periodo + 1);
  for (let i = periodo; i < valores.length; i++) e = valores[i] * k + e * (1 - k);
  return e;
}

// ATR de Wilder em % do último fechamento.
function atrPct(ks, periodo = 14) {
  if (!Array.isArray(ks) || ks.length < periodo + 1) return null;
  const trs = [];
  for (let i = 1; i < ks.length; i++) {
    const h = num(ks[i][2]), l = num(ks[i][3]), cAnt = num(ks[i - 1][4]);
    if (h === null || l === null || cAnt === null) return null;
    trs.push(Math.max(h - l, Math.abs(h - cAnt), Math.abs(l - cAnt)));
  }
  let atr = trs.slice(0, periodo).reduce((a, b) => a + b, 0) / periodo;
  for (let i = periodo; i < trs.length; i++) atr = (atr * (periodo - 1) + trs[i]) / periodo;
  const c = num(ks[ks.length - 1][4]);
  return c > 0 ? (atr / c) * 100 : null;
}

// Volume do último candle fechado / média dos 20 anteriores.
function rvol(ks) {
  if (!Array.isArray(ks) || ks.length < 21) return null;
  const v = ks.map(k => num(k[5]));
  if (v.some(x => x === null)) return null;
  const media = v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return media > 0 ? v[v.length - 1] / media : null;
}

// Supertrend(periodo, mult) sobre candles FECHADOS: { dir: 1 (ALTA/verde) | -1 (BAIXA/vermelho), linha } ou null.
function supertrend(ks, periodo = ST_PERIODO, mult = ST_MULT) {
  if (!Array.isArray(ks) || ks.length < periodo + 2) return null;
  const h = [], l = [], c = [];
  for (const k of ks) {
    const hh = num(k[2]), ll = num(k[3]), cc = num(k[4]);
    if (hh === null || ll === null || cc === null) return null;
    h.push(hh); l.push(ll); c.push(cc);
  }
  const tr = [h[0] - l[0]];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  let atr = tr.slice(0, periodo).reduce((a, b) => a + b, 0) / periodo; // ATR de Wilder
  let upFinal = null, loFinal = null, dir = 1, linha = null;
  for (let i = periodo - 1; i < c.length; i++) {
    if (i >= periodo) atr = (atr * (periodo - 1) + tr[i]) / periodo;
    const mid = (h[i] + l[i]) / 2;
    const up = mid + mult * atr, lo = mid - mult * atr;
    const upAnt = upFinal, loAnt = loFinal;
    upFinal = upAnt === null || up < upAnt || c[i - 1] > upAnt ? up : upAnt;
    loFinal = loAnt === null || lo > loAnt || c[i - 1] < loAnt ? lo : loAnt;
    if (i === periodo - 1) { dir = c[i] >= mid ? 1 : -1; }
    else if (dir === 1 && c[i] < loFinal) dir = -1;
    else if (dir === -1 && c[i] > upFinal) dir = 1;
    linha = dir === 1 ? loFinal : upFinal;
  }
  return { dir, linha };
}

// SNIPER 2 MIN: direção por maioria 2 de 3 (Supertrend 1m, EMA 9/21 5m, VWAP), trava anti-topo (preço x EMA9 1m), ATR mínimo e
// score de confluência 0..100 = 20 (direção) + 30 (fluxo/taker) + 25 (book) + 25 (RVol). ok = fluxo a favor e score >= SNIPER_SCORE_MIN.
// bloqueio: SEM_DADOS_SNIPER | SEM_DIRECAO | ATR_BAIXO | TOPO_ESTICADO | SEM_FLUXO | SCORE_BAIXO | null.
function avaliarSniper(d) {
  const nao = (bloqueio, direcao = 'NONE', mais = {}) => ({ ok: false, direcao, score: 0, bloqueio, ...mais });
  const f = (x) => Number.isFinite(x);
  if (!d || ![d.preco, d.vwap, d.ema9_5m, d.ema21_5m, d.ema9_1m, d.atr_1m_pct].every(f) || (d.st1m_dir !== 1 && d.st1m_dir !== -1)) return nao('SEM_DADOS_SNIPER');
  // Direção por MAIORIA SIMPLES (2 de 3): Supertrend 1m, EMA 9/21 5m, preço x VWAP.
  const alta = (d.st1m_dir === 1) + (d.ema9_5m > d.ema21_5m) + (d.preco >= d.vwap);
  const baixa = (d.st1m_dir === -1) + (d.ema9_5m < d.ema21_5m) + (d.preco <= d.vwap);
  let dir = 'NONE';
  if (alta >= 2 && alta > baixa) dir = 'LONG';
  else if (baixa >= 2 && baixa > alta) dir = 'SHORT';
  if (dir === 'NONE') return nao('SEM_DIRECAO');
  if (d.atr_1m_pct < ATR_ENTRADA_MIN_PCT) return nao('ATR_BAIXO', dir);
  const atrAbs = d.preco * d.atr_1m_pct / 100;
  const esticado = dir === 'LONG' ? d.preco - d.ema9_1m : d.ema9_1m - d.preco;
  if (esticado > PULLBACK_ATR_MULT * atrAbs) return nao('TOPO_ESTICADO', dir, { esticado_atr: atrAbs > 0 ? esticado / atrAbs : null });
  const r = d.taker_buy_ratio_60s;
  const taker = f(r) ? (r >= 1 ? Infinity : r / (1 - r)) : null;       // buy/sell
  const i = d.book_imbalance_10;
  const book = f(i) ? (i >= 1 ? Infinity : (1 + i) / (1 - i)) : null;   // bid/ask top 10
  const fluxoOk = taker !== null && (dir === 'LONG' ? taker >= TAKER_RATIO_LONG : taker <= TAKER_RATIO_SHORT);
  const bookOk = book !== null && (dir === 'LONG' ? book >= BOOK_RATIO_LONG : book <= BOOK_RATIO_SHORT);
  const rvolOk = f(d.rvol) && d.rvol >= RVOL_MIN;
  const score = 20 + (fluxoOk ? 30 : 0) + (bookOk ? 25 : 0) + (rvolOk ? 25 : 0);
  const comp = { fluxo: fluxoOk, book: bookOk, rvol: rvolOk, taker_ratio: taker, book_ratio: book };
  const bloqueio = !fluxoOk ? 'SEM_FLUXO' : (score < SNIPER_SCORE_MIN ? 'SCORE_BAIXO' : null); // fluxo a favor é obrigatório
  return { ok: bloqueio === null, direcao: dir, score, bloqueio, comp };
}

// VWAP da sessão UTC (reinicia 00:00 UTC), preço típico (h+l+c)/3.
function vwapSessao(ks, agora) {
  const ini = inicioDiaUtc(agora);
  let pv = 0, vol = 0;
  for (const k of (ks || [])) {
    if (Number(k[0]) < ini) continue;
    const h = num(k[2]), l = num(k[3]), c = num(k[4]), v = num(k[5]);
    if (h === null || l === null || c === null || v === null) return null;
    pv += ((h + l + c) / 3) * v; vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

// aggTrade: m=true -> comprador é maker -> agressão VENDEDORA.
function fluxo60s(trades, agora) {
  let buy = 0, sell = 0;
  for (const t of (trades || [])) {
    if (t.T < agora - 60000 || t.T > agora) continue;
    if (t.m) sell += t.q; else buy += t.q;
  }
  const total = buy + sell;
  if (!(total > 0)) return { taker_buy_ratio_60s: null, cvd_delta_60s: null };
  return { taker_buy_ratio_60s: buy / total, cvd_delta_60s: buy - sell };
}

function bookImbalance(book, niveis = 10) {
  const b = (book?.bids || []).slice(0, niveis).reduce((a, x) => a + (num(x[1]) || 0), 0);
  const a = (book?.asks || []).slice(0, niveis).reduce((s, x) => s + (num(x[1]) || 0), 0);
  return b + a > 0 ? (b - a) / (b + a) : null;
}

// Custo médio vs melhor preço para varrer `notional` USDT no lado agredido (BUY=asks, SELL=bids).
function slippageEstimadoPct(book, lado, notional) {
  const niveis = lado === 'BUY' ? book?.asks : book?.bids;
  if (!Array.isArray(niveis) || !niveis.length || !(notional > 0)) return null;
  const best = num(niveis[0][0]);
  if (!(best > 0)) return null;
  let resta = notional, custo = 0, qtd = 0;
  for (const [p, q] of niveis) {
    const pp = num(p), qq = num(q);
    if (!(pp > 0) || !(qq > 0)) continue;
    const n = Math.min(resta, pp * qq);
    custo += n; qtd += n / pp; resta -= n;
    if (resta <= 1e-9) break;
  }
  if (resta > 1e-9 || !(qtd > 0)) return null;
  return (Math.abs(custo / qtd - best) / best) * 100;
}

// Frescor do feed: com o WS vivo (trade e book recebendo), a mensagem mais recente prova que o dado é atual: moeda sem trade há > 3 s
// não é feed velho (era o que gerava DADOS_ATRASADOS e turno vazio). Sem WS vivo (REST/teste): vale o mais antigo dos dois.
// Com o WS vivo, o book/trade recebido é o estado ATUAL mesmo de moeda quieta (o socket é compartilhado: wsMudoMs = silêncio do
// socket, não da moeda): o frescor vale agora - wsMudoMs. Sem WS vivo (REST/teste): vale o mais antigo dos dois.
function tsFrescor(snap, agora = null) {
  if (!(snap && snap.tsTrade > 0 && snap.tsBook > 0)) return null;
  if (snap.wsVivo !== true) return Math.min(snap.tsTrade, snap.tsBook);
  const base = Math.max(snap.tsTrade, snap.tsBook);
  return agora > 0 && Number.isFinite(snap.wsMudoMs) ? Math.max(base, agora - snap.wsMudoMs) : base;
}

function montarDados(sym, { k1m, k5m, k15m, snap, agora }) {
  const ks1 = fechadas(k1m, agora), ks5 = fechadas(k5m, agora), ks15 = fechadas(k15m, agora);
  const c5 = ks5.map(k => num(k[4])), c15 = ks15.map(k => num(k[4]));
  const okC = (a) => a.length && a.every(x => x !== null);
  const book = snap?.book || null;
  const bid = num(book?.bids?.[0]?.[0]), ask = num(book?.asks?.[0]?.[0]);
  const ultimo = snap?.trades?.length ? snap.trades[snap.trades.length - 1].p : null;
  const preco = ultimo > 0 ? ultimo : (bid > 0 && ask > 0 ? (bid + ask) / 2 : null);
  const fl = snap?.bufferCompleto ? fluxo60s(snap.trades, agora) : { taker_buy_ratio_60s: null, cvd_delta_60s: null };
  const tsDados = tsFrescor(snap, agora);
  const dados = {
    simbolo: sym,
    timestamp_dados_ms: tsDados,
    timestamp_agora_ms: agora,
    preco,
    taker_buy_ratio_60s: fl.taker_buy_ratio_60s,
    cvd_delta_60s: fl.cvd_delta_60s,
    book_imbalance_10: bookImbalance(book),
    rvol: rvol(ks1),
    vwap: vwapSessao(ks1, agora),
    ema9_5m: okC(c5) ? ema(c5, 9) : null, ema21_5m: okC(c5) ? ema(c5, 21) : null,
    ema9_15m: okC(c15) ? ema(c15, 9) : null, ema21_15m: okC(c15) ? ema(c15, 21) : null,
    atr_1m_pct: atrPct(ks1.slice(-60)),
    ema9_1m: ks1.length >= 21 ? ema(ks1.slice(-60).map(k => num(k[4])), 9) : null,
    st1m_dir: supertrend(ks1.slice(-100))?.dir ?? null,
    spread_pct: bid > 0 && ask > 0 && preco > 0 ? ((ask - bid) / preco) * 100 : null
  };
  return { dados, extra: { bid, ask, book } };
}

// ── GATE DETERMINÍSTICO (funções puras) ──
// Campos: ausente/incoerente = CAMPO_INVALIDO; dados > 3 s = DADOS_ATRASADOS.
// Lista dos campos ausentes/não finitos/incoerentes (vai para o log e para o motivo do bloqueio).
const CAMPOS_POSITIVOS = ['preco', 'vwap', 'timestamp_dados_ms', 'ema9_5m', 'ema21_5m', 'ema9_15m', 'ema21_15m'];
function camposInvalidos(d) {
  if (!d || typeof d !== 'object') return CAMPOS.slice();
  return CAMPOS.filter(c => {
    const v = d[c];
    if (typeof v !== 'number' || !Number.isFinite(v)) return true;
    if (CAMPOS_POSITIVOS.includes(c)) return v <= 0;
    if (c === 'taker_buy_ratio_60s') return v < 0 || v > 1;
    if (c === 'book_imbalance_10') return v < -1 || v > 1;
    if (c === 'rvol' || c === 'atr_1m_pct' || c === 'spread_pct') return v < 0;
    return false;
  });
}

function validarCampos(d) {
  if (camposInvalidos(d).length) return 'CAMPO_INVALIDO';
  if (d.timestamp_agora_ms - d.timestamp_dados_ms > ATRASO_MAX_MS) return 'DADOS_ATRASADOS';
  return null;
}

// As 5 condições do prompt por lado (0..5).
function contarCondicoes(d) {
  const long = [
    d.taker_buy_ratio_60s >= 0.55 && d.cvd_delta_60s > 0,
    d.book_imbalance_10 >= 0.20,
    d.rvol >= 2.0,
    d.preco > d.vwap,
    d.ema9_5m > d.ema21_5m && d.ema9_15m > d.ema21_15m
  ].filter(Boolean).length;
  const short = [
    d.taker_buy_ratio_60s <= 0.45 && d.cvd_delta_60s < 0,
    d.book_imbalance_10 <= -0.20,
    d.rvol >= 2.0,
    d.preco < d.vwap,
    d.ema9_5m < d.ema21_5m && d.ema9_15m < d.ema21_15m
  ].filter(Boolean).length;
  return { long, short };
}

// Gate antigo completo (5/5). No ciclo novo só é registrado (passou_gate_antigo); não bloqueia.
function avaliarGate(d) {
  const nao = (bloqueio, condicoes_ok = 0) => ({ ok: false, direcao: 'NONE', bloqueio, condicoes_ok });
  const v = validarCampos(d);
  if (v) return nao(v);
  if (d.atr_1m_pct < ATR_MIN_PCT) return nao('ATR_BAIXO');
  if (d.spread_pct > SPREAD_MAX_PCT) return nao('SPREAD_ALTO');
  const s5 = Math.sign(d.ema9_5m - d.ema21_5m), s15 = Math.sign(d.ema9_15m - d.ema21_15m);
  if (s5 === 0 || s5 !== s15) return nao('EMA_DIVERGENTE');
  const { long, short } = contarCondicoes(d);
  if (long === 5) return { ok: true, direcao: 'LONG', bloqueio: null, condicoes_ok: 5 };
  if (short === 5) return { ok: true, direcao: 'SHORT', bloqueio: null, condicoes_ok: 5 };
  return { ok: false, direcao: 'NONE', bloqueio: null, condicoes_ok: Math.max(long, short) };
}

// Bloqueio duro do ciclo novo (pula a moeda): campo ausente/incoerente, dados > 3 s, spread > 0,03%.
// ATR_BAIXO e as 5 condições NÃO bloqueiam.
function bloqueioDuro(d) {
  const v = validarCampos(d);
  if (v) return v;
  if (d.spread_pct > SPREAD_MAX_PCT) return 'SPREAD_ALTO';
  return null;
}

// Direção pela MAIORIA de 5 votos: fluxo (CVD/taker), book, VWAP, EMA 5m, EMA 15m.
// Cada voto: +1 LONG, -1 SHORT, 0 neutro. Empate: desempata o fluxo, depois o book.
function votarDirecao(d) {
  const dif = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.sign(a - b) : 0);
  const sg = (x) => (Number.isFinite(x) ? Math.sign(x) : 0);
  const votos = {
    fluxo: sg(d?.cvd_delta_60s) || dif(d?.taker_buy_ratio_60s, 0.5),
    book: sg(d?.book_imbalance_10),
    vwap: dif(d?.preco, d?.vwap),
    ema5m: dif(d?.ema9_5m, d?.ema21_5m),
    ema15m: dif(d?.ema9_15m, d?.ema21_15m)
  };
  const v = Object.values(votos);
  const s = Math.sign(v.reduce((a, b) => a + b, 0)) || votos.fluxo || votos.book;
  return {
    direcao: s > 0 ? 'LONG' : (s < 0 ? 'SHORT' : 'NONE'), votos,
    long: v.filter(x => x > 0).length, short: v.filter(x => x < 0).length
  };
}

// Candidata do ciclo: gate antigo (registro), bloqueio duro, direção por voto, condicoes_ok do lado escolhido.
function avaliarCandidata(simbolo, dados, extra = {}) {
  const gate = avaliarGate(dados);
  const voto = votarDirecao(dados);
  const sniper = avaliarSniper(dados); // direção e elegibilidade vêm do Sniper; os votos ficam só no registro
  const bloqueio = bloqueioDuro(dados) || sniper.bloqueio;
  const cond = bloqueioDuro(dados) === 'CAMPO_INVALIDO' ? { long: 0, short: 0 } : contarCondicoes(dados);
  const condicoes_ok = sniper.direcao === 'LONG' ? cond.long : (sniper.direcao === 'SHORT' ? cond.short : 0);
  return {
    simbolo, dados, extra, gate, bloqueio, direcao: sniper.direcao, votos: voto.votos, condicoes_ok, sniper,
    passou_gate_antigo: gate.ok === true && gate.direcao === sniper.direcao
  };
}

// Fase do ciclo de 5 min pelo relógio.
function faseCiclo(t) {
  const inicio = Math.floor(t / TURNO_MS) * TURNO_MS;
  const dentro = t - inicio;
  const fase = dentro < FASE_ANALISE_INI_MS ? 'ABERTO' : (dentro < FASE_CONFIRMACAO_INI_MS ? 'ANALISE' : 'CONFIRMACAO');
  const fim = fase === 'ABERTO' ? FASE_ANALISE_INI_MS : (fase === 'ANALISE' ? FASE_CONFIRMACAO_INI_MS : TURNO_MS);
  return { fase, inicio, dentroMs: dentro, faseRestanteMs: fim - dentro, cicloRestanteMs: TURNO_MS - dentro };
}

// ── RANKING (função pura) ──
// Score Sniper (0..100) quando a candidata traz c.sniper; senão soma de 3 termos normalizados 0..1: taker |r-0,5|*2, |imbalance|, (min(rvol,5)-2)/3.
// Cobre TODAS as moedas com dados (campo ausente = termo 0); bloqueio não sai do ranking.
// Desempate: score com diferença < 10% do líder do grupo -> maior volume 24h (c.volume_24h) vence.
function rankearCandidatas(lista) {
  const c01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
  const fin = (x) => (Number.isFinite(x) ? x : NaN);
  const pontuadas = (Array.isArray(lista) ? lista : []).filter(c => c && c.dados && typeof c.dados === 'object').map(c => {
    const d = c.dados;
    const norm = {
      taker: c01(Math.abs(fin(d.taker_buy_ratio_60s) - 0.5) * 2),
      imbalance: c01(Math.abs(d.book_imbalance_10)),
      rvol: c01((Math.min(d.rvol, 5) - 2) / 3)
    };
    return { ...c, norm, score: c.sniper ? c.sniper.score : norm.taker + norm.imbalance + norm.rvol };
  }).sort((a, b) => b.score - a.score);
  return desempatarPorVolume(pontuadas);
}

// Desempate: a partir do líder do grupo, quem tem score com diferença < 10% do líder (relativa ao líder) entra no
// grupo, e o grupo é ordenado por volume 24h decrescente (volume ausente = por último; empate = ordem de score).
// Agrupar pelo líder (e não comparar par a par) mantém a ordenação transitiva e determinística.
function desempatarPorVolume(ordenada) {
  const rest = ordenada.slice(), out = [];
  const vol = (c) => (Number.isFinite(c.volume_24h) ? c.volume_24h : -1);
  while (rest.length) {
    const lider = rest[0];
    const noGrupo = (c) => (lider.score > 0 ? (lider.score - c.score) / lider.score < DESEMPATE_SCORE_PCT : c.score === lider.score);
    const grupo = rest.filter(noGrupo).sort((a, b) => vol(b) - vol(a)); // sort estável: empate de volume mantém o score
    out.push(...grupo);
    for (const c of grupo) rest.splice(rest.indexOf(c), 1);
  }
  return out;
}

// ── RESUMO DO DIA (funções puras; o mesmo acumulador serve ao boot, ao motor e ao script) ──
function criarResumoDia(dia = null) {
  return {
    dia, turnos: 0, turnosVazios: 0, positivos: 0, negativos: 0, ops: 0, wins: 0, pnlLiquido: 0, taxasPagas: 0,
    entradas: { total: 0, preenchidas: 0, parciais: 0, canceladas: 0, gtxRejeitadas: 0 },
    saidas: { total: 0, market: 0, limite: 0 }, entradasTrade: { total: 0, maker: 0 }, bloqueios: {}
  };
}

const ACOES_SEM_BLOQUEIO = ['ENTROU', 'NENHUMA', 'NAO_ESCOLHIDA', 'BLOQUEADA'];
function motivoBloqueio(l) {
  if (l && 'bloqueio_duro' in l) { // ciclo novo: só bloqueio real conta (gate antigo não bloqueia)
    if (l.bloqueio_duro) return l.bloqueio_duro;
    return l.acao && !ACOES_SEM_BLOQUEIO.includes(l.acao) ? l.acao : null;
  }
  if (!l?.gate) return null;
  if (!l.gate.ok) return l.gate.bloqueio || `CONDICOES_${l.gate.condicoes_ok ?? 0}/5`;
  return l.acao && l.acao !== 'ENTROU' ? l.acao : null;
}

function acumularResumo(r, l) {
  if (!l || typeof l !== 'object') return r;
  if (l.tipo === 'DECISAO') {
    const m = motivoBloqueio(l);
    if (m) r.bloqueios[m] = (r.bloqueios[m] || 0) + 1;
  } else if (l.tipo === 'TURNO') {
    r.turnos++;
    if (l.status === 'VAZIO') r.turnosVazios++;
    else if (l.soma_liquida_testnet > 0) r.positivos++;
    else if (l.soma_liquida_testnet < 0) r.negativos++;
  } else if (l.tipo === 'TRADE') {
    if (l.entrada_tipo && r.entradasTrade) { // maker de entrada = perna toda LIMITE (MISTA/MARKET = taker)
      r.entradasTrade.total++;
      if (l.entrada_tipo === 'LIMITE') r.entradasTrade.maker++;
    }
    if (l.saida_tipo) {
      r.saidas.total++;
      if (l.saida_tipo === 'MARKET') r.saidas.market++; else r.saidas.limite++;
    }
    const liq = l.pnl_testnet?.liquido;
    if (Number.isFinite(liq)) {
      r.ops++; if (liq > 0) r.wins++;
      r.pnlLiquido += liq; r.taxasPagas += Number(l.pnl_testnet.taxas) || 0;
    }
  } else if (l.tipo === 'EVENTO' && l.evento === 'SCALP_ENTRADA_LIMITE') {
    const e = r.entradas;
    e.total++;
    if (l.resultado === 'PREENCHIDA') e.preenchidas++;
    else if (l.resultado === 'PARCIAL') e.parciais++;
    else if (l.resultado === 'CANCELADA') e.canceladas++;
    else if (l.resultado === 'GTX_REJEITADA') e.gtxRejeitadas++;
  }
  return r;
}

function formatarResumo(r) {
  const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);
  return {
    dia: r.dia !== null && r.dia !== undefined ? new Date(r.dia).toISOString().slice(0, 10) : null,
    turnos: r.turnos, turnosVazios: r.turnosVazios, positivos: r.positivos, negativos: r.negativos,
    operacoes: r.ops, pnlLiquido: r.pnlLiquido, taxasPagas: r.taxasPagas,
    winRatePorOperacao: pct(r.wins, r.ops),
    expectativaLiquidaMediaPorOperacao: r.ops ? r.pnlLiquido / r.ops : null,
    entradasLimite: r.entradas.total,
    pctEntradasLimitePreenchidas: pct(r.entradas.preenchidas + r.entradas.parciais, r.entradas.total),
    pctEntradasCanceladas: pct(r.entradas.canceladas, r.entradas.total),
    pctEntradasGtxRejeitadas: pct(r.entradas.gtxRejeitadas, r.entradas.total),
    saidas: r.saidas.total,
    pctSaidasMarket: pct(r.saidas.market, r.saidas.total),
    pctEntradaMaker: pct(r.entradasTrade?.maker || 0, r.entradasTrade?.total || 0),
    pctSaidaMaker: pct(r.saidas.limite, r.saidas.total),
    top3Bloqueios: Object.entries(r.bloqueios).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([motivo, n]) => ({ motivo, n }))
  };
}

// PnL de uma perna: taxa por lado sobre o notional (entrada e saída podem ter taxas
// diferentes: maker 0,02% na limite, taker 0,05% na Market); slippage em % de cada perna.
function calcularPnl({ lado, qty, entrada, saida, taxaPct = TAXA_PCT, taxaEntradaPct, taxaSaidaPct, slipEntradaPct = 0, slipSaidaPct = 0 }) {
  const sinal = lado === 'LONG' ? 1 : -1;
  const bruto = (saida - entrada) * qty * sinal;
  const te = Number.isFinite(taxaEntradaPct) ? taxaEntradaPct : taxaPct;
  const ts = Number.isFinite(taxaSaidaPct) ? taxaSaidaPct : taxaPct;
  const taxas = entrada * qty * te / 100 + saida * qty * ts / 100;
  const slippage = entrada * qty * (slipEntradaPct || 0) / 100 + saida * qty * (slipSaidaPct || 0) / 100;
  return { bruto, taxas, slippage, liquido: bruto - taxas - slippage };
}

// RSI(14) de Wilder sobre fechamentos 1m; null sem dados suficientes.
function rsi14(closes, periodo = 14) {
  if (!Array.isArray(closes) || closes.length < periodo + 1 || closes.some(c => !(c > 0))) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= periodo; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= periodo; l /= periodo;
  for (let i = periodo + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (periodo - 1) + Math.max(d, 0)) / periodo; l = (l * (periodo - 1) + Math.max(-d, 0)) / periodo;
  }
  return l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
}

// Contexto extra para a decisão do Jev (função pura): retornos de 1/3/5/15 min, RSI, posição na faixa de 15 min, distância ao VWAP,
// folga das EMAs, regime do BTC (candles 5m), custo da operação contra o movimento esperado e histórico recente do bot.
// hist = { moeda: [liquidos recentes da moeda], bot: [liquidos dos últimos trades] }.
function contextoMercado({ k1m, dados, btc5m, agora, hist = null }) {
  const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
  const ks1 = fechadas(k1m, agora);
  const c1 = ks1.map(k => num(k[4]));
  const ult = c1.length ? c1[c1.length - 1] : null;
  const ret = (n) => (c1.length > n && c1[c1.length - 1 - n] > 0 && ult > 0 ? (ult / c1[c1.length - 1 - n] - 1) * 100 : null);
  const jan = ks1.slice(-15);
  const hi = jan.length ? Math.max(...jan.map(k => num(k[2]))) : null, lo = jan.length ? Math.min(...jan.map(k => num(k[3]))) : null;
  const preco = dados?.preco;
  const gap = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : null);
  const cb = fechadas(btc5m, agora).map(k => num(k[4]));
  const rb = (n) => (cb.length > n && cb[cb.length - 1 - n] > 0 ? (cb[cb.length - 1] / cb[cb.length - 1 - n] - 1) * 100 : null);
  const custoTaker = 2 * TAXA_TAKER_PCT, custoMaker = 2 * TAXA_MAKER_PCT;
  const mov2m = Number.isFinite(dados?.atr_1m_pct) ? dados.atr_1m_pct * Math.SQRT2 : null;
  const soma = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) : 0);
  const bot = hist?.bot || [], moeda = hist?.moeda || [];
  return {
    ret_1m_pct: r4(ret(1)), ret_3m_pct: r4(ret(3)), ret_5m_pct: r4(ret(5)), ret_15m_pct: r4(ret(15)),
    rsi14_1m: r4(rsi14(c1.slice(-60))),
    posicao_faixa_15m: hi > lo && preco > 0 ? r4((preco - lo) / (hi - lo)) : null, // 0 = na mínima, 1 = na máxima dos últimos 15 min
    dist_vwap_pct: r4(gap(preco, dados?.vwap)), ema_gap_5m_pct: r4(gap(dados?.ema9_5m, dados?.ema21_5m)), ema_gap_15m_pct: r4(gap(dados?.ema9_15m, dados?.ema21_15m)),
    btc_ret_5m_pct: r4(rb(1)), btc_ret_15m_pct: r4(rb(3)), btc_ret_60m_pct: r4(rb(12)),
    custo_ida_e_volta_taker_pct: r4(custoTaker), custo_ida_e_volta_maker_pct: r4(custoMaker),
    movimento_esperado_2min_pct: r4(mov2m), razao_movimento_custo: mov2m !== null ? r4(mov2m / custoTaker) : null,
    ultimos_trades_moeda_usdt: moeda.slice(-5).map(r4),
    bot_ultimos_trades: { n: bot.length, vitorias: bot.filter(x => x > 0).length, liquido_usdt: r4(soma(bot)) }
  };
}

// Corrida contra um prazo: devolve o valor da promessa ou 'PRAZO_JEV' se passar de `ms` (a promessa segue rodando).
function comPrazo(promessa, ms) {
  let tm;
  const lim = new Promise(r => { tm = setTimeout(() => r('PRAZO_JEV'), Math.max(1, ms)); });
  return Promise.race([promessa, lim]).finally(() => clearTimeout(tm));
}

// ── JEV: decide compra (LONG) ou venda (SHORT) das moedas escolhidas, 3 s antes da fronteira ──
// Devolve { direcao: 'LONG'|'SHORT'|null, choice, conf, fonte: 'JEV'|'CODIGO', motivo, latenciaMs }.
// direcao null (sem chave, timeout, erro, JSON inválido ou WAIT) = vale a direção do código (fonte CODIGO).
async function consultarJev(dados, dirCodigo, ctx = {}, opts = {}) {
  const { apiKey, url = JEV_URL_PADRAO, post = axios.post, timeoutMs = JEV_TIMEOUT_MS, onUsage } = opts;
  const t0 = Date.now();
  const codigo = (motivo, mais = {}) => ({ direcao: null, choice: null, conf: null, fonte: 'CODIGO', motivo, latenciaMs: Date.now() - t0, timeout: false, ...mais });
  if (!apiKey) return codigo('SEM_JEV_API_KEY');
  const payload = {
    model: 'jev-latest',
    state: {
      ...dados, direcao_sugerida_codigo: dirCodigo, votos: ctx.votos ?? null, condicoes_ok: ctx.condicoes_ok ?? null,
      score: ctx.score ?? null, holding_seconds: SCALP_DURACAO_MS / 1000, contexto: ctx.contexto ?? null
    },
    questions: {
      acao: {
        type: 'choice',
        instructions: 'Binance Futures sniper scalp, 5x, 2-minute cycle with take profit at +0.32% price, entry at the next 2-minute boundary (in about 3 seconds). The code already approved the setup (Supertrend 1m, EMA 5m, VWAP, flow, book, RVOL); approve only if you agree with direcao_sugerida_codigo, otherwise answer WAIT. ' +
          'state holds fresh mainnet data (taker flow, CVD, order book imbalance, RVOL, VWAP, EMA 5m/15m, ATR, spread) and the code vote in direcao_sugerida_codigo. ' +
          'state.contexto adds returns (1/3/5/15 min), RSI, position in the 15-min range, distance to VWAP, BTC regime, the round-trip fee (custo_ida_e_volta_*) ' +
          'against the expected 2-minute move (movimento_esperado_2min_pct, razao_movimento_custo) and the bot recent results. ' +
          'Fees are the main cost: choose the direction most likely to pay over the next 2 minutes NET of fees; answer WAIT when razao_movimento_custo is below about 1.5, ' +
          'when the move looks exhausted (RSI extreme, price at the edge of the 15-min range) or when signals conflict.',
        criteria: {
          LONG: 'Buy: flow, book, VWAP and EMAs lean up and price is more likely higher in 2 minutes.',
          SHORT: 'Sell: flow, book, VWAP and EMAs lean down and price is more likely lower in 2 minutes.',
          WAIT: 'Expected move does not clearly beat fees, signals conflict, data looks stale or the move is exhausted.'
        }
      }
    }
  };
  let timer;
  const limite = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT')), timeoutMs); });
  try {
    const resp = await Promise.race([
      post(url, payload, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: timeoutMs, maxRedirects: 0 }),
      limite
    ]);
    if (resp?.data?.usage && onUsage) { try { onUsage(resp.data.usage); } catch (e) {} }
    const ans = resp?.data?.answers?.acao;
    const choice = String(ans?.choice || '').toUpperCase();
    const conf = Math.round((Number(ans?.confidence) || 0) * 100);
    if (!['LONG', 'SHORT', 'WAIT'].includes(choice)) return codigo('RESPOSTA_INVALIDA', { timeout: true }); // inválida = vale o código, jev_timeout=true
    if (choice === 'WAIT') return codigo('WAIT', { choice, conf });
    return { direcao: choice, choice, conf, fonte: 'JEV', motivo: `JEV ${choice} ${conf}%`, latenciaMs: Date.now() - t0, timeout: false };
  } catch (e) {
    const to = e.message === 'TIMEOUT' || e.code === 'ECONNABORTED';
    return codigo(to ? 'TIMEOUT' : cortarMotivo(`ERRO_HTTP: ${e.message}`), { timeout: true }); // estourou/erro = vale o código, jev_timeout=true
  } finally {
    clearTimeout(timer);
  }
}

// ── VETO GEMINI (fail-closed) — legado: o motor do scalp não chama mais o Gemini (decisão = Jev) ──
async function vetoGemini(dados, dirCodigo, opts = {}) {
  const { apiKey, systemPrompt, post = axios.post, timeoutMs = GEMINI_TIMEOUT_MS, onUsage } = opts;
  if (!apiKey) return { aprovado: false, motivo: 'SEM_ROUTER_API_KEY' };
  if (!systemPrompt) return { aprovado: false, motivo: 'SEM_PROMPT' };
  const payload = {
    model: MODELO_GEMINI,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify(dados) }],
    temperature: 0,
    max_tokens: 200
  };
  const t0 = Date.now();
  let timer;
  const limite = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT')), timeoutMs); });
  try {
    const resp = await Promise.race([
      post(ROUTER_URL, payload, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: timeoutMs }),
      limite
    ]);
    if (resp?.data?.usage && onUsage) { try { onUsage(resp.data.usage); } catch (e) {} }
    const raw = String(resp?.data?.choices?.[0]?.message?.content || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    let r;
    try { r = JSON.parse(raw); } catch (e) { return { aprovado: false, motivo: 'JSON_INVALIDO', latenciaMs: Date.now() - t0 }; }
    if (!r || typeof r.entrar !== 'boolean' || !['LONG', 'SHORT', 'NONE'].includes(r.direcao)) {
      return { aprovado: false, motivo: 'JSON_INVALIDO', latenciaMs: Date.now() - t0 };
    }
    if ('motivo' in r) r.motivo = cortarMotivo(r.motivo);
    if (!r.entrar) return { aprovado: false, motivo: 'VETO', resposta: r, latenciaMs: Date.now() - t0 };
    if (r.direcao !== dirCodigo) return { aprovado: false, motivo: 'DIRECAO_DIVERGENTE', resposta: r, latenciaMs: Date.now() - t0 };
    return { aprovado: true, motivo: 'APROVADO', resposta: r, latenciaMs: Date.now() - t0 };
  } catch (e) {
    const to = e.message === 'TIMEOUT' || e.code === 'ECONNABORTED';
    return { aprovado: false, motivo: to ? 'TIMEOUT' : cortarMotivo(`ERRO_HTTP: ${e.message}`), latenciaMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// Confirmação de direção: mesmo prompt e mesmo parser (entrar/direcao); o user message ganha o modo e a direção do código.
function payloadConfirmacao(dados, dirCodigo) {
  return {
    ...dados,
    modo: 'CONFIRMAR_DIRECAO',
    direcao_sugerida_codigo: dirCodigo,
    instrucao: 'Modo confirmação: o código já decidiu entrar nesta moeda. Ignore o gate 5/5 e o ATR. ' +
      'Responda o mesmo JSON com entrar=true e direcao LONG ou SHORT = a direção mais provável nos próximos 60 s. ' +
      'Se discordar da direcao_sugerida_codigo, responda a direção oposta.'
  };
}

// Resultado do Gemini -> direção. Só direção LONG/SHORT válida conta; timeout/erro/JSON inválido/NONE = vale o código.
function interpretarConfirmacao(g, dirCodigo) {
  const d = g?.resposta?.direcao;
  const direcao_gemini = d === 'LONG' || d === 'SHORT' ? d : null;
  return {
    direcao_gemini, discordou: !!direcao_gemini && direcao_gemini !== dirCodigo,
    motivo: g?.motivo ?? null, resposta: g?.resposta || null, latenciaMs: g?.latenciaMs ?? null
  };
}

function criarContadorVeto(limiar = VETO_ALERTA_TAXA, amostraMin = VETO_AMOSTRA_MIN) {
  let aprovados = 0, vetos = 0;
  const resumo = () => {
    const total = aprovados + vetos;
    const taxaVeto = total ? vetos / total : 0;
    return { aprovados, vetos, total, taxaVeto, alerta: total >= amostraMin && taxaVeto > limiar };
  };
  return { registrar(aprovado) { if (aprovado) aprovados++; else vetos++; return resumo(); }, resumo };
}

function registrarJsonl(arquivo, obj) {
  try {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.appendFileSync(arquivo, JSON.stringify(obj) + '\n');
  } catch (e) { console.error('[SCALP-LOG]', e.message); }
}

function lerFlag(arquivo) {
  try { return !!JSON.parse(fs.readFileSync(arquivo, 'utf8')).SCALP_1M_ENABLED; } catch (e) { return false; }
}

function salvarFlag(arquivo, valor) {
  let atual = {};
  try { atual = JSON.parse(fs.readFileSync(arquivo, 'utf8')) || {}; } catch (e) {}
  try { fs.writeFileSync(arquivo, JSON.stringify({ ...atual, SCALP_1M_ENABLED: !!valor }, null, 2)); } catch (e) {}
}

// ── MOTOR (efeitos colaterais; dependências injetadas pelo painel) ──
function criarMotor(deps) {
  const {
    fut, feed, rest, localAlvos, salvarAlvos, closingInProgress, simboloOcupadoPsar,
    registrarDesfechoTrade, rag, configFile, logFile, jevKey, jevUrl, onUsage, baseOrdens
  } = deps;
  const agora = deps.agora || (() => Date.now());
  const dormir = deps.dormir || ((ms) => new Promise(r => setTimeout(r, ms)));
  const cicloDe = (ms) => Math.floor(ms / TURNO_MS);
  const slotVazio = () => ({ symbol: null, side: null, status: 'LIVRE', openTime: null });
  const estado = {
    enabled: lerFlag(configFile),
    slots: { 3: slotVazio(), 4: slotVazio() },
    ultimaFronteira: 0,
    rodando: false,
    monitorando: false,
    ultimoCiclo: null,
    atrBaixo: { total: 0, porSimbolo: {} },
    turno: null,          // turno corrente (ou o último encerrado)
    ultimoTurno: null,    // resumo do último turno encerrado (fechado ou vazio)
    historico: [],        // últimos 10 turnos encerrados (resumoTurno)
    ranking: [],          // top 5 da última análise (todas as moedas)
    rankingTs: null,
    ultimaAnalise: 0,
    plano: null,          // confirmação 4:30-5:00 para a fronteira seguinte
    recentes: [],         // últimos trades com líquido conhecido: { sym, liq } (contexto do Jev)
    jev: { total: 0, diverge: 0, falhas: 0, pulou: 0, timeouts: 0, comOpiniao: 0, concorda: 0, latenciaSomaMs: 0 }, // decisões do Jev: divergiu do código / caiu no código (falha, timeout, WAIT)
    hoje: criarResumoDia(inicioDiaUtc(agora())),
    simbolos: [],         // lista de 20 corrente (rodízio de 6 ciclos)
    universo: [],         // [{ simbolo, atr_pct, volume_24h, origem }] da última montagem
    universoTs: 0,
    universoCiclo: null,  // índice do ciclo (floor(t / TURNO_MS)) em que a lista foi montada
    universoRetryTs: 0,   // falha na montagem: nova tentativa a partir deste instante
    fora: new Map(),      // símbolo -> índice do ciclo em que fica fora (prejuízo/zero/erro no ciclo anterior)
    ultimoNumero: 0       // numeração de turno contínua (derivada do JSONL no boot)
  };
  const filtroTestnet = deps.filtroTestnet || ((sym) => (typeof fut.filtrosDe === 'function' ? fut.filtrosDe(sym) : null));
  if (Array.isArray(deps.universoInicial) && deps.universoInicial.length) { // injeção (testes/diagnóstico): lista já carregada
    estado.simbolos = deps.universoInicial.slice();
    estado.universo = estado.simbolos.map(simbolo => ({ simbolo, atr_pct: null, volume_24h: null, origem: 'NOVA' }));
    estado.universoTs = agora();
    estado.universoCiclo = cicloDe(agora());
    if (typeof feed.assinar === 'function') feed.assinar(estado.simbolos);
  }
  let atualizandoUniverso = null;
  // Peso REST mainnet compartilhado (klines + ranking). null = sem controle (injeção em teste).
  const peso = deps.controlePeso !== undefined ? deps.controlePeso
    : criarControlePeso({ lerHeader: typeof rest?.pesoUsado === 'function' ? rest.pesoUsado : null });
  const viaPeso = (w, fn) => (peso ? peso.executar(w, fn) : fn());
  const cacheK = new Map();          // klines por símbolo|tf, válidas até o próximo candle fechar
  const logCampo = new Map();        // símbolo -> último log de campo inválido
  const jevTimeoutMs = deps.jevTimeoutMs || JEV_TIMEOUT_MS;
  // FORA 1 CICLO (substitui a geladeira): prejuízo, zero ou erro técnico tira a moeda SÓ do próximo ciclo; depois volta.
  const foraNoCiclo = (sym, ciclo) => estado.fora.get(sym) === ciclo;
  function marcarFora(sym, motivo, liq = null) {
    const ate = cicloDe(agora()) + 1;
    for (const [k, v] of estado.fora) if (v < ate) estado.fora.delete(k); // limpa os ciclos já passados
    estado.fora.set(sym, ate);
    console.log(`[SCALP-FORA] ${sym} ${motivo} líq ${liq === null ? '--' : '$' + liq.toFixed(4)}: fora do ciclo ${new Date(ate * TURNO_MS).toISOString()}; volta no seguinte`);
    logar({ tipo: 'EVENTO', evento: 'SCALP_FORA_1_CICLO', ts: agora(), simbolo: sym, motivo, liquido: liq, ciclo_fora_ms: ate * TURNO_MS });
  }
  let timer = null;
  let timerMonitor = null;
  const MSG_NAO_TESTNET = `SCALP_1M recusado: base de ordens não é testnet (${String(baseOrdens || 'indefinida')}). Configure FUTURES_BASE do testnet.`;

  const entrando = new Set();          // fase ENTRANDO por símbolo (entrar() em curso): /api/close devolve 409
  const cancelSemAlvo = new Map();     // símbolo -> tentativas: cancelamento falhou e o alvo já não existe
  const slotDe = (sym) => SLOTS.find(n => estado.slots[n].symbol === sym) || null;
  const slotsLivres = () => SLOTS.filter(n => !estado.slots[n].symbol);
  const ocupadoOutro = (sym) => !!(localAlvos[sym] || closingInProgress.has(sym) || slotDe(sym) || simboloOcupadoPsar(sym));
  const ocupado = (sym) => ocupadoOutro(sym) || entrando.has(sym) || cancelSemAlvo.has(sym);
  const codigoErro = (e) => e?.response?.data?.code ?? null;
  const travaLogada = new Set();
  // Trava testnet em todo envio de ordem do scalp: base não-testnet = não envia, loga e desliga o motor.
  const travaOk = (sym, acao) => {
    if (ehTestnet(baseOrdens)) return true;
    estado.enabled = false;
    if (!travaLogada.has(`${sym}|${acao}`)) {
      travaLogada.add(`${sym}|${acao}`);
      console.error(`[SCALP-1M] ${sym} ${acao}: ordem não enviada. ${MSG_NAO_TESTNET}`);
    }
    return false;
  };
  // Cancela TODAS as ordens do símbolo (limite de entrada/saída e stops) ANTES da Market de fechamento: nenhuma ordem
  // resting pode preencher depois do zeramento e reabrir a posição. true = livro limpo; false = falhou (a Market
  // segue mesmo assim: posição aberta pesa mais; o cancelamento é refeito depois e, se falhar, vira cancelPendente).
  const cancelarAntesDaMarket = (sym) => fut.cancelarTodasOrdens(sym, { estrito: true }).then(r => !!r).catch(() => false);
  const posicoesScalp = () => Object.keys(localAlvos).filter(s => localAlvos[s]?.modo === 'scalp_1m');
  const precoTaker = (book, lado) => num(lado === 'BUY' ? book?.asks?.[0]?.[0] : book?.bids?.[0]?.[0]);
  const precoMaker = (book, lado) => num(lado === 'BUY' ? book?.bids?.[0]?.[0] : book?.asks?.[0]?.[0]);
  const resumoTurno = (l) => ({
    numero: l.numero ?? null, id: l.turno_id ?? null, vazio: l.status === 'VAZIO', motivo: l.motivo || null,
    trades: l.trades || 0, somaLiquida: l.soma_liquida_testnet ?? null, somaLiquidaMainnet: l.soma_liquida_mainnet ?? null,
    positivo: l.status === 'VAZIO' || !Number.isFinite(l.soma_liquida_testnet) ? null : l.soma_liquida_testnet > 0,
    moedas: Array.isArray(l.moedas) ? l.moedas : [], direcoes: Array.isArray(l.direcoes) ? l.direcoes : []
  });
  const guardarTurno = (r) => {
    estado.ultimoTurno = r;
    estado.historico.push(r);
    if (estado.historico.length > HISTORICO_MAX) estado.historico.splice(0, estado.historico.length - HISTORICO_MAX);
  };

  // Toda linha do JSONL passa aqui: ganha turno_id e alimenta o resumo do dia (UTC).
  function logar(obj) {
    const linha = { ...obj, turno_id: obj.turno_id !== undefined ? obj.turno_id : (estado.turno?.id ?? null) };
    const dia = inicioDiaUtc(Number(linha.ts) || agora());
    if (dia > estado.hoje.dia) estado.hoje = criarResumoDia(dia);
    if (dia === estado.hoje.dia) acumularResumo(estado.hoje, linha);
    registrarJsonl(logFile, linha);
  }

  // Boot: 'hoje' é refeito lendo o JSONL do dia (sem arquivo novo).
  (function carregarHoje() {
    try {
      if (!logFile || !fs.existsSync(logFile)) return;
      const ini = Math.max(estado.hoje.dia, Number(typeof deps.marcoZero === 'function' ? deps.marcoZero() : 0) || 0); // ZERAR: nada antes do marco zero entra nos contadores
      for (const s of fs.readFileSync(logFile, 'utf8').split('\n')) {
        if (!s) continue;
        let l;
        try { l = JSON.parse(s); } catch (e) { continue; }
        if (l?.tipo === 'TURNO' && Number.isFinite(l.numero) && l.numero > estado.ultimoNumero) estado.ultimoNumero = l.numero;
        if (l?.tipo === 'TRADE' && Number.isFinite(l.pnl_testnet?.liquido)) { estado.recentes.push({ sym: l.simbolo, liq: l.pnl_testnet.liquido }); if (estado.recentes.length > 60) estado.recentes.shift(); }
        if (!(Number(l?.ts) >= ini)) continue;
        acumularResumo(estado.hoje, l);
        if (l.tipo === 'TURNO') guardarTurno(resumoTurno(l));
      }
    } catch (e) { console.error('[SCALP-HOJE]', e.message); }
  })();

  function definirEnabled(v) {
    if (v && !ehTestnet(baseOrdens)) {
      console.error(`[SCALP-1M] ${MSG_NAO_TESTNET}`);
      throw new Error(MSG_NAO_TESTNET);
    }
    estado.enabled = !!v;
    salvarFlag(configFile, estado.enabled);
    if (estado.enabled) feed.iniciar();
    console.log(`[SCALP-1M] ${estado.enabled ? 'LIGADO' : 'DESLIGADO'}`);
    return estado.enabled;
  }

  // ── ÓRFÃS: posição sem gestão normal. Não bloqueia o turno; alerta aos 5 min, sem forçar fechamento. ──
  function marcarOrfa(sym, a, motivo) {
    if (!a || a.orfa) return;
    a.orfa = true; a.orfaDesde = agora(); a.sarLabel = '[SCALP 1m ÓRFÃ]';
    const n = slotDe(sym);
    if (n) estado.slots[n].status = `[SCALP ÓRFÃ] ${sym} ${a.side}`;
    salvarAlvos();
    console.error(`[SCALP-ORFA] ${sym} ${a.side}: posição sem gestão normal (${motivo}); slot ${n || '-'} segue ocupado`);
    logar({ tipo: 'EVENTO', evento: 'SCALP_ORFA', ts: agora(), turno_id: a.turnoId ?? null, simbolo: sym, lado: a.side, motivo, slot: n });
  }

  function verificarOrfas() {
    for (const sym of posicoesScalp()) {
      const a = localAlvos[sym];
      if (!a.orfa || a.orfaAlertada || agora() - (a.orfaDesde || 0) < ORFA_ALERTA_MS) continue;
      a.orfaAlertada = true;
      console.error(`[SCALP-ORFA] ALERTA ${sym} ${a.side}: órfã há ${Math.round((agora() - (a.orfaDesde || 0)) / 60000)} min; sem fechamento forçado. Conferir na corretora.`);
      logar({ tipo: 'EVENTO', evento: 'SCALP_ORFA_ALERTA', ts: agora(), turno_id: a.turnoId ?? null, simbolo: sym, lado: a.side, orfa_desde: a.orfaDesde || null });
    }
  }

  // Conta 1 tentativa de saída/cancelamento falha. No teto: órfã abandonada, slot ocupado, sem novas ordens.
  // O contador vive no alvo: some só quando a posição fecha (finalizar ou /api/close apagam o alvo).
  function falhaSaida(sym, a, motivo) {
    if (!a || a.abandonada) return;
    a.tentativasSaida = (a.tentativasSaida || 0) + 1;
    if (a.tentativasSaida < MAX_TENTATIVAS_SAIDA) { salvarAlvos(); return; }
    a.abandonada = true;
    marcarOrfa(sym, a, `teto de ${MAX_TENTATIVAS_SAIDA} tentativas de saída`);
    salvarAlvos();
    const n = slotDe(sym);
    console.error(`[SCALP-ORFA] ALERTA ${sym} ${a.side}: ${a.tentativasSaida} tentativas de saída falharam (${motivo}); motor parou de tentar. Slot ${n || '-'} ocupado. Fechar manualmente.`);
    logar({ tipo: 'EVENTO', evento: 'SCALP_ORFA_ABANDONADA', ts: agora(), turno_id: a.turnoId ?? null, simbolo: sym, lado: a.side, tentativas: a.tentativasSaida, motivo, slot: n });
  }

  // Cancelamento falhou depois de a posição sair: alvo mantido com o desfecho pendente; o monitor retenta.
  // pend = { semTrade: true } (sem linha TRADE) ou { fin: [motivo, saidaTestnet, mainnet, slip, saidaInfo] }.
  function marcarCancelPendente(sym, a, pend) {
    if (!a) return;
    if (pend.fin && pend.fin.length < 3) {
      const m = lerMainnetSaida(sym, a.side);
      pend = { fin: [pend.fin[0], pend.fin[1] > 0 ? pend.fin[1] : null, m.preco, m.slip, { tipo: 'MARKET', taxaPct: TAXA_TAKER_PCT }] };
    }
    a.fechando = false; a.fechandoDesde = 0;
    a.cancelPendente = pend;
    salvarAlvos();
    console.error(`[SCALP-CANCEL] ${sym}: cancelamento de ordens falhou; alvo mantido, nova tentativa no próximo ciclo`);
    falhaSaida(sym, a, 'CANCEL_FALHOU');
  }

  async function retentarCancelPendente(sym, a) {
    if (!(await fut.cancelarTodasOrdens(sym, { estrito: true }).catch(() => false))) {
      if (a.abandonada) { // após o teto: retenta em silêncio, log espaçado (30 s); alerta [SCALP-ORFA] já saiu 1 vez
        if (agora() - (a.cancelLogTs || 0) >= 30000) { a.cancelLogTs = agora(); console.error(`[SCALP-CANCEL] ${sym}: cancelamento segue falhando (órfã abandonada); retentativa continua`); }
        return;
      }
      console.error(`[SCALP-CANCEL] ${sym}: cancelamento falhou de novo; alvo mantido (tentativa ${(a.tentativasSaida || 0) + 1}/${MAX_TENTATIVAS_SAIDA})`);
      falhaSaida(sym, a, 'CANCEL_FALHOU');
      return;
    }
    const p = a.cancelPendente;
    a.cancelPendente = null;
    if (p?.fin) { finalizar(sym, a, ...p.fin); return; }
    delete localAlvos[sym]; salvarAlvos(); liberarSlot(sym);
    console.log(`[SCALP-CANCEL] ${sym}: ordens canceladas; alvo removido sem linha TRADE`);
    talvezFecharTurno();
  }

  // Órfã/herdada sem stop: rearma o stop de emergência (stop_pct do alvo; sem ele 0,30%) antes de qualquer saída.
  // Stop já na corretora não duplica.
  async function garantirStopOrfa(sym, a, pos) {
    if (!a || a.slNaCorretora) return true;
    if (!travaOk(sym, 'SL_ORFA')) return false;
    const lado = pos?.lado || a.side;
    const ladoOrd = lado === 'LONG' ? 'SELL' : 'BUY';
    let abertas;
    try { abertas = await fut.openAlgoOrdens(sym); } catch (e) {
      console.error(`[SCALP-ORFA] ${sym}: consulta de stops falhou (${e.message}); rearme fica para o próximo ciclo`);
      return false;
    }
    if ((abertas || []).some(o => o.side === ladoOrd && /STOP/.test(String(o.orderType || o.type || '')))) {
      a.slNaCorretora = true; salvarAlvos();
      return true;
    }
    const ent = num(a.entryPrice) > 0 ? num(a.entryPrice) : num(pos?.precoEntrada);
    const pct = num(a.stop_pct) > 0 ? num(a.stop_pct) : SL_EMERG_PCT;
    const sl = num(a.slPrice) > 0 ? num(a.slPrice) : (ent > 0 ? ent * (1 + (lado === 'LONG' ? -1 : 1) * pct / 100) : null);
    if (!(sl > 0)) { console.error(`[SCALP-ORFA] ${sym}: sem preço de entrada; stop não rearmado`); return false; }
    try {
      await fut.colocarStopLoss(sym, lado, sl);
    } catch (e) {
      console.error(`[SCALP-ORFA] ${sym}: rearme do stop recusado (${e.message})`);
      return false;
    }
    a.slPrice = sl; a.stop_preco = sl; a.slNaCorretora = true; salvarAlvos();
    console.warn(`[SCALP-ORFA] ${sym} ${lado}: stop de emergência rearmado @ ${sl}`);
    logar({ tipo: 'EVENTO', evento: 'SCALP_SL_REARMADO', ts: agora(), turno_id: a.turnoId ?? null, simbolo: sym, lado, sl_preco: sl });
    return true;
  }

  // ── TURNO ──
  function somaTurno(tu) {
    const soma = (campo) => {
      const v = (tu?.trades || []).map(t => t[campo]).filter(Number.isFinite);
      return v.length ? v.reduce((a, b) => a + b, 0) : null;
    };
    return { testnet: soma('liquido_testnet'), mainnet: soma('liquido_mainnet'), trades: (tu?.trades || []).length };
  }

  function fecharTurno(tu) {
    if (!tu || tu.status === 'FECHADO' || tu.status === 'VAZIO') return;
    tu.status = 'FECHADO';
    const s = somaTurno(tu);
    const orfas = posicoesScalp().filter(sym => localAlvos[sym].turnoId === tu.id);
    const linha = {
      tipo: 'TURNO', ts: agora(), turno_id: tu.id, numero: tu.numero, status: 'FECHADO', inicio_ms: tu.fronteira,
      duracao_ms: agora() - tu.fronteira, moedas: tu.moedas, direcoes: tu.moedas.map(sym => tu.direcoes?.[sym] || null), trades: s.trades,
      soma_liquida_testnet: s.testnet, soma_liquida_mainnet: s.mainnet,
      positivo: Number.isFinite(s.testnet) ? s.testnet > 0 : null, orfas, detalhe: tu.trades
    };
    logar(linha);
    guardarTurno(resumoTurno(linha));
    const f = (x) => (Number.isFinite(x) ? '$' + x.toFixed(4) : '--');
    console.log(`[SCALP-TURNO] #${tu.numero} fechado | ${s.trades} op. | testnet líq ${f(s.testnet)} | mainnet líq ${f(s.mainnet)}${orfas.length ? ` | órfãs: ${orfas.join(',')}` : ''}`);
  }

  function turnoVazio(tu, motivo, extra = {}) {
    tu.status = 'VAZIO';
    const linha = {
      tipo: 'TURNO', ts: agora(), turno_id: tu.id, numero: tu.numero, status: 'VAZIO', motivo, inicio_ms: tu.fronteira,
      moedas: [], direcoes: [], trades: 0, soma_liquida_testnet: 0, soma_liquida_mainnet: 0, positivo: null, ...extra
    };
    logar(linha);
    guardarTurno(resumoTurno(linha));
    console.log(`[SCALP-TURNO] #${tu.numero} VAZIO: ${motivo}`);
  }

  // Turno termina quando as posições dele fecham (órfãs não seguram o turno).
  function talvezFecharTurno() {
    const tu = estado.turno;
    if (!tu || tu.status !== 'ATIVO') return;
    tu.abertas = tu.abertas.filter(s => localAlvos[s]?.modo === 'scalp_1m' && localAlvos[s].turnoId === tu.id && !localAlvos[s].orfa);
    if (!tu.abertas.length) fecharTurno(tu);
  }

  // Fechamento: líquido testnet <= 0 ou desconhecido (prejuízo, zero ou erro técnico) = fora só do próximo ciclo; lucro não marca.
  function classificarFora(sym, motivo, pnlT) {
    const liq = pnlT && Number.isFinite(pnlT.liquido) ? pnlT.liquido : null;
    if (liq !== null && liq > 0) return;
    marcarFora(sym, motivo, liq);
  }

  function contabilizarTurno(sym, alvo, motivo, saidaTipo, pnlT, pnlM) {
    const tu = estado.turno;
    if (!tu || !alvo?.turnoId || tu.id !== alvo.turnoId || tu.status === 'FECHADO' || tu.status === 'VAZIO') return;
    tu.trades.push({ simbolo: sym, motivo, saida_tipo: saidaTipo, liquido_testnet: pnlT ? pnlT.liquido : null, liquido_mainnet: pnlM ? pnlM.liquido : null });
    tu.abertas = tu.abertas.filter(s => s !== sym);
    talvezFecharTurno();
  }

  // Fronteira nova: posições do turno anterior que passaram do ciclo normal viram órfãs.
  function prepararFronteira() {
    const tu = estado.turno;
    if (!tu || tu.status !== 'ATIVO') return true;
    for (const sym of tu.abertas) {
      const a = localAlvos[sym];
      if (a && agora() - (a.openTime || 0) >= ORFA_IDADE_MS) marcarOrfa(sym, a, 'TURNO_EXCEDIDO');
    }
    talvezFecharTurno();
    if (tu.status === 'ATIVO') {
      console.warn(`[SCALP-TURNO] #${tu.numero} ainda aberto (${tu.abertas.join(',')}); fronteira pulada`);
      return false;
    }
    return true;
  }

  async function tick() {
    for (const n of SLOTS) { // fechamento manual/externo apagou o alvo: solta o slot
      const s = estado.slots[n];
      if (s.symbol && s.openTime && !localAlvos[s.symbol]) liberarSlot(s.symbol);
    }
    verificarOrfas();
    talvezFecharTurno();
    if (!estado.enabled) {
      if (feed.ativo() && !posicoesScalp().length) feed.parar();
      return;
    }
    if (!ehTestnet(baseOrdens)) { // trava testnet: desliga em memória, não avalia
      estado.enabled = false;
      console.error(`[SCALP-1M] ${MSG_NAO_TESTNET}`);
      return;
    }
    const tU = agora();
    const trocaPendente = !estado.universoTs || (estado.universoRetryTs > 0 ? tU >= estado.universoRetryTs
      : cicloDe(tU) - estado.universoCiclo >= ROTACAO_CICLOS);
    if (!atualizandoUniverso && trocaPendente) {
      atualizandoUniverso = atualizarUniverso().catch(() => null).finally(() => { atualizandoUniverso = null; });
    }
    if (!estado.simbolos.length) { // boot: ranking carrega antes de aceitar entradas
      if (atualizandoUniverso) await atualizandoUniverso;
      if (!estado.simbolos.length) return;
    }
    if (estado.rodando) return;
    const t = agora();
    const f = faseCiclo(t);
    estado.rodando = true;
    try {
      if (f.fase === 'ABERTO') { // 0:00-0:20: entradas na fronteira (uma vez por ciclo)
        if (f.inicio <= estado.ultimaFronteira) return;
        const temPlano = estado.plano && estado.plano.fronteira === f.inicio;
        if (!temPlano && f.dentroMs < ESPERA_FECHAMENTO_MS) return; // sem plano: espera o REST trazer o candle fechado
        if (f.dentroMs < 4000 && estado.turno?.status === 'ATIVO' && estado.turno.abertas.some(sy => localAlvos[sy])) return; // saída do turno anterior ainda fechando: tenta no próximo tick
        estado.ultimaFronteira = f.inicio;
        if (f.dentroMs > JANELA_MAX_MS) { estado.plano = null; return; }
        if (!prepararFronteira()) { estado.plano = null; return; }
        await executarTurno(f.inicio);
      } else if (f.fase === 'ANALISE') { // 0:20-1:40: ranking das 20 a cada 10 s
        if (t - estado.ultimaAnalise < ANALISE_INTERVALO_MS) return;
        estado.ultimaAnalise = t;
        await analisar();
      } else if (!estado.plano || estado.plano.fronteira !== f.inicio + TURNO_MS) { // 1:40: ranking final e plano (sem IA)
        await confirmar(f.inicio + TURNO_MS);
      } else if (!estado.plano.jevFeito && f.dentroMs >= TURNO_MS - JEV_ANTECEDENCIA_MS) { // 1:57: dados frescos + Jev decidem
        await decidirJev(estado.plano);
      }
    } catch (e) { console.error('[SCALP-1M] ciclo:', e.message); } finally { estado.rodando = false; }
  }

  // Klines REST mainnet com cache até o próximo candle do tf fechar (poupa peso do rate limit).
  const TF_MS = { '1m': 60000, '5m': 300000, '15m': 900000 };
  async function klinesCache(sym, tf, limite) {
    const periodo = Math.floor((agora() - ESPERA_FECHAMENTO_MS) / TF_MS[tf]);
    const ch = `${sym}|${tf}`;
    const c = cacheK.get(ch);
    if (c && c.periodo === periodo && c.limite >= limite) return c.ks;
    const ks = await viaPeso(pesoKlines(limite), () => rest.klines(sym, tf, limite));
    if (Array.isArray(ks) && ks.length) cacheK.set(ch, { periodo, limite, ks });
    return ks;
  }

  // Campo inválido (mesmo após o fallback REST): QUAL campo, QUAL moeda e há quanto tempo o WS está mudo.
  function detalharInvalido(c, snap) {
    if (c.bloqueio !== 'CAMPO_INVALIDO' && c.bloqueio !== 'DADOS_ATRASADOS') return;
    const campos = c.bloqueio === 'CAMPO_INVALIDO' ? camposInvalidos(c.dados) : ['timestamp_dados_ms'];
    const mudo = Number.isFinite(snap?.wsMudoMs) ? snap.wsMudoMs : null;
    c.campos_invalidos = campos;
    c.ws_mudo_ms = mudo;
    c.bloqueio_detalhe = `${c.bloqueio}: ${campos.join(',') || '-'}${c.erro ? ` | REST: ${c.erro}` : ''} | WS mudo ${mudo === null ? 'sem socket' : (mudo / 1000).toFixed(1) + 's'}`;
    const t = agora();
    if (t - (logCampo.get(c.simbolo) || 0) < LOG_CAMPO_MS) return;
    logCampo.set(c.simbolo, t);
    console.warn(`[SCALP-DADOS] ${c.simbolo} ${c.bloqueio_detalhe}`);
  }

  // Dados das moedas do universo (klines REST + snapshot WS; REST do feed só quando falta), concorrência controlada.
  async function coletarCandidatas() {
    const t0 = agora();
    const lim1m = Math.min(1500, Math.max(40, Math.floor((t0 - inicioDiaUtc(t0)) / 60000) + 5));
    const volUni = new Map(estado.universo.map(u => [u.simbolo, u.volume_24h]));
    return emLotes(estado.simbolos.slice(), CONCORRENCIA_REST, async (sym) => {
      let r;
      try {
        const [k1m, k5m, k15m] = await Promise.all([klinesCache(sym, '1m', lim1m), klinesCache(sym, '5m', 60), klinesCache(sym, '15m', 60)]);
        r = { sym, k1m, k5m, k15m };
      } catch (e) { r = { sym, erro: e.message }; }
      let snap = null;
      try { snap = typeof feed.garantir === 'function' ? await feed.garantir(sym) : feed.snapshot(sym); } catch (e) { snap = feed.snapshot(sym); }
      if (snap) snap = await refrescarSeVelho(sym, snap); // WS sem tick recente: fallback REST antes de zerar o score
      const tAgora = agora();
      const { dados, extra } = r.erro
        ? { dados: { simbolo: sym, timestamp_agora_ms: tAgora }, extra: {} }
        : montarDados(sym, { ...r, snap, agora: tAgora });
      const c = { ...avaliarCandidata(sym, dados, extra), erro: r.erro || null, volume_24h: volUni.get(sym) ?? null };
      detalharInvalido(c, snap);
      return c;
    });
  }

  // ANÁLISE: ranking das 20 da lista (score normalizado + direção provável, desempate por volume); vão ao status().
  async function analisar() {
    const rank = rankearCandidatas(await coletarCandidatas());
    const atrUni = new Map(estado.universo.map(u => [u.simbolo, u.atr_pct]));
    estado.ranking = rank.slice(0, RANKING_TOP).map(c => ({
      simbolo: c.simbolo, volume_24h: c.volume_24h ?? null, score: c.score, direcao: c.direcao, condicoes_ok: c.condicoes_ok,
      bloqueio: c.bloqueio, bloqueio_detalhe: c.bloqueio_detalhe || null, passou_gate_antigo: c.passou_gate_antigo,
      atr: Number.isFinite(c.dados?.atr_1m_pct) ? c.dados.atr_1m_pct : (atrUni.get(c.simbolo) ?? null)
    }));
    estado.rankingTs = agora();
    return rank;
  }

  // Moedas que o feed nunca pode largar: posição/alvo scalp, slot ocupado, entrada em curso.
  function simbolosPresos() {
    const p = new Set(posicoesScalp());
    for (const n of SLOTS) if (estado.slots[n].symbol) p.add(estado.slots[n].symbol);
    for (const sym of entrando) p.add(sym);
    return p;
  }

  // LISTA DE 20 (a cada 6 ciclos): exchangeInfo + ticker 24h + bookTicker (mainnet), filtros do testnet, ATR 1m em lotes,
  // rodízio por montarLista20 (novas > repetidas > ATR mais próximo). Assina as novas no WS e aquece via REST;
  // desassina as que saíram sem posição.
  async function atualizarUniverso() {
    try {
      if (typeof fut.simbolos === 'function' && !fut.simbolos().length && typeof fut.carregarExchangeInfo === 'function') {
        await fut.carregarExchangeInfo(); // testnet: só leitura
      }
      const [info, tickers, books] = await Promise.all([
        viaPeso(1, () => rest.exchangeInfo()), viaPeso(40, () => rest.ticker24h()), viaPeso(5, () => rest.bookTicker())
      ]);
      const { lista, descartes } = filtrarUniverso({ info, tickers, books, filtroTestnet, agora: agora(), whitelist: deps.whitelist === undefined ? WHITELIST : deps.whitelist });
      const comAtr = await emLotes(lista, CONCORRENCIA_REST, async (c) => {
        try {
          const ks = await viaPeso(pesoKlines(40), () => rest.klines(c.simbolo, '1m', 40));
          return { ...c, atr_pct: atrPct(fechadas(ks, agora()).slice(-30)) };
        } catch (e) { return { ...c, atr_pct: null, erro: e.message }; }
      });
      const anterior = estado.simbolos.slice();
      const top = montarLista20(comAtr, anterior);
      for (const c of comAtr) { // fora da faixa não elimina (a lista sempre completa 20); só conta para o log
        const m = corteAtr(c.atr_pct);
        if (m) descartes[m] = (descartes[m] || 0) + 1;
      }
      const cortes = Object.entries(descartes).map(([m, n]) => `${m}=${n}`).join(' ') || '--';
      if (!top.length) {
        console.warn(`[SCALP-RANKING] ALERTA: nenhuma moeda passou nos filtros (${lista.length} candidatas; cortes: ${cortes}); mantém as ${estado.simbolos.length} atuais; nova tentativa em ${RANKING_RETRY_MS / 1000}s`);
        estado.universoRetryTs = agora() + RANKING_RETRY_MS;
        return null;
      }
      const novos = top.map(c => c.simbolo);
      const presos = simbolosPresos();
      const assinados = typeof feed.simbolos === 'function' ? feed.simbolos() : estado.simbolos;
      const sairam = assinados.filter(sym => !novos.includes(sym) && !presos.has(sym));
      const entraram = novos.filter(sym => !assinados.includes(sym));
      estado.simbolos = novos;
      estado.universo = top.map(c => ({ simbolo: c.simbolo, atr_pct: c.atr_pct, volume_24h: c.volume_24h, origem: c.origem }));
      estado.universoTs = agora();
      estado.universoCiclo = cicloDe(agora());
      estado.universoRetryTs = 0;
      for (const k of cacheK.keys()) if (!novos.includes(k.split('|')[0])) cacheK.delete(k);
      if (typeof feed.desassinar === 'function') feed.desassinar(sairam);
      if (typeof feed.assinar === 'function') feed.assinar(entraram.concat([...presos].filter(sym => !assinados.includes(sym) && !entraram.includes(sym))));
      if (top.length < RANKING_MAX) console.warn(`[SCALP-RANKING] ALERTA: só ${top.length}/${RANKING_MAX} moedas com ATR válido passaram nos filtros do universo`);
      const novasL = top.filter(c => c.origem === 'NOVA').map(c => c.simbolo);
      const repetidasL = top.filter(c => c.origem === 'REPETIDA').map(c => c.simbolo);
      const proximasL = top.filter(c => c.origem === 'ATR_PROXIMO').map(c => c.simbolo);
      const fmtV = (v) => (Number.isFinite(v) ? (v / 1e6).toFixed(0) + 'M' : '--');
      const marca = { NOVA: 'NOVA', REPETIDA: 'REPETIU', ATR_PROXIMO: 'NOVA(ATR fora da faixa)' };
      console.log(`[SCALP-RANKING] troca de lista: ${top.length} moedas | ${novasL.length + proximasL.length} novas, ${repetidasL.length} repetidas: ${top.map(c => `${c.simbolo} ${c.atr_pct.toFixed(3)}% ${fmtV(c.volume_24h)} ${marca[c.origem]}`).join(' | ')} | cortes: ${cortes}`);
      logar({ tipo: 'RANKING', ts: agora(), moedas: estado.universo, novas: novasL.concat(proximasL), repetidas: repetidasL, entraram, sairam, descartes, candidatas: lista.length });
      if (entraram.length && feed.ativo() && typeof feed.aquecer === 'function') { // warmup REST na hora
        await emLotes(entraram, CONCORRENCIA_REST, (sym) => feed.aquecer(sym).catch(() => false));
      }
      return top;
    } catch (e) {
      console.warn(`[SCALP-RANKING] falha ao atualizar (${e.message}); mantém ${estado.simbolos.length} moedas; nova tentativa em ${RANKING_RETRY_MS / 1000}s`);
      estado.universoRetryTs = agora() + RANKING_RETRY_MS;
      return null;
    }
  }

  // CONFIRMAÇÃO (4:30, ou na fronteira sem plano): ranking final e bloqueios duros, SEM chamada externa.
  // Gera o plano da fronteira (candidatas na ordem do ranking); o Jev decide compra/venda às 4:57 (decidirJev).
  async function confirmar(fronteira) {
    const rank = await analisar();
    const ts = agora();
    const regs = [];
    const elegiveis = [];
    for (const c of rank) {
      const d = c.dados;
      const reg = {
        tipo: 'DECISAO', ts, turno_id: null, candle: fronteira, simbolo: c.simbolo, dados: d, gate: c.gate,
        bloqueio_duro: c.bloqueio, passou_gate_antigo: c.passou_gate_antigo, direcao_codigo: c.direcao, votos: c.votos,
        condicoes_ok: c.condicoes_ok, score: { ...c.norm, total: c.score }, jev: null, direcao_jev: null,
        acao: 'NENHUMA', erro: c.erro || null,
        campos_invalidos: c.campos_invalidos || null, ws_mudo_ms: c.ws_mudo_ms ?? null, bloqueio_detalhe: c.bloqueio_detalhe || null
      };
      if (Number.isFinite(d?.atr_1m_pct) && d.atr_1m_pct < ATR_MIN_PCT) { // ATR_BAIXO: só informação (não bloqueia)
        const ab = estado.atrBaixo;
        ab.total++; ab.porSimbolo[c.simbolo] = (ab.porSimbolo[c.simbolo] || 0) + 1;
        reg.atr_baixo = { atr_1m_pct: d.atr_1m_pct, atr_min_pct: ATR_MIN_PCT, contagem_total: ab.total, contagem_simbolo: ab.porSimbolo[c.simbolo] };
      }
      // bloqueio duro (spread > 0,05%, dado > 3 s, campo inválido) pula a moeda: a próxima do ranking das 20 ocupa a vaga
      if (c.bloqueio) reg.acao = 'BLOQUEADA'; // Sniper: sem direção, ATR baixo, topo esticado ou score < 75 = não força entrada
      else if (foraNoCiclo(c.simbolo, cicloDe(fronteira))) reg.acao = 'FORA_1_CICLO';
      else if (ocupado(c.simbolo)) reg.acao = 'SIMBOLO_OCUPADO';
      else elegiveis.push(c);
      c.reg = reg;
      regs.push(reg);
    }
    // Elegíveis = score Sniper >= 75 (já na ordem do score). Nenhuma = turno vazio, sem queimar taxa.
    const ordem = elegiveis.slice();
    ordem.forEach(c => { c.reg.acao = 'NAO_ESCOLHIDA'; });
    const foras = regs.filter(r => r.acao === 'FORA_1_CICLO');
    const motivoVazio = ordem.length ? null
      : (!foras.length ? 'SEM_CONFLUENCIA_SNIPER' : foras.length === regs.length ? 'FORA_1_CICLO_TODAS' : 'FORA_1_CICLO_E_BLOQUEIOS');
    if (motivoVazio === 'SEM_CONFLUENCIA_SNIPER') console.log(`[SCALP-ALERTA] nenhuma das ${regs.length} moedas com dados válidos: turno vazio (${regs.map(r => `${r.simbolo} ${r.bloqueio_detalhe || r.bloqueio_duro || r.acao}`).join(' ; ') || 'sem detalhe'})`); // motivo de cada uma
    const foraPlano = foras.map(r => ({ simbolo: r.simbolo }));
    if (foras.length) console.log(`[SCALP-FORA] puladas neste ciclo: ${foraPlano.map(g => g.simbolo).join(', ')}`);
    estado.plano = { fronteira, ts, regs, ordem, fora: foraPlano, motivoVazio, jevFeito: false };
    console.log(`[SCALP-CONFIRMACAO] fronteira ${new Date(fronteira).toISOString()} | ordem: ${ordem.map(c => `${c.simbolo} ${c.direcao}`).join(', ') || '--'}${motivoVazio ? ` | ${motivoVazio}` : ''}`);
    return estado.plano;
  }

  // Na entrada (plano feito antes): feed do símbolo segue fresco (<= 3 s) e com spread <= 0,03%?
  function rechecarFeed(sym) {
    const snap = feed.ativo() ? feed.snapshot(sym) : null;
    const ts = tsFrescor(snap, agora());
    if (!ts || agora() - ts > ATRASO_MAX_MS) return 'DADOS_ATRASADOS_ENTRADA';
    const bid = num(snap.book?.bids?.[0]?.[0]), ask = num(snap.book?.asks?.[0]?.[0]);
    if (!(bid > 0 && ask > 0) || ((ask - bid) / ((ask + bid) / 2)) * 100 > SPREAD_MAX_PCT) return 'SPREAD_ALTO_ENTRADA';
    return null;
  }

  // Dados ATUAIS da moeda (klines em cache + snapshot do feed) para a decisão do Jev.
  // Dado velho (ts > 3 s ou ausente) com feed ativo: REST (aggTrades + depth) na hora, no máx 1 vez por moeda a cada 15 s.
  const ultimoRefresco = new Map();
  async function refrescarSeVelho(sym, snap) {
    const t = agora();
    const ts = tsFrescor(snap, t);
    if (ts && t - ts <= ATRASO_MAX_MS) return snap;
    if (typeof feed.aquecer !== 'function' || t - (ultimoRefresco.get(sym) || 0) < 15000) return snap;
    ultimoRefresco.set(sym, t);
    try { await feed.aquecer(sym); } catch (e) { return snap; }
    return feed.snapshot(sym) || snap;
  }

  async function dadosFrescos(sym) {
    const t0 = agora();
    const lim1m = Math.min(1500, Math.max(40, Math.floor((t0 - inicioDiaUtc(t0)) / 60000) + 5));
    const [k1m, k5m, k15m] = await Promise.all([klinesCache(sym, '1m', lim1m), klinesCache(sym, '5m', 60), klinesCache(sym, '15m', 60)]);
    const snap = feed.ativo() ? await refrescarSeVelho(sym, feed.snapshot(sym)) : null;
    return { ...montarDados(sym, { k1m, k5m, k15m, snap, agora: agora() }), k1m };
  }

  // Candles 5m do BTC (regime do mercado), 1 consulta por período de 5 min compartilhada entre as candidatas em paralelo.
  let btcCache = { periodo: null, p: null };
  function regimeBtc() {
    const periodo = Math.floor((agora() - ESPERA_FECHAMENTO_MS) / TF_MS['5m']);
    if (btcCache.periodo === periodo && btcCache.p) return btcCache.p;
    btcCache = { periodo, p: klinesCache('BTCUSDT', '5m', 20).catch(() => null) };
    return btcCache.p;
  }

  // Spread do book da testnet em % ((ask - bid) / bid); book vazio/erro = Infinity (bloqueia).
  async function spreadTestnetPct(sym) {
    try {
      const b = await fut.livroOfertas(sym, 5);
      const bid = num(b?.bids?.[0]?.[0]), ask = num(b?.asks?.[0]?.[0]);
      return bid > 0 && ask >= bid ? ((ask - bid) / bid) * 100 : Infinity;
    } catch (e) { return Infinity; }
  }

  // FASE 1 (sem IA): prepara os dados da candidata para o Jev: feed, dados frescos, voto do código, ATR mínimo e contexto.
  // null = pronta (c.preparada, c.dados, c.contexto); string = motivo para pular a moeda (problema nos dados).
  async function prepararDados(c, checarFeed) {
    if (c.preparada) return null;
    if (checarFeed) { let b = rechecarFeed(c.simbolo); if (b === 'DADOS_ATRASADOS_ENTRADA' && feed.ativo()) { await refrescarSeVelho(c.simbolo, feed.snapshot(c.simbolo)); b = rechecarFeed(c.simbolo); } if (b) return b; } // feed velho (> 3 s) ou spread > 0,05%: bloqueio duro, a próxima ocupa a vaga
    let f;
    try { f = await dadosFrescos(c.simbolo); } catch (e) { c.reg.recheca = { erro: e.message }; return 'DADO_INVALIDO_RECHECA'; }
    const inval = validarCampos(f.dados) || (f.dados.spread_pct > SPREAD_MAX_PCT ? 'SPREAD_ALTO' : null); // bloqueio duro com dados frescos
    if (inval) { c.reg.recheca = { bloqueio: inval, campos_invalidos: camposInvalidos(f.dados) }; return inval === 'SPREAD_ALTO' ? 'SPREAD_ALTO_RECHECA' : 'DADO_INVALIDO_RECHECA'; }
    const spT = await spreadTestnetPct(c.simbolo); // book da TESTNET (onde a ordem executa): spread > 0,08% = pula, a próxima ocupa a vaga
    c.reg.recheca = { ...(c.reg.recheca || {}), spread_testnet_pct: spT };
    if (!(spT <= SPREAD_TESTNET_MAX_PCT)) return 'SPREAD_TESTNET_ALTO';
    const v = votarDirecao(f.dados);
    const sn = avaliarSniper(f.dados); // dados frescos: o Sniper precisa seguir aprovado (>= 75), senão a moeda é pulada
    c.reg.recheca = { ...(c.reg.recheca || {}), direcao: sn.direcao, votos: v.votos, atr_1m_pct: f.dados.atr_1m_pct, sniper: { score: sn.score, bloqueio: sn.bloqueio, comp: sn.comp ?? null } };
    if (!sn.ok) return `SNIPER_${sn.bloqueio || 'REPROVADO'}_RECHECA`;
    v.direcao = sn.direcao;
    const cond = contarCondicoes(f.dados);
    const gate = avaliarGate(f.dados);
    c.dados = f.dados; c.extra = f.extra; c.gate = gate; c.votos = v.votos;
    c.direcao_codigo = v.direcao; c.direcao = v.direcao; c.sniper = sn; c.score = sn.score; // vale o código até o Jev decidir
    c.condicoes_ok = v.direcao === 'LONG' ? cond.long : cond.short;
    c.passou_gate_antigo = gate.ok === true && gate.direcao === v.direcao;
    const rb = await comPrazo(regimeBtc(), 800); // regime do mercado; lento ou falhou = sem esse campo
    const btc5m = rb === 'PRAZO_JEV' ? null : rb;
    const hist = { moeda: estado.recentes.filter(r => r.sym === c.simbolo).map(r => r.liq), bot: estado.recentes.slice(-20).map(r => r.liq) };
    c.contexto = contextoMercado({ k1m: f.k1m, dados: f.dados, btc5m, agora: agora(), hist });
    c.reg.direcao_codigo = v.direcao; c.reg.dados = f.dados;
    c.preparada = true;
    return null;
  }

  // FASE 2: o Jev decide compra (LONG) ou venda (SHORT) com os dados já preparados. Devolve null (pronta: c.direcao = decisão final)
  // ou o motivo de pular (JEV_WAIT / JEV_CONF_BAIXA). Falha, timeout ou sem chave = vale a direção do código.
  async function decidirComJev(c) {
    if (c.jev) return c.pulaJev ?? null;
    const j = await consultarJev(c.dados, c.direcao_codigo, { votos: c.votos, condicoes_ok: c.condicoes_ok, score: c.score, contexto: c.contexto },
      { apiKey: jevKey, url: jevUrl || JEV_URL_PADRAO, onUsage, post: deps.postJev, timeoutMs: jevTimeoutMs });
    c.jev = j;
    c.direcao = j.direcao || c.direcao_codigo;
    estado.jev.total++;
    if (j.direcao && j.direcao !== c.direcao_codigo) estado.jev.diverge++;
    if (!j.direcao && j.choice !== 'WAIT') estado.jev.falhas++; // WAIT é opinião do Jev, não falha
    c.reg.jev = { fonte: j.fonte, choice: j.choice, conf: j.conf, motivo: j.motivo, latenciaMs: j.latenciaMs };
    c.reg.direcao_jev = j.direcao;
    c.reg.jev_latencia_ms = j.latenciaMs; c.reg.jev_timeout = !!j.timeout;
    if (j.timeout) estado.jev.timeouts++;
    if (j.direcao) { estado.jev.comOpiniao++; if (j.direcao === c.direcao_codigo) estado.jev.concorda++; }
    if (Number.isFinite(j.latenciaMs)) estado.jev.latenciaSomaMs += j.latenciaMs;
    // Sniper: o Jev APROVA. WAIT, direção divergente do código ou confiança baixa = pula (não força entrada).
    // Sem opinião por falha técnica (sem chave, timeout, erro) = vale o código (o score >= 75 já passou).
    c.pulaJev = j.choice === 'WAIT' ? 'JEV_WAIT' : (j.direcao && j.direcao !== c.direcao_codigo ? 'JEV_DIVERGIU' : (j.direcao && j.conf < JEV_CONF_MIN ? 'JEV_CONF_BAIXA' : null));
    if (c.pulaJev) { estado.jev.pulou++; c.direcao = c.direcao_codigo; }
    console.log(`[SCALP-JEV] ${c.simbolo} código ${c.direcao_codigo} / ${j.direcao ? `Jev ${j.direcao} ${j.conf}%${c.pulaJev ? ` ${c.pulaJev}: pula` : ''}` : `${j.motivo}: ${c.pulaJev ? 'pula' : 'vale o código'}${j.timeout ? ' (jev_timeout)' : ''}`} | ${j.latenciaMs} ms`);
    return c.pulaJev;
  }

  // Prepara e decide uma candidata fora das preparadas às 4:57 (ou sem plano).
  async function prepararCandidata(c, checarFeed) {
    const r = await prepararDados(c, checarFeed);
    return r || decidirComJev(c);
  }

  // 4:57 (3 s antes da fronteira): PREPARA SEMPRE 3 moedas (2 titulares + 1 reserva na agulha) com dados frescos e contexto;
  // o Jev decide compra/venda só das 2 titulares. A reserva só é consultada se uma titular for recusada (dados com problema,
  // Jev WAIT ou confiança baixa). Prazo duro: tudo termina antes da fronteira. As escolhidas vão à frente da fila do 5:00.
  async function decidirJev(plano) {
    plano.jevFeito = true;
    const t0 = agora();
    const fila = plano.ordem.slice();
    const prazo = () => Math.max(100, plano.fronteira - agora() - 300);
    // Fase 1: dados de até 3 moedas válidas em paralelo; problema nos dados = próxima do plano ocupa o lugar
    const prontas = [];
    let idx = 0;
    while (prontas.length < MOEDAS_PREPARADAS && idx < fila.length && (idx === 0 || (agora() - t0 < jevTimeoutMs && agora() < plano.fronteira - 300))) {
      const lote = [];
      while (lote.length < MOEDAS_PREPARADAS - prontas.length && idx < fila.length) {
        const c = fila[idx++];
        if (ocupado(c.simbolo) || foraNoCiclo(c.simbolo, cicloDe(plano.fronteira))) continue; // o 5:00 registra o motivo
        lote.push(c);
      }
      const rs = await Promise.all(lote.map(c => {
        c.prep = prepararDados(c, true).catch(e => `ERRO_JEV: ${cortarMotivo(e.message)}`);
        return comPrazo(c.prep, prazo());
      }));
      lote.forEach((c, i) => {
        if (rs[i] === 'PRAZO_JEV') { prontas.push(c); console.warn(`[SCALP-JEV] ${c.simbolo}: dados passaram do prazo de 4:57; o 5:00 espera`); }
        else if (rs[i]) { c.reg.acao = rs[i]; c.pulada = true; }
        else prontas.push(c);
      });
    }
    // Fase 2: Jev nas titulares; recusa abre vaga para a próxima pronta (a reserva) — uma consulta por vaga
    const aConsultar = prontas.filter(c => c.preparada);
    const escolhidas = [];
    let cursor = 0;
    while (escolhidas.length < MAX_ENTRADAS_TURNO && cursor < aConsultar.length && agora() < plano.fronteira - 300) {
      const lote = aConsultar.slice(cursor, cursor + (MAX_ENTRADAS_TURNO - escolhidas.length));
      cursor += lote.length;
      const rs = await Promise.all(lote.map(c => {
        c.prepJev = decidirComJev(c).catch(e => `ERRO_JEV: ${cortarMotivo(e.message)}`);
        return comPrazo(c.prepJev, prazo());
      }));
      lote.forEach((c, i) => {
        if (rs[i] === 'PRAZO_JEV') { escolhidas.push(c); console.warn(`[SCALP-JEV] ${c.simbolo}: Jev passou do prazo de 4:57; o 5:00 espera a decisão`); }
        else if (rs[i]) { c.reg.acao = rs[i]; c.pulada = true; if (cursor < aConsultar.length) console.log(`[SCALP-JEV] ${c.simbolo} recusada (${rs[i]}): a reserva ${aConsultar[cursor].simbolo} é consultada`); }
        else escolhidas.push(c);
      });
    }
    plano.ordem = [...escolhidas, ...fila.filter(c => !escolhidas.includes(c) && !c.pulada)];
    const reserva = plano.ordem.slice(escolhidas.length).find(c => c.preparada && !c.jev);
    console.log(`[SCALP-JEV] 4:57 decisão feita em ${agora() - t0} ms | preparadas: ${prontas.map(c => c.simbolo).join(', ') || '--'} | escolhidas: ${escolhidas.map(c => `${c.simbolo} ${c.direcao}`).join(', ') || '--'}${reserva ? ` | reserva na agulha: ${reserva.simbolo}` : ''}`);
  }

  // 5:00 (fronteira): entra nas 2 primeiras do plano (moedas diferentes, slots livres). Sem plano: confirma agora.
  // Entrada falhou / recheca pulou: segue pelo plano inteiro (próxima elegível, Jev se ainda não decidiu, tenta entrar)
  // até 2 posições ou fim da lista. Cada candidata é avaliada no máx 1 vez (teto = tamanho do plano).
  async function executarTurno(fronteira) {
    let plano = estado.plano && estado.plano.fronteira === fronteira ? estado.plano : null;
    const planoAntigo = !!plano;
    if (!plano) plano = await confirmar(fronteira);
    estado.plano = null;
    const numero = ++estado.ultimoNumero; // sequência contínua: nunca volta a #1 após restart
    const tu = estado.turno = {
      id: new Date(fronteira).toISOString(), numero, fronteira, status: 'ENTRANDO',
      moedas: [], direcoes: {}, abertas: [], trades: [], fora: plano.fora
    };
    for (const r of plano.regs) r.turno_id = tu.id;
    const livres = slotsLivres();
    let motivoVazio = plano.motivoVazio;
    const tentadas = [], ents = [];
    if (!livres.length) {
      motivoVazio = 'SEM_SLOT_LIVRE';
      plano.ordem.forEach(c => { c.reg.acao = 'SEM_SLOT'; });
    } else {
      const meta = Math.min(MAX_ENTRADAS_TURNO, livres.length);
      const fila = plano.ordem;
      let idx = 0, ok = 0;
      while (ok < meta && idx < fila.length && tentadas.length < fila.length) {
        const livresAgora = slotsLivres();
        const vagas = Math.min(meta - ok, livresAgora.length);
        if (vagas <= 0) break;
        const lote = [];
        while (lote.length < vagas && idx < fila.length) { // bloqueio na entrada: pula para a próxima do ranking
          const c = fila[idx++];
          if (ocupado(c.simbolo) || tentadas.some(e => e.simbolo === c.simbolo)) { c.reg.acao = 'SIMBOLO_OCUPADO'; continue; }
          if (foraNoCiclo(c.simbolo, cicloDe(fronteira))) { c.reg.acao = 'FORA_1_CICLO'; continue; }
          if (c.jev || c.preparada) { // preparada às 4:57: só reconfere o feed na hora da entrada
            const b = rechecarFeed(c.simbolo);
            if (b) { c.reg.acao = b; continue; } // bloqueio duro na entrada: pula para a próxima do ranking
          }
          lote.push(c);
        }
        const semJev = lote.filter(c => !c.jev); // fora das escolhidas às 4:57 (ou sem plano): dados frescos + Jev agora
        if (semJev.length) {
          // reserva preparada às 4:57: só falta o Jev (dados já prontos); preparação em voo: espera e decide; sem nada: prepara agora
          const resolver = (c) => c.prepJev || (c.preparada ? decidirComJev(c) : (c.prep ? c.prep.then(r => r || decidirComJev(c)) : prepararCandidata(c, planoAntigo)));
          // prazo de 3,5 s depois da fronteira: dados/Jev travados não seguram o turno (a moeda é pulada)
          const rs = await Promise.all(semJev.map(c => comPrazo(resolver(c).catch(e => `ERRO_JEV: ${cortarMotivo(e.message)}`), JEV_TIMEOUT_MS + 1000)));
          semJev.forEach((c, i) => {
            if (rs[i] === 'PRAZO_JEV') { c.reg.acao = 'JEV_PRAZO'; c.pulada = true; }
            else if (rs[i]) { c.reg.acao = rs[i]; c.pulada = true; }
            else { const b = rechecarFeed(c.simbolo); if (b) { c.reg.acao = b; c.pulada = true; } } // o feed pode ter envelhecido durante a consulta
            
          });
        }
        const vai = lote.filter(c => !c.pulada);
        if (!vai.length) { if (idx >= fila.length) break; continue; }
        const slotsL = slotsLivres();
        const res = await Promise.all(vai.map((c, i) => entrar(c.simbolo, c.direcao, c.dados, c.extra, c.gate, {
          jev: c.jev || null, condicoes_ok: c.condicoes_ok, passou_gate_antigo: c.passou_gate_antigo,
          direcao_codigo: c.direcao_codigo ?? c.direcao, direcao_jev: c.jev?.direcao ?? null,
          jev_latencia_ms: c.jev?.latenciaMs ?? null, jev_timeout: c.jev ? !!c.jev.timeout : null
        }, slotsL[i], tu).catch(e => ({ ok: false, motivo: e.message }))));
        vai.forEach((c, i) => {
          const ent = res[i];
          tentadas.push(c); ents.push(ent);
          c.reg.acao = ent.ok ? 'ENTROU' : (ent.acao || 'ENTRADA_FALHOU');
          c.reg.motivo = ent.motivo || null;
          c.reg.entrada = ent.registro || null;
          if (ent.ok) ok++;
          else {
            console.warn(`[SCALP-ENTRADA] ${c.simbolo}: ${c.reg.acao} (${ent.motivo || '-'}); segue para a próxima do plano`);
            if (ent.motivo !== 'FECHAMENTO_EXTERNO_EM_CURSO' && !['SPREAD_TESTNET_ALTO', 'ENTRADA_SEM_FILL'].includes(c.reg.acao)) marcarFora(c.simbolo, c.reg.acao); // spread/sem fill/aborto não é prejuízo: a moeda repete no turno seguinte // erro técnico na entrada: fora do próximo ciclo
          }
          if (ent.preencheu && !tu.moedas.includes(c.simbolo)) { tu.moedas.push(c.simbolo); tu.direcoes[c.simbolo] = c.direcao; }
        });
      }
      if (!tentadas.length && !motivoVazio) {
        motivoVazio = 'SEM_CANDIDATA_VALIDA';
        console.warn(`[SCALP-ALERTA] nenhuma das ${plano.regs.length} moedas com dados válidos: turno vazio (${plano.regs.map(r => `${r.simbolo} ${r.bloqueio_detalhe || r.bloqueio_duro || r.acao}`).join(' ; ') || 'sem detalhe'})`); // motivo de cada uma
      }
    }
    const resumo = {};
    for (const reg of plano.regs) {
      resumo[reg.simbolo] = { direcao: reg.direcao_codigo, bloqueio: reg.bloqueio_duro, acao: reg.acao, score: reg.score ? reg.score.total : null, jev: reg.direcao_jev ?? null };
      logar(reg);
    }
    estado.ultimoCiclo = { candle: fronteira, turno_id: tu.id, numero, ts: agora(), resumo };
    if (tu.moedas.length) { tu.status = 'ATIVO'; talvezFecharTurno(); return; }
    if (!motivoVazio) motivoVazio = ents.map(e => e.acao || 'ENTRADA_FALHOU')[0] || 'SEM_ENTRADA';
    turnoVazio(tu, motivoVazio, {
      candidatas: plano.ordem.map(c => ({ simbolo: c.simbolo, direcao: c.direcao, score: c.score, acao: c.reg.acao })),
      bloqueios: Object.fromEntries(plano.regs.filter(r => r.bloqueio_duro || !['NAO_ESCOLHIDA', 'ENTROU'].includes(r.acao)).map(r => [r.simbolo, r.bloqueio_duro || r.acao])),
      fora: plano.fora
    });
  }

  // meta = { jev, condicoes_ok, passou_gate_antigo, direcao_codigo, direcao_jev } (vai para o alvo e para a linha TRADE).
  async function entrar(sym, dir, dados, extra, gate, meta, slotNum, tu) {
    const turnoId = tu?.id ?? null;
    const jev = meta?.jev || null;
    const slot = estado.slots[slotNum];
    slot.symbol = sym; slot.side = dir; slot.status = `[SCALP ENTRANDO] ${sym} ${dir}`; slot.openTime = null;
    const ladoOrd = dir === 'LONG' ? 'BUY' : 'SELL';
    let enviada = false, qtyEnviada = 0, alvoCriado = null, ref = null, preencheu = false, tentativasEntrada = 0;
    const slPct = SL_EMERG_PCT; // stop de segurança na corretora (0,60%); o SL curto de 0,44% (-2,20% ROI) é do monitor
    const soltar = (acao, motivo, mais = {}) => {
      estado.slots[slotNum] = slotVazio();
      return { ok: false, acao, motivo, ...mais };
    };
    const evLimite = (resultado, o) => logar({ tipo: 'EVENTO', evento: 'SCALP_ENTRADA_LIMITE', ts: agora(), turno_id: turnoId, simbolo: sym, lado: dir, resultado, ...o });
    entrando.add(sym); // fase ENTRANDO até o retorno (finally)
    try {
      if (dir !== 'LONG' && dir !== 'SHORT') throw new Error(`direção inválida: ${dir}`); // nunca vira SELL por engano
      if (!travaOk(sym, 'ENTRADA')) throw new Error(MSG_NAO_TESTNET); // trava antes de qualquer ordem
      const pos = await fut.posicao(sym);
      if (pos && pos.quantidade > 0) throw new Error('posição já existe');
      await fut.garantirAlavancagem(sym, ALAV, 'ISOLATED');
      const bookT = await fut.livroOfertas(sym, 5);
      ref = precoMaker(bookT, ladoOrd); // LONG = melhor bid; SHORT = melhor ask (post-only)
      if (!(ref > 0)) throw new Error('book testnet vazio');
      const refTaker = precoTaker(bookT, ladoOrd);
      const bidT = num(bookT?.bids?.[0]?.[0]), askT = num(bookT?.asks?.[0]?.[0]);
      const spreadT = bidT > 0 && askT >= bidT ? ((askT - bidT) / bidT) * 100 : Infinity;
      if (!(spreadT <= SPREAD_TESTNET_MAX_PCT)) { // trava final antes de qualquer ordem
        console.warn(`[SCALP-ENTRADA] ${sym}: spread testnet ${Number.isFinite(spreadT) ? spreadT.toFixed(3) + '%' : 'book vazio'} > ${SPREAD_TESTNET_MAX_PCT}%: entrada proibida`);
        return soltar('SPREAD_TESTNET_ALTO', 'SPREAD_TESTNET_ALTO');
      } // preço de referência da fuga (lado que seria pago a Market)
      const calc = fut.calcularQuantidade(sym, MARGEM, ref, ALAV);
      if (!calc.ok) throw new Error(`qty: ${calc.motivo}`);
      // GTX post-only no melhor preço; a cada 3 s sem fill completo: cancela e recoloca (só o restante) no melhor
      // bid/ask atual; 8 s no total sem fill = restante a Market SÓ se o preço segue no nível de entrada; se fugiu, ABORTA
      // (não persegue). GTX rejeitada/expirada = mesma regra do fallback.
      const minQty = num(fut.filtrosDe?.(sym)?.minQty) || 0;
      let motivoMarket = null, qL = 0, custoL = 0, cancelada = false, gtxRejeitada = false, precoLim = ref;
      const fimEntrada = agora() + ENTRADA_LIMITE_MS;
      const ordIds = [];
      while (true) {
        const restaL = +(calc.qty - qL).toFixed(8);
        if (!(restaL > 0) || restaL < minQty) break; // completa (ou resto abaixo do mínimo: não recoloca)
        if (agora() >= fimEntrada) { motivoMarket = qL > 0 ? 'PARCIAL_8S' : 'SEM_FILL_8S'; break; }
        if (tentativasEntrada > 0) { // reprecificação: melhor preço maker atual
          const p2 = precoMaker(await fut.livroOfertas(sym, 5).catch(() => null), ladoOrd);
          if (!(p2 > 0)) { motivoMarket = qL > 0 ? 'PARCIAL_SEM_BOOK' : 'SEM_BOOK_REPRECO'; break; }
          precoLim = p2;
        }
        if (!travaOk(sym, 'ENTRADA_GTX')) throw new Error(MSG_NAO_TESTNET);
        tentativasEntrada++;
        let ord = null;
        try {
          ord = await fut.colocarLimite(sym, ladoOrd, restaL, precoLim, { timeInForce: 'GTX' });
        } catch (eG) {
          if (codigoErro(eG) !== COD_GTX_REJEITADA) {
            enviada = true; qtyEnviada = calc.qty; // envio incerto: o caminho de erro confere a posição e cancela ordens
            throw new Error(`GTX_ERRO: ${eG.message}`);
          }
          gtxRejeitada = true; motivoMarket = 'GTX_REJEITADA'; break;
        }
        enviada = true; qtyEnviada = calc.qty;
        if (ord?.status === 'EXPIRED' && !(num(ord.executedQty) > 0)) { // GTX que cruzaria o livro expira na hora
          gtxRejeitada = true; motivoMarket = 'GTX_REJEITADA'; break;
        }
        ordIds.push(ord?.orderId ?? null);
        // Consulta a cada 500 ms até 3 s (ou até o fim dos 12 s).
        let st = ord;
        const fimTent = Math.min(agora() + ENTRADA_REPRECO_MS, fimEntrada);
        while (!ESTADOS_FINAIS.includes(st?.status) && agora() < fimTent) {
          await dormir(POLL_MS);
          st = await fut.consultarOrdem(sym, ord.orderId).catch(() => st);
        }
        if (st?.status !== 'FILLED') {
          if (!travaOk(sym, 'ENTRADA_CANCEL')) throw new Error(MSG_NAO_TESTNET);
          await fut.cancelarOrdem(sym, ord.orderId).catch(e => {
            if (codigoErro(e) !== COD_ORDEM_DESCONHECIDA) console.error(`[SCALP-ENTRADA] ${sym}: cancelamento da limite falhou (${e.message})`);
          });
          cancelada = true;
          st = await fut.consultarOrdem(sym, ord.orderId).catch(() => null); // consulta final
          if (!st) throw new Error('consulta final da limite falhou: fill desconhecido');
          if (!ESTADOS_FINAIS.includes(st.status)) throw new Error(`limite segue no livro após cancelamento (${st.status})`);
        }
        const q = Math.min(num(st.executedQty) || 0, restaL); // nunca acima do pedido desta ordem
        if (q > 0) { qL = +(qL + q).toFixed(8); custoL += q * (num(st.avgPrice) > 0 ? num(st.avgPrice) : precoLim); preencheu = true; }
        if (st.status === 'FILLED') break;
      }
      const pL = qL > 0 ? custoL / qL : ref;
      if (tentativasEntrada > 0 || gtxRejeitada) {
        const resultado = gtxRejeitada && !(qL > 0) ? 'GTX_REJEITADA' : (qL >= calc.qty ? 'PREENCHIDA' : (qL > 0 ? 'PARCIAL' : 'CANCELADA'));
        evLimite(resultado, { qty_pedida: calc.qty, qty_executada: qL, preco: qL > 0 ? pL : precoLim, order_id: ordIds[ordIds.length - 1] ?? null, order_ids: ordIds, tentativas: tentativasEntrada, cancelada });
      }
      if (!motivoMarket && qL < calc.qty) motivoMarket = 'PARCIAL_8S'; // resto abaixo do mínimo: o bloco abaixo não envia
      const resto = +(calc.qty - qL).toFixed(8);
      let qM = 0, pM = null, abortadaFuga = null;
      if (motivoMarket && resto > 0 && resto >= minQty) {
        // Fuga do preço desde a decisão: > 0,03% = não entra a Market (fuga > 0,15% é o aborto declarado; entre os dois, também não persegue).
        const bkF = await fut.livroOfertas(sym, 5).catch(() => null);
        const pAgora = precoTaker(bkF, ladoOrd);
        const fuga = pAgora > 0 && refTaker > 0 ? ((dir === 'LONG' ? pAgora - refTaker : refTaker - pAgora) / refTaker) * 100 : Infinity;
        if (!(fuga <= ENTRADA_FUGA_MARKET_PCT)) {
          abortadaFuga = fuga;
          console.warn(`[SCALP-ENTRADA] ${sym}: sem fill em ${ENTRADA_LIMITE_MS / 1000}s e preço fugiu ${Number.isFinite(fuga) ? fuga.toFixed(3) + '%' : 'n/d'}${fuga > ENTRADA_FUGA_ABORTA_PCT ? ' (> 0,15%)' : ''}: entrada abortada, sem Market`);
          logar({ tipo: 'EVENTO', evento: 'SCALP_ENTRADA_ABORTADA', ts: agora(), turno_id: turnoId, simbolo: sym, lado: dir, motivo: motivoMarket, fuga_pct: Number.isFinite(fuga) ? fuga : null, qty_limite: qL });
        }
      }
      if (motivoMarket && !abortadaFuga && resto > 0 && resto >= minQty) {
        if (!travaOk(sym, 'ENTRADA_MARKET')) throw new Error(MSG_NAO_TESTNET);
        enviada = true; qtyEnviada = calc.qty;
        const ordM = await fut.abrirMercado(sym, ladoOrd, resto);
        qM = num(ordM?.executedQty) > 0 ? num(ordM.executedQty) : resto;
        pM = num(ordM?.avgPrice) > 0 ? num(ordM.avgPrice) : null;
        if (!(pM > 0)) pM = num((await fut.tickerPreco(sym).catch(() => null))?.price) || ref;
        preencheu = true;
        logar({ tipo: 'EVENTO', evento: 'SCALP_ENTRADA_MARKET', ts: agora(), turno_id: turnoId, simbolo: sym, lado: dir, motivo: motivoMarket, qty: qM, preco: pM, qty_limite: qL });
      }
      const qty = +(qL + qM).toFixed(8);
      if (!(qty > 0)) { // nada entrou (resto abaixo do mínimo): slot LIVRE
        return soltar('ENTRADA_SEM_FILL', abortadaFuga !== null ? 'ENTRADA_ABORTADA_FUGA' : `ENTRADA_SEM_FILL_${motivoMarket || 'LIMITE'}`);
      }
      qtyEnviada = qty;
      const preco = (qL * pL + qM * pM) / qty;
      const taxaEntradaPct = (qL * TAXA_MAKER_PCT + qM * TAXA_TAKER_PCT) / qty;
      const entradaTipo = qM > 0 ? (qL > 0 ? 'MISTA' : 'MARKET') : 'LIMITE';
      const parcial = qty < calc.qty;
      if (qty < minQty) { // parcial abaixo do mínimo: zera a Market reduceOnly
        if (!travaOk(sym, 'PARCIAL_MINQTY')) throw new Error(MSG_NAO_TESTNET);
        closingInProgress.add(sym);
        let ordZ;
        try { ordZ = await fut.fecharMercado(sym, dir, qty); } finally { closingInProgress.delete(sym); }
        console.warn(`[SCALP-ENTRADA] ${sym}: fill parcial ${qty} < minQty ${minQty}; zerado a Market`);
        logar({ tipo: 'EVENTO', evento: 'SCALP_PARCIAL_ZERADA', ts: agora(), turno_id: turnoId, simbolo: sym, lado: dir, qty, min_qty: minQty, entrada: preco, saida: num(ordZ?.avgPrice) || null });
        return soltar('PARCIAL_ABAIXO_MINQTY', 'PARCIAL_ABAIXO_MINQTY', { preencheu: true });
      }
      const slPrice = preco * (1 + (dir === 'LONG' ? -1 : 1) * slPct / 100);
      const snapM = feed.ativo() ? feed.snapshot(sym) : null;
      const bookM = snapM?.book || extra.book;
      const registro = qM > 0 ? { // perna Market: preço taker + slippage do book mainnet
        tipo: entradaTipo,
        precoMainnet: precoTaker(bookM, ladoOrd) || dados.preco,
        slipMainnetPct: slippageEstimadoPct(bookM, ladoOrd, MARGEM * ALAV) || 0,
        precoTestnet: preco
      } : {
        tipo: 'LIMITE',
        precoMainnet: precoMaker(snapM?.book, ladoOrd) || precoMaker(extra.book, ladoOrd) || dados.preco, // maker no mainnet
        slipMainnetPct: 0,
        precoTestnet: preco
      };
      // fechando=true até o stop sair: o monitor não fecha em paralelo durante as tentativas de SL.
      alvoCriado = localAlvos[sym] = {
        modo: 'scalp_1m', side: dir, entryPrice: preco, slPrice, slCurtoPrice: preco * (1 + (dir === 'LONG' ? -1 : 1) * SL_CURTO_PCT / 100), stDirEntrada: dados?.st1m_dir ?? null, leverage: ALAV, quantidade: qty,
        openTime: agora(), slot: slotNum, candle: tu?.fronteira ?? null, turnoId, fechando: true, fechandoDesde: agora(),
        maxRoiReached: 0, minRoiReached: 0, sarLabel: '[SCALP 1m]', slNaCorretora: false,
        entradaTipo, taxaEntradaPct, entradaTentativas: tentativasEntrada, stop_pct: slPct, stop_preco: slPrice,
        entrada: registro, dadosEntrada: dados,
        gate: { direcao: gate.direcao, condicoes_ok: gate.condicoes_ok },
        jev,
        decisao: {
          condicoes_ok: meta?.condicoes_ok ?? null, passou_gate_antigo: meta?.passou_gate_antigo ?? null,
          direcao_codigo: meta?.direcao_codigo ?? dir, direcao_jev: meta?.direcao_jev ?? null,
          jev_latencia_ms: meta?.jev_latencia_ms ?? null, jev_timeout: meta?.jev_timeout ?? null
        }
      };
      salvarAlvos();
      if (tu && !tu.abertas.includes(sym)) tu.abertas.push(sym);
      slot.openTime = agora();
      slot.status = `[SCALP ATIVO] ${sym} ${dir} ${ALAV}x`;
      const alvoVigente = () => localAlvos[sym] === alvoCriado && !closingInProgress.has(sym);
      for (let t = 1; t <= 3; t++) {
        if (!alvoVigente() || !travaOk(sym, 'SL_EMERG')) break; // /api/close assumiu: não cria stop órfão
        try {
          await fut.colocarStopLoss(sym, dir, slPrice);
          if (alvoVigente()) { alvoCriado.slNaCorretora = true; break; }
          console.error(`[SCALP-SL-ORFAO] ${sym}: alvo fechado durante o envio do stop; cancelando ordens`);
          if (!travaOk(sym, 'SL_ORFAO_CANCEL') || !(await fut.cancelarTodasOrdens(sym, { estrito: true }).catch(() => false))) { // false = stop segue na corretora
            console.error(`[SCALP-CANCEL] ${sym}: cancelamento falhou; stop pode seguir na corretora; nova tentativa no próximo ciclo`);
            if (localAlvos[sym] === alvoCriado) alvoCriado.slNaCorretora = true;
            else cancelSemAlvo.set(sym, cancelSemAlvo.get(sym) || 0); // sem alvo: o monitor retenta com o símbolo livre
          }
          break;
        } catch (e) { console.error(`[SCALP-SL-EMERG] ${sym} tentativa ${t}/3: ${e.message}`); }
      }
      const alvo = localAlvos[sym];
      if (alvo !== alvoCriado || closingInProgress.has(sym)) { // fechamento externo (/api/close) assumiu
        if (alvo === alvoCriado) alvo.fechando = false;
        return { ok: false, motivo: 'FECHAMENTO_EXTERNO_EM_CURSO', registro, preencheu };
      }
      if (!alvo.slNaCorretora) {
        // 3 falhas no stop: posição sem proteção na corretora -> fecha a Market já.
        console.error(`[SCALP-SL-FALHOU] ${sym}: stop recusado 3x; fechando a Market`);
        alvo.fechando = true; alvo.fechandoDesde = agora();
        if (!travaOk(sym, 'SL_FALHOU')) { alvo.fechando = false; return { ok: false, motivo: 'SL_FALHOU_SEM_TESTNET', registro, preencheu }; }
        closingInProgress.add(sym);
        try {
          const m = lerMainnetSaida(sym, dir);
          const preCancel = await cancelarAntesDaMarket(sym);
          const ordF = await fut.fecharMercado(sym, dir, qty);
          const finSl = ['SCALP_SL_FALHOU', num(ordF?.avgPrice) > 0 ? num(ordF.avgPrice) : null, m.preco, m.slip, { tipo: 'MARKET', taxaPct: TAXA_TAKER_PCT }];
          if (!preCancel && !(await cancelarAntesDaMarket(sym))) marcarCancelPendente(sym, alvo, { fin: finSl }); // alvo mantido
          else finalizar(sym, alvo, ...finSl);
        } catch (e) {
          console.error(`[SCALP-SL-FALHOU] ${sym}: fechamento a Market falhou (${e.message}); o monitor tenta de novo`);
        } finally {
          if (localAlvos[sym]) localAlvos[sym].fechando = false;
          closingInProgress.delete(sym);
        }
        return { ok: false, motivo: 'SL_FALHOU_3X_FECHADA_MARKET', registro, preencheu };
      }
      alvo.fechando = false; alvo.fechandoDesde = 0; // stop na corretora: monitor assume
      console.log(`[SCALP-ENTRADA] Turno ${tu?.numero ?? '-'} slot ${slotNum} ${sym} ${dir} ${ALAV}x ${entradaTipo} | testnet ${preco} | mainnet ${registro.precoMainnet} | qty ${qty}${parcial ? ` (parcial de ${calc.qty})` : ''} | SL ${slPrice} (${slPct.toFixed(2)}%) | tentativas GTX ${tentativasEntrada}`);
      if (rag) try { // erro do RAG não fecha posição já protegida
        rag.salvarEntradaRAG({
          symbol: sym, side: dir, leverage: ALAV, mode: 'SCALP_1M', scoreTotal: meta?.condicoes_ok ?? gate.condicoes_ok,
          emaStatus: `5m ${dados.ema9_5m > dados.ema21_5m ? 'ALTA' : 'BAIXA'} / 15m ${dados.ema9_15m > dados.ema21_15m ? 'ALTA' : 'BAIXA'}`,
          sarStatus: '--', volRatio: dados.rvol, fundingRate: 0, bookRatio: dados.book_imbalance_10, fiboPos: '--',
          patterns: ['SCALP_1M'], aiThesis: jev?.motivo || `código ${dir}`, entryPrice: preco
        }).catch(() => {});
      } catch (eRag) { console.error(`[SCALP-RAG] ${sym}: ${eRag.message}`); }
      return { ok: true, registro, preencheu };
    } catch (e) {
      console.log(`[SCALP-ENTRADA-FALHOU] ${sym}: ${e.message}`);
      let fechada = null, cancelOk = true;
      // Erro depois do envio da limite: fecha a Market (com trava testnet) e grava SCALP_ENTRADA_FALHOU.
      if (enviada && !closingInProgress.has(sym) && travaOk(sym, 'ENTRADA_FALHOU')) {
        closingInProgress.add(sym);
        try {
          const preCancel = await cancelarAntesDaMarket(sym); // 1º cancela: limite pendente não preenche após o zeramento
          const p = await fut.posicao(sym).catch(() => null);
          const q = p && p.quantidade > 0 ? p.quantidade : qtyEnviada;
          await fut.fecharMercado(sym, dir, q);
          fechada = true;
          cancelOk = preCancel || await cancelarAntesDaMarket(sym); // false = limite/stop podem seguir no livro
        } catch (e2) {
          fechada = false;
          console.error(`[SCALP-ENTRADA-FALHOU] ${sym}: fechamento a Market falhou (${e2.message}); o monitor tenta de novo se houver alvo`);
        } finally {
          closingInProgress.delete(sym);
        }
      }
      let alvoMantido = null;
      if (alvoCriado && localAlvos[sym] === alvoCriado) {
        if (fechada && cancelOk) { delete localAlvos[sym]; salvarAlvos(); } else { alvoCriado.fechando = false; alvoMantido = alvoCriado; }
        if (fechada && !cancelOk) marcarCancelPendente(sym, alvoCriado, { semTrade: true });
      } else if (fechada && !cancelOk && !localAlvos[sym]) {
        // Sem alvo: alvo mínimo segura o slot até o cancelamento passar (limite pode seguir no livro).
        alvoMantido = localAlvos[sym] = {
          modo: 'scalp_1m', side: dir, entryPrice: null, slPrice: null, leverage: ALAV, quantidade: 0,
          openTime: agora(), slot: slotNum, candle: tu?.fronteira ?? null, turnoId, fechando: false, fechandoDesde: 0,
          maxRoiReached: 0, minRoiReached: 0, sarLabel: '[SCALP 1m]', slNaCorretora: false, entrada: null
        };
        slot.openTime = agora(); slot.status = `[SCALP CANCEL PENDENTE] ${sym} ${dir}`;
        marcarCancelPendente(sym, alvoMantido, { semTrade: true });
      }
      if (enviada) logar({ tipo: 'EVENTO', evento: 'SCALP_ENTRADA_FALHOU', ts: agora(), turno_id: turnoId, simbolo: sym, lado: dir, qty: qtyEnviada, erro: e.message, fechada_market: fechada, cancel_ok: fechada ? cancelOk : null });
      if (enviada && fechada === false && !alvoMantido && !localAlvos[sym]) {
        // Posição possivelmente aberta sem alvo: 1 tentativa de stop, alvo mínimo e slot ocupado até o monitor fechar.
        const slOrfa = ref > 0 ? ref * (1 + (dir === 'LONG' ? -1 : 1) * slPct / 100) : null;
        let slOk = false;
        if (slOrfa && !localAlvos[sym] && !closingInProgress.has(sym) && travaOk(sym, 'SL_ORFA')) {
          try { await fut.colocarStopLoss(sym, dir, slOrfa); slOk = true; } catch (e3) { console.error(`[SCALP-ORFA] ${sym}: stop recusado (${e3.message})`); }
        }
        if (!localAlvos[sym]) {
          alvoMantido = localAlvos[sym] = {
            modo: 'scalp_1m', side: dir, entryPrice: null, slPrice: slOrfa, stop_pct: slPct, stop_preco: slOrfa, leverage: ALAV, quantidade: qtyEnviada,
            openTime: agora() - HOLD_MS, slot: slotNum, candle: tu?.fronteira ?? null, turnoId, fechando: false, fechandoDesde: 0,
            orfa: true, orfaDesde: agora(),
            maxRoiReached: 0, minRoiReached: 0, sarLabel: '[SCALP 1m ÓRFÃ]', slNaCorretora: slOk, entrada: null
          };
          salvarAlvos();
          slot.openTime = agora(); slot.status = `[SCALP ÓRFÃ] ${sym} ${dir}`;
          console.error(`[SCALP-ORFA] ${sym} ${dir}: fechamento falhou após abrir; slot ${slotNum} ocupado, monitor tenta fechar a cada ciclo (stop ${slOk ? 'na corretora' : 'ausente'})`);
          logar({ tipo: 'EVENTO', evento: 'SCALP_ORFA', ts: agora(), turno_id: turnoId, simbolo: sym, lado: dir, qty: qtyEnviada, slot: slotNum, sl_preco: slOrfa, sl_na_corretora: slOk });
        }
      }
      if (!alvoMantido) estado.slots[slotNum] = slotVazio();
      return { ok: false, motivo: e.message, preencheu: preencheu || !!alvoMantido };
    } finally {
      entrando.delete(sym);
    }
  }

  function liberarSlot(sym) {
    const n = slotDe(sym);
    if (n) estado.slots[n] = slotVazio();
  }

  // Linha TRADE do JSONL. Saída ou entrada desconhecida = PnL nulo (sem PnL inventado).
  // saidaInfo: { tipo: 'LIMITE'|'MARKET'|null, taxaPct } da perna de saída.
  function registrarTrade(sym, alvo, motivo, saidaTestnet, saidaMainnet, slipSaidaPct, saidaInfo = { tipo: 'MARKET', taxaPct: TAXA_TAKER_PCT }) {
    const qty = alvo.quantidade;
    const te = Number.isFinite(alvo.taxaEntradaPct) ? alvo.taxaEntradaPct : TAXA_TAKER_PCT;
    const ts = Number.isFinite(saidaInfo?.taxaPct) ? saidaInfo.taxaPct : TAXA_TAKER_PCT;
    const pnlT = saidaTestnet > 0 && alvo.entryPrice > 0 && qty > 0
      ? calcularPnl({ lado: alvo.side, qty, entrada: alvo.entryPrice, saida: saidaTestnet, taxaEntradaPct: te, taxaSaidaPct: ts }) : null;
    const pnlM = (pnlT && alvo.entrada?.precoMainnet > 0 && saidaMainnet > 0)
      ? calcularPnl({ lado: alvo.side, qty, entrada: alvo.entrada.precoMainnet, saida: saidaMainnet, taxaEntradaPct: te, taxaSaidaPct: ts, slipEntradaPct: alvo.entrada.slipMainnetPct || 0, slipSaidaPct: slipSaidaPct || 0 })
      : null;
    const margem = (alvo.entryPrice * qty) / ALAV;
    const roi = pnlT && margem > 0 ? (pnlT.bruto / margem) * 100 : null;
    const usdt = (p, pct) => (p > 0 && qty > 0 ? p * qty * pct / 100 : null);
    const dc = alvo.decisao || {};
    const passou = typeof dc.passou_gate_antigo === 'boolean' ? dc.passou_gate_antigo : null;
    logar({
      tipo: 'TRADE', ts: agora(), turno_id: alvo.turnoId ?? null, simbolo: sym, lado: alvo.side, qty, saida_motivo: motivo,
      duracao_ms: agora() - alvo.openTime,
      entrada_tipo: alvo.entradaTipo || 'MARKET', saida_tipo: saidaInfo?.tipo ?? null,
      entrada_tentativas: Number.isFinite(alvo.entradaTentativas) ? alvo.entradaTentativas : null,
      stop_pct: num(alvo.stop_pct) > 0 ? num(alvo.stop_pct) : null,
      stop_preco: num(alvo.stop_preco) > 0 ? num(alvo.stop_preco) : (num(alvo.slPrice) > 0 ? num(alvo.slPrice) : null),
      taxas: { entrada_pct: te, saida_pct: ts, entrada_usdt: usdt(alvo.entryPrice, te), saida_usdt: usdt(saidaTestnet, ts) },
      entrada: { mainnet: alvo.entrada?.precoMainnet ?? null, testnet: alvo.entryPrice, slip_mainnet_pct: alvo.entrada?.slipMainnetPct ?? null },
      saida: { mainnet: saidaMainnet ?? null, testnet: saidaTestnet, slip_mainnet_pct: slipSaidaPct ?? null },
      pnl_testnet: pnlT, pnl_mainnet: pnlM, roi_testnet_pct: roi,
      gate: alvo.gate, jev: alvo.jev ?? null, dados_entrada: alvo.dadosEntrada,
      condicoes_ok: Number.isFinite(dc.condicoes_ok) ? dc.condicoes_ok : (alvo.gate?.condicoes_ok ?? null),
      passou_gate_antigo: passou, forcada: passou === null ? null : !passou,
      direcao_codigo: dc.direcao_codigo ?? null, direcao_jev: dc.direcao_jev ?? null,
      jev_latencia_ms: dc.jev_latencia_ms ?? null, jev_timeout: dc.jev_timeout ?? null
    });
    if (pnlT && Number.isFinite(pnlT.liquido)) { estado.recentes.push({ sym, liq: pnlT.liquido }); if (estado.recentes.length > 60) estado.recentes.shift(); }
    contabilizarTurno(sym, alvo, motivo, saidaInfo?.tipo ?? null, pnlT, pnlM);
    classificarFora(sym, motivo, pnlT);
    return { pnlT, pnlM, roi };
  }

  // saidaTestnet nulo = preço de saída desconhecido: PnL nulo e fora do placar (sem PnL inventado).
  function finalizar(sym, alvo, motivo, saidaTestnet, saidaMainnet, slipSaidaPct, saidaInfo) {
    delete localAlvos[sym];
    salvarAlvos();
    liberarSlot(sym);
    const { pnlT, pnlM, roi } = registrarTrade(sym, alvo, motivo, saidaTestnet, saidaMainnet, slipSaidaPct, saidaInfo);
    if (pnlT) {
      if (rag) rag.salvarSaidaRAG({ symbol: sym, exitPrice: saidaTestnet, exitReason: motivo, roiPct: roi, pnlUsdt: pnlT.bruto }).catch(() => {});
      alvo.pnlLiquidoReal = pnlT.liquido; // placar usa o líquido real (taxas de cada perna), não a taxa estimada do PSAR
      registrarDesfechoTrade(sym, motivo, roi, pnlT.bruto, alvo);
    } else {
      console.warn(`[SCALP-SAIDA] ${sym} ${motivo}: preço de saída desconhecido; fora do placar, PnL nulo`);
    }
    console.log(`[SCALP-SAIDA] ${sym} ${motivo} (${saidaInfo?.tipo || '--'}) | testnet líq ${pnlT ? '$' + pnlT.liquido.toFixed(4) : '--'} | mainnet líq ${pnlM ? '$' + pnlM.liquido.toFixed(4) : '--'}`);
  }

  // Fechamento fora do motor (/api/close, limpeza do boot): só a linha TRADE (Market); placar/RAG ficam com o painel.
  function registrarTradeExterno(sym, alvo, motivo, saidaTestnet) {
    if (!alvo) return null;
    liberarSlot(sym);
    const m = lerMainnetSaida(sym, alvo.side);
    return registrarTrade(sym, alvo, motivo, saidaTestnet > 0 ? saidaTestnet : null, m.preco, m.slip, { tipo: 'MARKET', taxaPct: TAXA_TAKER_PCT });
  }

  function lerMainnetSaida(sym, ladoPos) {
    const snap = feed.ativo() ? feed.snapshot(sym) : null;
    const ladoOrd = ladoPos === 'LONG' ? 'SELL' : 'BUY';
    return { preco: precoTaker(snap?.book, ladoOrd), slip: slippageEstimadoPct(snap?.book, ladoOrd, MARGEM * ALAV) };
  }

  function lerMainnetSaidaMaker(sym, ladoPos) {
    const snap = feed.ativo() ? feed.snapshot(sym) : null;
    return { preco: precoMaker(snap?.book, ladoPos === 'LONG' ? 'SELL' : 'BUY'), slip: 0 };
  }

  // Aos 50 s: limite GTX reduceOnly no melhor preço maker do lado de saída.
  async function colocarSaidaLimite(sym, alvo, pos) {
    if (!travaOk(sym, 'SAIDA_GTX')) return;
    const ladoOrd = pos.lado === 'LONG' ? 'SELL' : 'BUY';
    let preco;
    try { preco = precoMaker(await fut.livroOfertas(sym, 5), ladoOrd); } catch (e) { console.error(`[SCALP-SAIDA-LIMITE] ${sym}: book falhou (${e.message})`); return; }
    if (!(preco > 0) || alvo.fechando || closingInProgress.has(sym) || localAlvos[sym] !== alvo) return;
    try {
      const ord = await fut.colocarLimite(sym, ladoOrd, pos.quantidade, preco, { reduceOnly: true, timeInForce: 'GTX' });
      if (ord?.status === 'EXPIRED' && !(num(ord.executedQty) > 0)) {
        console.warn(`[SCALP-SAIDA-LIMITE] ${sym}: GTX expirou na saída; nova tentativa até 60 s`);
        falhaSaida(sym, alvo, 'GTX_EXPIROU');
        return;
      }
      alvo.saidaLimite = { orderId: ord?.orderId ?? null, preco, qty: pos.quantidade, ts: agora() };
      console.log(`[SCALP-SAIDA-LIMITE] ${sym} ${ladoOrd} ${pos.quantidade} @ ${preco} (GTX reduceOnly)`);
    } catch (e) {
      if (codigoErro(e) === COD_GTX_REJEITADA) console.warn(`[SCALP-SAIDA-LIMITE] ${sym}: GTX rejeitada na saída; nova tentativa até 60 s`);
      else console.error(`[SCALP-SAIDA-LIMITE] ${sym}: ${e.message}; o próximo tick confere a posição antes de qualquer desfecho`);
      falhaSaida(sym, alvo, codigoErro(e) === COD_GTX_REJEITADA ? 'GTX_REJEITADA' : e.message);
    }
  }

  // Cancela e consulta a limite de saída; a parte preenchida vira perna LIMITE do alvo.
  async function encerrarSaidaLimite(sym, alvo, jaPreenchida) {
    const sl = alvo.saidaLimite;
    if (!sl) return;
    if (!jaPreenchida) {
      if (!travaOk(sym, 'SAIDA_CANCEL')) throw new Error(MSG_NAO_TESTNET);
      await fut.cancelarOrdem(sym, sl.orderId).catch(e => {
        if (codigoErro(e) !== COD_ORDEM_DESCONHECIDA) console.error(`[SCALP-SAIDA-LIMITE] ${sym}: cancelamento falhou (${e.message})`);
      });
    }
    const st = await fut.consultarOrdem(sym, sl.orderId).catch(() => null);
    if (!st) throw new Error('consulta da limite de saída falhou');
    if (!ESTADOS_FINAIS.includes(st.status)) throw new Error(`limite de saída segue no livro (${st.status})`);
    const q = num(st.executedQty) || 0;
    alvo.saidaPernas = alvo.saidaPernas || [];
    if (q > 0) alvo.saidaPernas.push({ qty: q, preco: num(st.avgPrice) > 0 ? num(st.avgPrice) : sl.preco, tipo: 'LIMITE', taxaPct: TAXA_MAKER_PCT, mainnet: lerMainnetSaidaMaker(sym, alvo.side) });
    alvo.saidaLimite = null;
  }

  // Fim do turno da posição: 2 s antes da fronteira seguinte (candle + 120 s), para o slot estar livre na entrada do próximo turno.
  const fimTurnoTs = (a) => (a.candle > 0 ? a.candle + TURNO_MS : (a.openTime || agora()) + HOLD_MS) - FIM_ANTECIPA_MS;

  // Supertrend(10,3) atual do 1m (candles fechados, cache por minuto): 1 ALTA, -1 BAIXA, null = indisponível.
  async function supertrendAtual(sym) {
    try {
      const ks = fechadas(await klinesCache(sym, '1m', 100), agora());
      return supertrend(ks.slice(-100))?.dir ?? null;
    } catch (e) { return null; }
  }

  // [TP_SNIPER_2M] limite GTC reduceOnly em +0,32% de preço (+1,60% ROI a 5x) assim que a posição abre; taxa maker.
  async function colocarTp(sym, alvo, pos) {
    if (alvo.tp || alvo.tpFalhas >= 3 || alvo.saidaMotivo || !(alvo.entryPrice > 0) || !travaOk(sym, 'TP_SNIPER')) return;
    const ladoOrd = alvo.side === 'LONG' ? 'SELL' : 'BUY';
    const preco = alvo.entryPrice * (1 + (alvo.side === 'LONG' ? 1 : -1) * TP_PRICE_PCT / 100);
    try {
      const ord = await fut.colocarLimite(sym, ladoOrd, pos.quantidade, preco, { reduceOnly: true, timeInForce: 'GTC' });
      if (localAlvos[sym] !== alvo) return;
      alvo.tp = { orderId: ord?.orderId ?? null, preco, qty: pos.quantidade, ts: agora() };
      console.log(`[SCALP-TP] ${sym} ${ladoOrd} ${pos.quantidade} @ ${preco} (+${TP_PRICE_PCT}% = +${(TP_PRICE_PCT * ALAV).toFixed(2)}% ROI, reduceOnly GTC)`);
    } catch (e) {
      alvo.tpFalhas = (alvo.tpFalhas || 0) + 1;
      console.error(`[SCALP-TP] ${sym}: limite de TP falhou (${e.message}); tentativa ${alvo.tpFalhas}/3`);
    }
  }

  // Consulta o TP: 'FILLED' (cheio), 'ABERTA' ou 'SEM_TP'. Expirada/cancelada sem fill libera nova colocação.
  async function consultarTp(sym, alvo) {
    if (!alvo.tp) return 'SEM_TP';
    const st = await fut.consultarOrdem(sym, alvo.tp.orderId).catch(() => null);
    if (!st) return 'ABERTA';
    if (st.status === 'FILLED') return 'FILLED';
    if (ESTADOS_FINAIS.includes(st.status)) { if (num(st.executedQty) > 0) return 'FILLED'; alvo.tp = null; return 'SEM_TP'; }
    return 'ABERTA';
  }

  // Início de qualquer saída: cancela o TP (a parte já preenchida vira perna LIMITE). true = TP preencheu (posição já zerada/zerando).
  async function cancelarTp(sym, alvo) {
    if (!alvo.tp) return;
    await fut.cancelarOrdem(sym, alvo.tp.orderId).catch(e => { if (codigoErro(e) !== COD_ORDEM_DESCONHECIDA) console.error(`[SCALP-TP] ${sym}: cancelamento falhou (${e.message})`); });
    let st = await fut.consultarOrdem(sym, alvo.tp.orderId).catch(() => null);
    if (!st) st = await fut.consultarOrdem(sym, alvo.tp.orderId).catch(() => null); // 2ª tentativa: TP pode ter enchido durante o cancelamento
    const q = num(st?.executedQty) || 0;
    if (q > 0) {
      alvo.saidaPernas = alvo.saidaPernas || [];
      alvo.saidaPernas.push({ qty: q, preco: num(st.avgPrice) > 0 ? num(st.avgPrice) : alvo.tp.preco, tipo: 'LIMITE', taxaPct: TAXA_MAKER_PCT, mainnet: lerMainnetSaidaMaker(sym, alvo.side) });
    }
    alvo.tp = null;
  }

  // Chamado pelo monitor próprio do scalp (monitorarTodas), fora do loop PSAR.
  async function monitorarPosicao(sym, alvo) {
    if (!alvo || alvo.fechando || closingInProgress.has(sym)) return;
    if (alvo.abandonada && !alvo.cancelPendente) return; // abandonada: sem novas ordens de saída
    if (!travaOk(sym, 'monitor')) return; // trava testnet: nenhum fechamento/cancelamento
    if (alvo.cancelPendente) { await retentarCancelPendente(sym, alvo); return; } // posição já saiu; só falta cancelar
    // Outro caminho (/api/close, entrar) pode ter assumido durante um await.
    const assumido = () => alvo.fechando || closingInProgress.has(sym) || localAlvos[sym] !== alvo;
    let pos;
    try { pos = await fut.posicao(sym); } catch (e) {
      console.error(`[SCALP-POSICAO] ${sym}: ${e.message}`);
      if (agora() < fimTurnoTs(alvo) + 10000) return;
      pos = { lado: alvo.side, quantidade: alvo.quantidade, precoMarca: null }; // passou do fim do turno + 10 s: fecha mesmo assim (reduceOnly)
    }
    if (assumido()) return;
    if (!pos || pos.quantidade === 0) {
      if (alvo.saidaLimite) { // a limite de saída pode ter zerado a posição: consulta a ordem antes do DESCONHECIDO
        const st = await fut.consultarOrdem(sym, alvo.saidaLimite.orderId).catch(() => null);
        if (assumido()) return;
        if (st?.status === 'FILLED' && num(st.executedQty) > 0) {
          await executarSaida(sym, alvo, { lado: alvo.side, quantidade: alvo.quantidade }, alvo.saidaMotivo || 'SCALP_FIM_TURNO_2M', null, true);
          return;
        }
      }
      if (alvo.tp) { // o TP na pedra pode ter zerado a posição
        const r = await consultarTp(sym, alvo);
        if (assumido()) return;
        if (r === 'FILLED') {
          alvo.saidaLimite = { orderId: alvo.tp.orderId, preco: alvo.tp.preco, qty: alvo.tp.qty, ts: agora() }; alvo.tp = null;
          await executarSaida(sym, alvo, { lado: alvo.side, quantidade: alvo.quantidade }, 'SCALP_TP_SNIPER_2M', null, true);
          return;
        }
      }
      if (alvo.saidaPernas?.length) { // cancelarTp pegou fill parcial/total do TP e a posição zerou: fecha com as pernas
        await executarSaida(sym, alvo, { lado: alvo.side, quantidade: 0 }, alvo.saidaMotivo || 'SCALP_TP_SNIPER_2M', null, false);
        return;
      }
      if (!slotDe(sym)) { // alvo herdado de outro processo: sem como saber o desfecho
        console.warn(`[SCALP-ORFAO] ${sym}: alvo scalp sem posição e sem slot; removido sem placar`);
        delete localAlvos[sym]; salvarAlvos();
        talvezFecharTurno();
        return;
      }
      // Sumiu da corretora (stop, liquidação ou fechamento manual): desfecho incerto -> PnL nulo, fora do placar.
      console.warn(`[SCALP-DESCONHECIDO] ${sym}: posição sumiu da corretora; PnL não inventado`);
      const m = lerMainnetSaida(sym, alvo.side);
      const finD = ['SCALP_DESCONHECIDO', null, m.preco, m.slip, { tipo: null, taxaPct: TAXA_TAKER_PCT }];
      if (!(await fut.cancelarTodasOrdens(sym, { estrito: true }).catch(() => false))) marcarCancelPendente(sym, alvo, { fin: finD }); // alvo mantido
      else finalizar(sym, alvo, ...finD);
      return;
    }
    if (!(alvo.entryPrice > 0) && num(pos.precoEntrada) > 0) alvo.entryPrice = num(pos.precoEntrada); // alvo órfão: entrada da corretora
    if ((alvo.orfa || alvo.retomadoBoot) && !alvo.slNaCorretora) { // órfã/herdada/retomada sem stop: rearme antes de qualquer saída
      await garantirStopOrfa(sym, alvo, pos);
      if (assumido()) return;
    }
    const tk = await fut.tickerPreco(sym).catch(() => null);
    const cur = num(tk?.price) || num(pos.precoMarca);
    if (cur > 0) alvo.ultimoPreco = cur; // PnL ao vivo do painel (ticker testnet)
    // Sem preço: só o SL do monitor fica cego; o SL de emergência segue na corretora e a saída por tempo ocorre.
    if (!(cur > 0)) console.error(`[SCALP-PRECO] ${sym}: ticker falhou e sem precoMarca; SL do monitor inativo neste tick`);
    const isLong = pos.lado === 'LONG';
    const entrada = num(alvo.entryPrice);
    const roi = cur > 0 && entrada > 0 ? ((isLong ? cur - entrada : entrada - cur) / entrada) * 100 * ALAV : null; // ROI bruto % a 5x
    if (roi !== null) { alvo.maxRoiReached = Math.max(alvo.maxRoiReached || 0, roi); alvo.minRoiReached = Math.min(alvo.minRoiReached || 0, roi); }
    const fim = fimTurnoTs(alvo);
    // [TP_SNIPER_2M] TP limite na corretora: confere o fill a cada tick; sem TP (falha/expirou) recoloca (máx 3 falhas).
    if (alvo.tp && !alvo.saidaMotivo) {
      const r = await consultarTp(sym, alvo);
      if (assumido()) return;
      if (r === 'FILLED') {
        alvo.saidaLimite = { orderId: alvo.tp.orderId, preco: alvo.tp.preco, qty: alvo.tp.qty, ts: agora() }; alvo.tp = null;
        await executarSaida(sym, alvo, pos, 'SCALP_TP_SNIPER_2M', cur, true);
        return;
      }
    }
    // Gatilhos (1 s): SL curto -2,20% ROI | virada do Supertrend 1m contra | BE rápido | fim do turno.
    if (!alvo.saidaMotivo) {
      let gat = null, janela = 0;
      const slC = alvo.slCurtoPrice > 0 ? alvo.slCurtoPrice : alvo.slPrice;
      if (cur > 0 && slC > 0 && (isLong ? cur <= slC : cur >= slC)) { gat = 'SCALP_SL_CURTO_2M'; janela = SL_CURTO_LIMITE_MS; }
      else if (roi !== null && (alvo.maxRoiReached || 0) >= BE_GATILHO_ROI && roi <= BE_PISO_ROI + 1e-6) { gat = 'SCALP_BE_RAPIDO_2M'; janela = 0; }
      else if (agora() >= fim - FIM_LIMITE_MS) { gat = 'SCALP_FIM_TURNO_2M'; janela = Math.max(0, fim - agora()); }
      else {
        const st = await supertrendAtual(sym);
        if (assumido()) return;
        // só conta virada se o Supertrend estava a favor na entrada
        if (st !== null && alvo.stDirEntrada === (isLong ? 1 : -1) && (isLong ? st === -1 : st === 1)) { gat = 'SCALP_SL_CURTO_2M'; janela = SL_CURTO_LIMITE_MS; alvo.stViradaDir = st; }
      }
      if (gat) {
        alvo.saidaMotivo = gat; alvo.saidaAte = agora() + janela;
        console.log(`[SCALP-GATILHO] ${sym} ${gat} | ROI ${roi === null ? '--' : roi.toFixed(2)}% (máx ${(alvo.maxRoiReached || 0).toFixed(2)}%)${alvo.stViradaDir ? ' | Supertrend virou' : ''} | limite ${janela} ms -> Market`);
        await cancelarTp(sym, alvo); // reduceOnly do TP sai do livro antes da saída; fill parcial/total vira perna
        if (assumido()) return;
        if (alvo.saidaPernas?.length) { const p2 = await fut.posicao(sym).catch(() => undefined); if (p2 && p2.quantidade > 0) pos = p2; else if (p2) return; }
      } else {
        if (!alvo.tp) await colocarTp(sym, alvo, pos); // 1ª vez: logo após a entrada (<= 1 s)
        return;
      }
    }
    // Saída em curso: limite reduceOnly (GTX) até saidaAte; fill = encerra; fim da janela = Market reduceOnly.
    const motivo = alvo.saidaMotivo;
    let limiteCheia = false;
    if (alvo.saidaLimite) {
      const st = await fut.consultarOrdem(sym, alvo.saidaLimite.orderId).catch(() => null);
      if (assumido()) return;
      if (st?.status === 'FILLED') limiteCheia = true;
      else if (st && ESTADOS_FINAIS.includes(st.status) && !(num(st.executedQty) > 0)) alvo.saidaLimite = null; // expirou sem fill
      else if (agora() < alvo.saidaAte) return; // aguardando (inclui fill parcial)
    }
    if (!limiteCheia && agora() < alvo.saidaAte && !alvo.saidaLimite) {
      await colocarSaidaLimite(sym, alvo, pos);
      return;
    }
    if (assumido()) return;
    await executarSaida(sym, alvo, pos, motivo, cur, limiteCheia);
  }

  // Encerra a posição: limite (se houver) cancelada e consultada; o restante vai a Market reduceOnly.
  async function executarSaida(sym, alvo, pos, motivo, cur, limiteCheia) {
    alvo.fechando = true; alvo.fechandoDesde = agora();
    closingInProgress.add(sym);
    let preCancel = false, stopsCancelados = false;
    try {
      const total = alvo.quantidade > 0 ? alvo.quantidade : pos.quantidade;
      let qRest = pos.quantidade;
      if (alvo.saidaLimite) {
        await encerrarSaidaLimite(sym, alvo, limiteCheia);
        const qL = (alvo.saidaPernas || []).reduce((a, p) => a + p.qty, 0);
        if (limiteCheia) {
          // Limite FILLED: reconfere a posição. Sobra real (0 < resto < quantidade lida antes da saída) vai a Market reduceOnly;
          // resto igual à leitura anterior = leitura velha, ignora; erro na leitura = assume zerada (como antes).
          const pF = await fut.posicao(sym).catch(() => undefined);
          const resto = pF && pF.quantidade > 0 ? pF.quantidade : 0;
          qRest = resto > 0 && resto < pos.quantidade - 1e-12 ? resto : 0;
          if (qRest > 0) console.warn(`[SCALP-SAIDA] ${sym}: sobra ${qRest} após a limite cheia; fechando a Market`);
        } else {
          const p2 = await fut.posicao(sym).catch(() => undefined); // posição após o cancelamento
          qRest = p2 === undefined ? Math.max(0, total - qL) : (p2 && p2.quantidade > 0 ? p2.quantidade : 0);
        }
      }
      const pernas = alvo.saidaPernas || [];
      if (qRest > 0) {
        if (!travaOk(sym, 'SAIDA_MARKET')) throw new Error(MSG_NAO_TESTNET);
        const m = lerMainnetSaida(sym, pos.lado);
        preCancel = await cancelarAntesDaMarket(sym); // cancela ordens (limite/stop) ANTES da Market
        stopsCancelados = preCancel;
        const ord = await fut.fecharMercado(sym, pos.lado, qRest);
        stopsCancelados = false; // posição zerada: nada a reproteger
        const saida = num(ord?.avgPrice) > 0 ? num(ord.avgPrice) : (cur > 0 ? cur : null);
        pernas.push({ qty: qRest, preco: saida, tipo: 'MARKET', taxaPct: TAXA_TAKER_PCT, mainnet: m });
      }
      alvo.saidaPernas = pernas;
      const qTot = pernas.reduce((a, p) => a + p.qty, 0);
      let fin;
      if (!(qTot > 0)) { // nada saiu por nós: a posição sumiu (stop/externo)
        const m = lerMainnetSaida(sym, alvo.side);
        fin = ['SCALP_DESCONHECIDO', null, m.preco, m.slip, { tipo: null, taxaPct: TAXA_TAKER_PCT }];
      } else {
        const media = (f) => (pernas.every(p => f(p) > 0) ? pernas.reduce((a, p) => a + f(p) * p.qty, 0) / qTot : null);
        const temMarket = pernas.some(p => p.tipo === 'MARKET');
        const motivoFinal = motivo === 'SCALP_TEMPO_60S' && !temMarket ? 'SCALP_TEMPO_LIMITE' : motivo;
        const taxaSaida = pernas.reduce((a, p) => a + p.taxaPct * p.qty, 0) / qTot;
        const slipM = pernas.every(p => Number.isFinite(p.mainnet?.slip)) ? pernas.reduce((a, p) => a + p.mainnet.slip * p.qty, 0) / qTot : null;
        alvo.quantidade = qTot;
        fin = [motivoFinal, media(p => p.preco), media(p => p.mainnet?.preco), slipM, { tipo: temMarket ? 'MARKET' : 'LIMITE', taxaPct: taxaSaida }];
      }
      if (!preCancel && !(await cancelarAntesDaMarket(sym))) { marcarCancelPendente(sym, alvo, { fin }); return; } // alvo mantido
      finalizar(sym, alvo, ...fin);
    } catch (e) {
      console.error(`[SCALP-SAIDA] ${sym}: ${e.message} — nova tentativa no próximo tick`);
      falhaSaida(sym, alvo, e.message);
      if (stopsCancelados && localAlvos[sym] === alvo) { // stop caiu no cancelamento e a Market falhou: rearma o stop antes da nova tentativa
        alvo.slNaCorretora = false;
        await garantirStopOrfa(sym, alvo, pos).catch(() => false);
      }
    } finally {
      if (localAlvos[sym]) localAlvos[sym].fechando = false;
      closingInProgress.delete(sym);
    }
  }

  // Órfã / abandonada / travada em FECHANDO / vencida (> fim do turno + 15 s): confere a corretora. Posição real = Market reduceOnly;
  // sem posição (fantasma de estado) = limpa alvo e slot na hora, sem TRADE nem placar.
  async function resolverOrfas() {
    for (const sym of posicoesScalp()) {
      const a = localAlvos[sym];
      if (!a || entrando.has(sym) || closingInProgress.has(sym) || a.cancelPendente) continue;
      if (a.fechando && agora() - (a.fechandoDesde || 0) > 30000) a.fechando = false; // trava presa
      const vencida = agora() > fimTurnoTs(a) + ORFA_RESOLVE_MS;
      if (!(a.orfa || a.abandonada || vencida)) continue;
      if (a.fechando || agora() - (a.orfaTentTs || 0) < ORFA_RETRY_MS) continue;
      a.orfaTentTs = agora();
      if (!travaOk(sym, 'ORFA_RESOLVE')) continue;
      let pos;
      try { pos = await fut.posicao(sym); } catch (e) { continue; } // sem leitura: não adivinha
      if (localAlvos[sym] !== a || closingInProgress.has(sym)) continue;
      if (!pos || !(pos.quantidade > 0)) {
        await fut.cancelarTodasOrdens(sym, { estrito: true }).catch(() => false);
        delete localAlvos[sym]; salvarAlvos(); liberarSlot(sym); talvezFecharTurno();
        console.warn(`[SCALP-ORFA] ${sym}: sem posição na corretora; alvo e slot limpos (fantasma de estado)`);
        logar({ tipo: 'EVENTO', evento: 'SCALP_ORFA_LIMPA', ts: agora(), turno_id: a.turnoId ?? null, simbolo: sym, lado: a.side, motivo: 'SEM_POSICAO_NA_CORRETORA' });
        continue;
      }
      closingInProgress.add(sym); a.fechando = true; a.fechandoDesde = agora();
      try {
        const m = lerMainnetSaida(sym, pos.lado);
        await cancelarAntesDaMarket(sym);
        const ord = await fut.fecharMercado(sym, pos.lado, pos.quantidade); // reduceOnly
        const saida = num(ord?.avgPrice) > 0 ? num(ord.avgPrice) : (num((await fut.tickerPreco(sym).catch(() => null))?.price) || null);
        a.quantidade = pos.quantidade;
        if (!(a.entryPrice > 0) && num(pos.precoEntrada) > 0) a.entryPrice = num(pos.precoEntrada);
        await cancelarAntesDaMarket(sym);
        finalizar(sym, a, 'SCALP_ORFA_FECHADA', saida, m.preco, m.slip, { tipo: 'MARKET', taxaPct: TAXA_TAKER_PCT });
        console.warn(`[SCALP-ORFA] ${sym}: posição real fechada a Market reduceOnly; slot liberado`);
      } catch (e) {
        console.error(`[SCALP-ORFA] ${sym}: fechamento a Market falhou (${e.message}); nova tentativa em ${ORFA_RETRY_MS / 1000}s`);
      } finally {
        if (localAlvos[sym]) localAlvos[sym].fechando = false;
        closingInProgress.delete(sym);
      }
    }
  }

  // Loop próprio do monitor scalp, com guarda de reentrância.
  async function monitorarTodas() {
    if (estado.monitorando) return;
    estado.monitorando = true;
    try {
      if (estado.enabled || posicoesScalp().length) await resolverOrfas().catch(e => console.error(`[SCALP-ORFA] ${e.message}`));
      for (const sym of posicoesScalp()) {
        const alvo = localAlvos[sym];
        if (!alvo || alvo.fechando || closingInProgress.has(sym) || (alvo.abandonada && !alvo.cancelPendente)) continue;
        await monitorarPosicao(sym, alvo).catch(e => console.error(`[SCALP-MONITOR] ${sym}: ${e.message}`));
      }
      // Cancelamento pendente sem alvo: retenta só com o símbolo livre (não toca ordens de outro dono).
      for (const [sym, n] of cancelSemAlvo) {
        if (ocupadoOutro(sym) || entrando.has(sym) || !travaOk(sym, 'CANCEL_RETRY')) continue;
        if (await fut.cancelarTodasOrdens(sym, { estrito: true }).catch(() => false)) { cancelSemAlvo.delete(sym); console.log(`[SCALP-CANCEL] ${sym}: ordens canceladas na retentativa`); continue; }
        cancelSemAlvo.set(sym, n + 1);
        console.error(`[SCALP-CANCEL] ${sym}: cancelamento falhou de novo (${n + 1}/${MAX_TENTATIVAS_SAIDA})`);
        if (n + 1 >= MAX_TENTATIVAS_SAIDA) {
          cancelSemAlvo.delete(sym);
          console.error(`[SCALP-ORFA] ALERTA ${sym}: ${n + 1} tentativas de cancelamento falharam; motor parou de tentar. Conferir ordens na corretora.`);
          logar({ tipo: 'EVENTO', evento: 'SCALP_ORFA_ABANDONADA', ts: agora(), simbolo: sym, tentativas: n + 1, motivo: 'CANCEL_FALHOU_SEM_ALVO', slot: null });
        }
      }
    } finally {
      estado.monitorando = false;
    }
  }

  function iniciar() {
    if (estado.enabled && !ehTestnet(baseOrdens)) { // boot com flag ON fora do testnet: desliga em memória
      estado.enabled = false;
      console.error(`[SCALP-1M] ${MSG_NAO_TESTNET}`);
    }
    // Alvos scalp herdados do processo anterior: slots 3/4 (o turno só usa slots livres).
    // Turno em andamento (entrada conhecida e idade < ORFA_IDADE_MS): RETOMADO, sem fechar a Market; o monitor segue o
    // ciclo normal (limite aos 1:40, Market aos 2:00; openTime + HOLD_MS já vencido = fecha no 1º ciclo). Demais: órfã.
    for (const sym of posicoesScalp()) {
      if (slotDe(sym)) continue;
      const a = localAlvos[sym];
      const n = SLOTS.includes(a.slot) && !estado.slots[a.slot].symbol ? a.slot : slotsLivres()[0];
      const retomar = !a.orfa && !a.cancelPendente && num(a.entryPrice) > 0 && num(a.openTime) > 0 && agora() - a.openTime < ORFA_IDADE_MS;
      if (retomar) { a.retomadoBoot = true; a.fechando = false; a.fechandoDesde = 0; } else if (!a.orfa) { a.orfa = true; a.orfaDesde = agora(); }
      const rot = retomar ? `[SCALP ATIVO] ${sym} ${a.side} ${ALAV}x` : `[SCALP ÓRFÃ] ${sym} ${a.side}`;
      if (n) estado.slots[n] = { symbol: sym, side: a.side, status: rot, openTime: a.openTime || agora() };
      // Sem stop confirmado: o 1º ciclo do monitor rearma o stop (stop_pct do alvo; garantirStopOrfa) antes de qualquer saída.
      console.warn(`[SCALP-BOOT] ${sym}: alvo scalp_1m herdado; monitor scalp assume (slot ${n || '-'}, ${retomar ? 'turno em andamento retomado' : 'órfã'}, stop ${a.slNaCorretora ? 'na corretora' : 'ausente: rearme antes da saída'})`);
    }
    if (estado.enabled) feed.iniciar();
    if (!timer) timer = setInterval(() => { tick().catch(() => {}); }, 500);
    if (!timerMonitor) timerMonitor = setInterval(() => { monitorarTodas().catch(() => {}); }, MONITOR_MS);
  }

  function status() {
    const t = agora();
    if (inicioDiaUtc(t) > estado.hoje.dia) estado.hoje = criarResumoDia(inicioDiaUtc(t));
    const tu = estado.turno;
    const slots = SLOTS.filter(n => estado.slots[n].symbol).map(n => {
      const s = estado.slots[n];
      const a = localAlvos[s.symbol];
      const entrada = num(a?.entryPrice), q = num(a?.quantidade), cur = num(a?.ultimoPreco);
      const st = !a ? 'ENTRANDO' : a.orfa ? 'ORFA' : a.fechando ? 'FECHANDO' : a.saidaLimite ? 'SAINDO_LIMITE' : 'ATIVO';
      return {
        slot: n, moeda: s.symbol, direcao: s.side, precoEntrada: entrada > 0 ? entrada : null,
        pnlAoVivo: entrada > 0 && q > 0 && cur > 0 ? (cur - entrada) * q * (s.side === 'LONG' ? 1 : -1) : null,
        segundosRestantes: a?.openTime ? Math.max(0, Math.ceil((fimTurnoTs(a) - t) / 1000)) : null,
        status: st
      };
    });
    const fc = faseCiclo(t);
    const pl = estado.plano && estado.plano.fronteira > t ? estado.plano : null;
    return {
      enabled: estado.enabled,
      simbolos: estado.simbolos.slice(),
      universo: estado.universo,
      universoTs: estado.universoTs || null,
      config: {
        margem: MARGEM, alavancagem: ALAV, slEmergPct: SL_EMERG_PCT, slTetoPct: SL_TETO_PCT, slAtrMult: SL_ATR_MULT, holdMs: HOLD_MS, taxaPct: TAXA_PCT,
        taxaMakerPct: TAXA_MAKER_PCT, taxaTakerPct: TAXA_TAKER_PCT, turnoMs: TURNO_MS, saidaLimiteMs: SAIDA_LIMITE_MS, entradaLimiteMs: ENTRADA_LIMITE_MS, entradaReprecoMs: ENTRADA_REPRECO_MS,
        faseAnaliseIniMs: FASE_ANALISE_INI_MS, faseConfirmacaoIniMs: FASE_CONFIRMACAO_INI_MS, analiseIntervaloMs: ANALISE_INTERVALO_MS, jevTimeoutMs, jevAntecedenciaMs: JEV_ANTECEDENCIA_MS,
        rankingIntervaloMs: RANKING_INTERVALO_MS, rankingMax: RANKING_MAX, rotacaoCiclos: ROTACAO_CICLOS, duracaoMs: SCALP_DURACAO_MS,
        sniper: { scoreMin: SNIPER_SCORE_MIN, tpRoiPct: TP_PRICE_PCT * ALAV, bePctRoi: [BE_GATILHO_ROI, BE_PISO_ROI], slCurtoRoiPct: SL_CURTO_ROI, atrMinPct: ATR_ENTRADA_MIN_PCT, rvolMin: RVOL_MIN, entradaFugaAbortaPct: ENTRADA_FUGA_ABORTA_PCT }
      },
      agoraMs: t,
      ciclo: {
        fase: fc.fase, inicioMs: fc.inicio, dentroMs: fc.dentroMs, faseRestanteMs: fc.faseRestanteMs, cicloRestanteMs: fc.cicloRestanteMs,
        segundosFase: Math.ceil(fc.faseRestanteMs / 1000), segundosCiclo: Math.ceil(fc.cicloRestanteMs / 1000)
      },
      ranking: estado.ranking.map(c => ({ ...c, fora1Ciclo: foraNoCiclo(c.simbolo, cicloDe(t) + 1) })),
      rotacao: {
        ciclosRestantes: estado.universoCiclo === null ? null : Math.max(0, estado.universoCiclo + ROTACAO_CICLOS - cicloDe(t)),
        ciclosTotal: ROTACAO_CICLOS, montadaEmMs: estado.universoTs || null
      },
      fora1Ciclo: [...estado.fora].filter(([, v]) => v === cicloDe(t) + 1).map(([simbolo]) => simbolo),
      rankingTs: estado.rankingTs,
      proximas: pl ? pl.ordem.slice(0, MAX_ENTRADAS_TURNO).map(c => ({ simbolo: c.simbolo, direcao: c.direcao, direcaoJev: c.jev?.direcao ?? null, jevFeito: !!pl.jevFeito })) : [],
      historico: estado.historico.slice().reverse(),
      jev: { ...estado.jev, taxaDiverge: estado.jev.total ? estado.jev.diverge / estado.jev.total : 0, taxaConcorda: estado.jev.comOpiniao ? estado.jev.concorda / estado.jev.comOpiniao : null, latenciaMediaMs: estado.jev.total ? Math.round(estado.jev.latenciaSomaMs / estado.jev.total) : null, ativo: !!jevKey },
      slots: estado.slots,
      turnoAtual: {
        numero: tu?.numero ?? null, id: tu?.id ?? null, status: tu?.status ?? 'AGUARDANDO',
        proximoEmMs: Math.floor(t / TURNO_MS) * TURNO_MS + TURNO_MS - t,
        slots, somaTurno: somaTurno(tu)
      },
      ultimoTurno: estado.ultimoTurno,
      hoje: formatarResumo(estado.hoje),
      maker_entrada_pct: formatarResumo(estado.hoje).pctEntradaMaker,
      maker_saida_pct: formatarResumo(estado.hoje).pctSaidaMaker,
      pesoRest: peso ? peso.status() : null,
      ultimoCiclo: estado.ultimoCiclo,
      atrBaixo: estado.atrBaixo,
      testnet: ehTestnet(baseOrdens),
      feedAtivo: feed.ativo()
    };
  }

  // Botão ZERAR: contadores do dia (WR, taxas, PnL), histórico de turnos e contexto do Jev recomeçam do zero; posições abertas seguem.
  function zerarContadores() {
    estado.hoje = criarResumoDia(inicioDiaUtc(agora()));
    estado.historico = []; estado.ultimoTurno = null; estado.recentes = []; estado.ranking = [];
    estado.atrBaixo = { total: 0, porSimbolo: {} };
    estado.jev = { total: 0, diverge: 0, falhas: 0, pulou: 0, timeouts: 0, comOpiniao: 0, concorda: 0, latenciaSomaMs: 0 };
    estado.fora = new Map();
    console.log('[SCALP-ZERAR] contadores, histórico de turnos e taxas do ciclo zerados');
  }

  const emEntrada = (sym) => entrando.has(sym);
  return {
    zerarContadores,
    iniciar, tick, definirEnabled, monitorarPosicao, monitorarTodas, status, travaOk, registrarTradeExterno,
    emEntrada, garantirStopOrfa, marcarCancelPendente, _estado: estado, _avaliarTurno: executarTurno, _confirmar: confirmar, _analisar: analisar,
    _registrarTrade: registrarTrade, _classificarFora: classificarFora, _atualizarUniverso: atualizarUniverso
  };
}

module.exports = {
  EXCLUIDOS, SLOTS, MARGEM, ALAV, SL_EMERG_PCT, HOLD_MS, TAXA_PCT, TAXA_MAKER_PCT, TAXA_TAKER_PCT,
  SCALP_DURACAO_MS, ROTACAO_CICLOS, DESEMPATE_SCORE_PCT, HOSTS_TESTNET, montarLista20, desempatarPorVolume, distanciaFaixaAtr,
  RANKING_INTERVALO_MS, RANKING_MAX, VOLUME_MIN_USDT, SPREAD_UNIVERSO_MAX_PCT, CONCORRENCIA_REST,
  IDADE_MIN_LISTAGEM_MS, SIMBOLO_ASCII_RE, ATR_MIN_PCT, ATR_MAX_PCT, SL_TETO_PCT, SL_ATR_MULT, ENTRADA_REPRECO_MS,
  PESO_LIMITE_1M, PESO_RECUO_FRACAO, PESO_INTERVALO_MS, corteAtr, stopPctDeAtr, pesoKlines, criarControlePeso,
  filtrarUniverso, cabeNaMargem, camposInvalidos, emLotes,
  TURNO_MS, SAIDA_LIMITE_MS, ENTRADA_LIMITE_MS, FASE_ANALISE_INI_MS, FASE_CONFIRMACAO_INI_MS, ANALISE_INTERVALO_MS, GEMINI_CONFIRMA_MS, ORFA_ALERTA_MS, MAX_TENTATIVAS_SAIDA, posicaoScalpSemAlvo,
  WHITELIST, SPREAD_TESTNET_MAX_PCT, supertrend, avaliarSniper, SNIPER_SCORE_MIN, TP_PRICE_PCT, SL_CURTO_PCT, BE_GATILHO_ROI, BE_PISO_ROI, FIM_ANTECIPA_MS, FIM_LIMITE_MS, ENTRADA_FUGA_ABORTA_PCT, ENTRADA_FUGA_MARKET_PCT,
  ema, atrPct, rvol, vwapSessao, fluxo60s, bookImbalance, slippageEstimadoPct,
  montarDados, avaliarGate, calcularPnl, rankearCandidatas, consultarJev, comPrazo, MOEDAS_PREPARADAS, JEV_CONF_MIN, ATR_ENTRADA_MIN_PCT, contextoMercado, rsi14, JEV_ANTECEDENCIA_MS, JEV_TIMEOUT_MS, vetoGemini, criarContadorVeto,
  contarCondicoes, bloqueioDuro, votarDirecao, avaliarCandidata, faseCiclo, payloadConfirmacao, interpretarConfirmacao,
  criarResumoDia, acumularResumo, formatarResumo,
  registrarJsonl, lerFlag, salvarFlag, criarMotor, ehTestnet, limpezaBoot, MOTIVO_MAX
};
