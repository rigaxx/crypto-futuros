// ============================================================
// FEED MAINNET DO SCALP 1M (dados do sinal 100% MAINNET).
// Base FIXA: nunca usa FAPI/FUTURES_BASE (que pode apontar ao testnet).
// WS medido nesta VPS em 2026-11-02:
//   /stream?streams=...@aggTrade      -> 0 trades (rota legada muda)
//   /market/stream?streams=...@aggTrade -> trades chegam
//   /public/stream?streams=...@depth10@100ms -> book chega
// Por isso são 2 grupos de sockets: aggTrade em /market, depth10 em /public.
// Universo dinâmico: assinar()/desassinar() por símbolo (SUBSCRIBE/UNSUBSCRIBE no socket aberto);
// até MAX_STREAMS_CONEXAO streams por socket, acima disso abre outro.
// Heartbeat: socket mudo por HEARTBEAT_MS reconecta com backoff exponencial (teto 30 s).
// Fallback REST (aggTrades 60 s + depth 10) no warmup e com o WS caído: garantir()/aquecer().
// ============================================================
const axios = require('axios');

const MAINNET_REST = 'https://fapi.binance.com';
const MAINNET_WS = 'wss://fstream.binance.com';
const BUFFER_MS = 60000;
const HEARTBEAT_MS = 5000;           // sem mensagem por 5 s = reconecta
const BACKOFF_MAX_MS = 30000;
const MAX_STREAMS_CONEXAO = 150;
const FRESCO_MS = 3000;              // dado REST vale o mesmo teto do gate (3 s)
const REST_MIN_INTERVALO_MS = 2000;  // fallback REST por símbolo: no máx 1 a cada 2 s
const AGG_LIMITE = 1000;
const AGG_PAGINAS_MAX = 3;           // aggTrades pesa 20: no máx 3 páginas por aquecimento
const PESO_AGG = 20, PESO_DEPTH = 2;
const PESO_MAX_MIN = 1200;           // teto de peso REST do feed por minuto (limite da conta: 2400/min, dividido com o resto)
const ROTAS = [
  { rota: 'market', sufixo: 'aggTrade', tipo: 'trade' },
  { rota: 'public', sufixo: 'depth10@100ms', tipo: 'book' }
];

const http = axios.create({ baseURL: MAINNET_REST, timeout: 5000 });
// Último X-MBX-USED-WEIGHT-1M visto (peso do IP no minuto corrente); lido pelo controle de peso do motor scalp.
let pesoHeader = { peso: null, ts: 0 };
const lerPesoHeader = (r) => {
  const v = Number(r?.headers?.['x-mbx-used-weight-1m']);
  if (Number.isFinite(v) && v >= 0) pesoHeader = { peso: v, ts: Date.now() };
};
const get = (url, params) => http.get(url, { params }).then(r => { lerPesoHeader(r); return r.data; }, e => { lerPesoHeader(e?.response); throw e; });

const rest = {
  klines: (symbol, interval, limit) => get('/fapi/v1/klines', { symbol, interval, limit }),
  depth: (symbol, limit = 10) => get('/fapi/v1/depth', { symbol, limit }),
  aggTrades: (symbol, params = {}) => get('/fapi/v1/aggTrades', { symbol, limit: AGG_LIMITE, ...params }),
  exchangeInfo: () => get('/fapi/v1/exchangeInfo'),
  ticker24h: () => get('/fapi/v1/ticker/24hr'),
  bookTicker: () => get('/fapi/v1/ticker/bookTicker'),
  pesoUsado: () => ({ ...pesoHeader })
};

// Feed WS com buffer de 60 s de aggTrade, book 10 níveis, timestamp por símbolo, heartbeat e fallback REST.
function criarFeed(simbolosIniciais = [], opts = {}) {
  const WebSocket = opts.WebSocket || require('ws');
  const agora = opts.agora || (() => Date.now());
  const restF = opts.rest || rest;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const estado = {};
  const conns = [];
  const connDe = { trade: new Map(), book: new Map() };
  const simbolos = new Set();
  let ativo = false;
  let vigia = null;
  let nConn = 0, nReq = 0;
  const gastos = [];                 // [{ t, w }] peso REST gasto no último minuto
  let ultimoAvisoPeso = 0;
  // Reserva peso REST na janela de 60 s; sem saldo = não chama (o dado fica inválido neste ciclo).
  function reservarPeso(w) {
    const t = agora();
    while (gastos.length && gastos[0].t <= t - 60000) gastos.shift();
    const usado = gastos.reduce((a, g) => a + g.w, 0);
    if (usado + w > PESO_MAX_MIN) {
      if (t - ultimoAvisoPeso >= 30000) { ultimoAvisoPeso = t; console.warn(`[SCALP-FEED] teto de peso REST (${usado}/${PESO_MAX_MIN} por min): fallback adiado`); }
      return false;
    }
    gastos.push({ t, w });
    return true;
  }

  const novoSt = () => ({ trades: [], book: null, tsTrade: 0, tsBook: 0, ultimoA: 0, wsDesde: 0, cobreDesde: 0, restTs: 0, restTentTs: 0, emCurso: null });
  const stream = (c, s) => `${s.toLowerCase()}@${c.sufixo}`;

  function podar(st, t) {
    const lim = t - BUFFER_MS;
    let i = 0;
    while (i < st.trades.length && st.trades[i].T < lim) i++;
    if (i) st.trades.splice(0, i);
  }

  function onTrade(d) {
    const st = estado[d.s];
    if (!st) return;
    const a = Number(d.a);
    if (Number.isFinite(a)) {
      if (a <= st.ultimoA) return; // já veio pelo REST
      st.ultimoA = a;
    }
    st.trades.push({ a: Number.isFinite(a) ? a : null, T: d.T, p: parseFloat(d.p), q: parseFloat(d.q), m: !!d.m });
    st.tsTrade = d.E || d.T;
    podar(st, agora());
  }

  function onBook(d) {
    const st = estado[d.s];
    if (!st) return;
    st.book = { bids: d.b || [], asks: d.a || [] };
    st.tsBook = d.E || d.T;
  }

  // Socket vivo e com mensagem recente para o símbolo.
  function vivo(tipo, sym) {
    const c = connDe[tipo].get(sym);
    return !!(c && c.ws && !c.caiu && c.vivaDesde > 0 && c.urlSyms.has(sym) && agora() - c.ultimaMsg <= HEARTBEAT_MS);
  }

  function mudoMs(sym) {
    let pior = null;
    for (const tipo of ['trade', 'book']) {
      const c = connDe[tipo].get(sym);
      if (!c) continue;
      const m = agora() - (c.ultimaMsg || 0);
      if (pior === null || m > pior) pior = m;
    }
    return pior;
  }

  function marcarWs(c, t) {
    if (c.tipo !== 'trade') return;
    for (const s of c.urlSyms) {
      const st = estado[s];
      if (st && !st.wsDesde) { st.wsDesde = t; st.cobreDesde = t; }
    }
  }

  // Ajusta as streams do socket aberto ao conjunto desejado (SUBSCRIBE/UNSUBSCRIBE).
  function sincronizarSub(c) {
    if (!c.ws || c.ws.readyState !== 1) return;
    const add = [...c.syms].filter(s => !c.urlSyms.has(s));
    const rem = [...c.urlSyms].filter(s => !c.syms.has(s));
    try {
      if (add.length) c.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: add.map(s => stream(c, s)), id: ++nReq }));
      if (rem.length) c.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: rem.map(s => stream(c, s)), id: ++nReq }));
    } catch (e) { console.warn(`[SCALP-FEED] ${c.rota}#${c.id}: assinatura falhou (${e.message})`); return; }
    c.urlSyms = new Set(c.syms);
    if (c.vivaDesde) marcarWs(c, agora());
  }

  function conectar(c) {
    if (!ativo || c.fechado || !c.syms.size) return;
    const ws = new WebSocket(`${MAINNET_WS}/${c.rota}/stream?streams=${[...c.syms].map(s => stream(c, s)).join('/')}`);
    Object.assign(c, { ws, urlSyms: new Set(c.syms), ultimaMsg: agora(), vivaDesde: 0, caiu: false });
    ws.on('open', () => { if (c.ws === ws) sincronizarSub(c); });
    ws.on('message', (m) => {
      if (c.ws !== ws) return;
      const t = agora();
      c.ultimaMsg = t;
      if (!c.vivaDesde) { c.vivaDesde = t; c.tentativa = 0; marcarWs(c, t); }
      let j;
      try { j = JSON.parse(m); } catch (e) { return; }
      if (j && j.data) (c.tipo === 'trade' ? onTrade : onBook)(j.data);
    });
    const caiu = () => {
      if (c.ws !== ws || c.caiu) return;
      c.caiu = true;
      if (c.tipo === 'trade') {
        for (const s of c.urlSyms) if (estado[s]) Object.assign(estado[s], { wsDesde: 0, cobreDesde: 0, trades: [] });
      }
      if (!ativo || c.fechado) return;
      const espera = Math.min(BACKOFF_MAX_MS, 1000 * Math.pow(2, c.tentativa));
      c.tentativa++;
      c.esperaMs = espera;
      c.timer = setT(() => { c.timer = null; conectar(c); }, espera);
    };
    c.caiuFn = caiu;
    ws.on('close', caiu);
    ws.on('error', (e) => {
      console.warn(`[SCALP-FEED] ${c.rota}#${c.id}: ${e && e.message}`);
      try { ws.terminate(); } catch (x) {}
      caiu();
    });
  }

  function fecharConexao(c, remover) {
    if (c.timer) { clearT(c.timer); c.timer = null; }
    const ws = c.ws;
    c.ws = null; c.vivaDesde = 0;
    if (ws) { try { ws.terminate(); } catch (e) {} }
    if (remover) { c.fechado = true; const i = conns.indexOf(c); if (i >= 0) conns.splice(i, 1); }
  }

  // Heartbeat: socket sem mensagem por HEARTBEAT_MS é derrubado; o close reconecta com backoff.
  function vigiar() {
    const t = agora();
    for (const c of conns.slice()) {
      if (!c.ws || c.caiu || c.fechado) continue;
      const mudo = t - c.ultimaMsg;
      if (mudo <= HEARTBEAT_MS) continue;
      const espera = Math.min(BACKOFF_MAX_MS, 1000 * Math.pow(2, c.tentativa));
      console.warn(`[SCALP-FEED] ${c.rota}#${c.id} mudo há ${(mudo / 1000).toFixed(1)}s (${c.syms.size} moedas); reconectando em ${espera / 1000}s`);
      try { c.ws.terminate(); } catch (e) {}
      if (c.caiuFn) c.caiuFn();
    }
  }

  function assinar(lista) {
    const novas = [];
    const tocadas = new Set();
    for (const s of lista || []) {
      if (!s || simbolos.has(s)) continue;
      simbolos.add(s);
      estado[s] = novoSt();
      novas.push(s);
      for (const r of ROTAS) {
        let c = conns.find(x => x.tipo === r.tipo && !x.fechado && x.syms.size < MAX_STREAMS_CONEXAO);
        if (!c) { c = { id: ++nConn, ...r, syms: new Set(), urlSyms: new Set(), tentativa: 0, ws: null, ultimaMsg: 0, vivaDesde: 0 }; conns.push(c); }
        c.syms.add(s);
        connDe[r.tipo].set(s, c);
        tocadas.add(c);
      }
    }
    if (ativo) for (const c of tocadas) { if (!c.ws && !c.timer) conectar(c); else sincronizarSub(c); }
    return novas;
  }

  function desassinar(lista) {
    const saiu = [];
    const tocadas = new Set();
    for (const s of lista || []) {
      if (!simbolos.has(s)) continue;
      simbolos.delete(s);
      delete estado[s];
      saiu.push(s);
      for (const r of ROTAS) {
        const c = connDe[r.tipo].get(s);
        connDe[r.tipo].delete(s);
        if (c) { c.syms.delete(s); tocadas.add(c); }
      }
    }
    for (const c of tocadas) { if (!c.syms.size) fecharConexao(c, true); else sincronizarSub(c); }
    return saiu;
  }

  // Busca os últimos 60 s de aggTrades (página mais recente para trás). Retorna { trades, cobreDesde }.
  async function buscarTrades(sym, t0) {
    let todos = [];
    if (!reservarPeso(PESO_AGG)) throw new Error('teto de peso REST');
    let pag = await restF.aggTrades(sym, {});
    for (let i = 0; i < AGG_PAGINAS_MAX; i++) {
      if (!Array.isArray(pag)) throw new Error('aggTrades inválido');
      todos = pag.concat(todos);
      const velho = todos[0];
      if (!velho || pag.length < AGG_LIMITE || Number(velho.T) <= t0 - BUFFER_MS) break;
      if (i === AGG_PAGINAS_MAX - 1) break;
      const fromId = Number(velho.a) - AGG_LIMITE;
      if (!(fromId >= 0) || !reservarPeso(PESO_AGG)) break;
      pag = await restF.aggTrades(sym, { fromId });
    }
    const velho = todos[0];
    const completo = !velho || Number(velho.T) <= t0 - BUFFER_MS || todos.length < AGG_LIMITE;
    const trades = todos.map(x => ({ a: Number(x.a), T: Number(x.T), p: parseFloat(x.p), q: parseFloat(x.q), m: !!x.m }))
      .filter(x => Number.isFinite(x.T) && x.T >= t0 - BUFFER_MS);
    return { trades, cobreDesde: completo ? t0 - BUFFER_MS : Number(velho.T) };
  }

  // Preenche o buffer via REST na hora (warmup ou WS caído). Tolerante a erro: devolve true/false.
  function aquecer(sym, o = { trades: true, book: true }) {
    const st = estado[sym];
    if (!st) return Promise.resolve(false);
    if (st.emCurso) return st.emCurso;
    st.restTentTs = agora();
    st.emCurso = (async () => {
      const t0 = agora();
      let ok = true;
      const [rt, rb] = await Promise.all([
        o.trades ? buscarTrades(sym, t0).catch(e => ({ erro: e })) : null,
        o.book ? Promise.resolve().then(() => { if (!reservarPeso(PESO_DEPTH)) throw new Error('teto de peso REST'); return restF.depth(sym, 10); }).catch(e => ({ erro: e })) : null
      ]);
      const atual = estado[sym];
      if (atual !== st) return false; // desassinado no meio
      const t1 = agora();
      if (rt && !rt.erro) {
        const maxA = rt.trades.reduce((m, x) => (x.a > m ? x.a : m), 0);
        const ws = st.trades.filter(x => !(x.a <= maxA));
        st.trades = rt.trades.concat(ws).sort((x, y) => x.T - y.T);
        st.ultimoA = Math.max(st.ultimoA, maxA);
        st.cobreDesde = rt.cobreDesde;
        st.tsTrade = Math.max(st.tsTrade || 0, t1);
        st.restTs = t1;
        podar(st, t1);
      } else if (rt) { ok = false; console.warn(`[SCALP-FEED] ${sym}: aggTrades REST falhou (${rt.erro.message})`); }
      if (rb && !rb.erro && Array.isArray(rb.bids) && Array.isArray(rb.asks)) {
        if (!vivo('book', sym) || !st.book) { st.book = { bids: rb.bids, asks: rb.asks }; st.tsBook = t1; }
      } else if (rb) { ok = false; console.warn(`[SCALP-FEED] ${sym}: depth REST falhou (${rb.erro ? rb.erro.message : 'resposta inválida'})`); }
      return ok;
    })().finally(() => { st.emCurso = null; });
    return st.emCurso;
  }

  // Cópia do estado do símbolo. bufferCompleto = 60 s cobertos sem buraco (WS contínuo e/ou REST).
  function snapshot(sym) {
    const st = estado[sym];
    if (!st) return null;
    const t = agora();
    podar(st, t);
    return {
      trades: st.trades.slice(),
      book: st.book,
      tsTrade: st.tsTrade,
      tsBook: st.tsBook,
      bufferCompleto: st.cobreDesde > 0 && t - st.cobreDesde >= BUFFER_MS,
      wsMudoMs: mudoMs(sym),
      wsVivo: vivo('trade', sym) && vivo('book', sym)
    };
  }

  // Snapshot com fallback REST: buffer incompleto ou WS caído com dado velho = busca REST na hora.
  async function garantir(sym) {
    const st = estado[sym];
    if (!st) return null;
    const t = agora();
    const snap = snapshot(sym);
    const precisaTrades = !snap.bufferCompleto || (!vivo('trade', sym) && t - st.tsTrade > FRESCO_MS);
    const precisaBook = !snap.book || (!vivo('book', sym) && t - st.tsBook > FRESCO_MS);
    if (!precisaTrades && !precisaBook) return snap;
    if (!st.emCurso && t - st.restTentTs < REST_MIN_INTERVALO_MS) return snap;
    await aquecer(sym, { trades: precisaTrades, book: precisaBook });
    return snapshot(sym);
  }

  function iniciar() {
    if (ativo) return;
    ativo = true;
    for (const c of conns) conectar(c);
    vigia = setInterval(vigiar, 1000);
    if (vigia.unref) vigia.unref();
  }

  function parar() {
    ativo = false;
    if (vigia) clearInterval(vigia);
    vigia = null;
    for (const c of conns) fecharConexao(c, false);
    for (const s of simbolos) estado[s] = novoSt();
  }

  assinar(simbolosIniciais);

  return {
    iniciar, parar, snapshot, garantir, aquecer, assinar, desassinar, mudoMs,
    simbolos: () => [...simbolos], ativo: () => ativo,
    _onTrade: onTrade, _onBook: onBook, _vigiar: vigiar, _conns: conns
  };
}

module.exports = { MAINNET_REST, MAINNET_WS, HEARTBEAT_MS, BACKOFF_MAX_MS, MAX_STREAMS_CONEXAO, BUFFER_MS, PESO_MAX_MIN, rest, criarFeed };
