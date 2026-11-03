const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../lib/scalp1m');
// ATENÇÃO (migração Sniper 2 min): os testes marcados test.skip abaixo descrevem o contrato ANTIGO (turno de 5 min, 12 s de entrada a Market,
// stop 0,30-0,90% por ATR, saída aos 1:40/2:00, direção por voto). O contrato novo é coberto por tests/sniper2m.test.js; cada skip precisa
// ser reescrito (relógio de 120 s, klines com Supertrend, Jev aprova) antes de voltar a rodar.
const HOLD = s.SCALP_DURACAO_MS, SAIDA = s.SAIDA_LIMITE_MS; // 2:00 Market, 1:40 limite
const { resumir } = require('../scripts/scalp_expectativa');

const quase = (a, b, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);
// kline: [openTime, o, h, l, c, v, closeTime]
const k = (t, o, h, l, c, v) => [t, String(o), String(h), String(l), String(c), String(v), t + 59999];

// Dados base que aprovam LONG (5/5).
const AGORA = 1_800_000_000_000;
function base(over = {}) {
  return {
    simbolo: 'ETHUSDT', timestamp_dados_ms: AGORA - 500, timestamp_agora_ms: AGORA, preco: 101,
    taker_buy_ratio_60s: 0.60, cvd_delta_60s: 12, book_imbalance_10: 0.30, rvol: 2.5, vwap: 100,
    ema9_5m: 102, ema21_5m: 100, ema9_15m: 101, ema21_15m: 99, atr_1m_pct: 0.20, spread_pct: 0.01, ema9_1m: 100.95, st1m_dir: 1, ...over
  };
}
function baseShort(over = {}) {
  return base({
    preco: 99, taker_buy_ratio_60s: 0.40, cvd_delta_60s: -12, book_imbalance_10: -0.30,
    ema9_5m: 98, ema21_5m: 100, ema9_15m: 97, ema21_15m: 99, ema9_1m: 99.05, st1m_dir: -1, ...over
  });
}

// ── GATE: bloqueios ──
test('gate aprova LONG com 5/5', () => {
  assert.deepStrictEqual(s.avaliarGate(base()), { ok: true, direcao: 'LONG', bloqueio: null, condicoes_ok: 5 });
});
test('gate aprova SHORT com 5/5', () => {
  assert.deepStrictEqual(s.avaliarGate(baseShort()), { ok: true, direcao: 'SHORT', bloqueio: null, condicoes_ok: 5 });
});
test('bloqueio: atraso > 3000ms', () => {
  assert.strictEqual(s.avaliarGate(base({ timestamp_dados_ms: AGORA - 3001 })).bloqueio, 'DADOS_ATRASADOS');
  assert.strictEqual(s.avaliarGate(base({ timestamp_dados_ms: AGORA - 3000 })).ok, true);
});
test('bloqueio: campo ausente', () => {
  const d = base(); delete d.vwap;
  const r = s.avaliarGate(d);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.bloqueio, 'CAMPO_INVALIDO');
});
test('bloqueio: campo nulo', () => {
  assert.strictEqual(s.avaliarGate(base({ rvol: null })).bloqueio, 'CAMPO_INVALIDO');
});
test('bloqueio: campo NaN', () => {
  assert.strictEqual(s.avaliarGate(base({ atr_1m_pct: NaN })).bloqueio, 'CAMPO_INVALIDO');
});
test('bloqueio: campo incoerente (taker > 1)', () => {
  assert.strictEqual(s.avaliarGate(base({ taker_buy_ratio_60s: 1.2 })).bloqueio, 'CAMPO_INVALIDO');
});
test('bloqueio: atr_1m_pct < 0.12', () => {
  assert.strictEqual(s.avaliarGate(base({ atr_1m_pct: 0.119 })).bloqueio, 'ATR_BAIXO');
});
test('bloqueio: spread_pct > 0.05', () => {
  assert.strictEqual(s.avaliarGate(base({ spread_pct: 0.051 })).bloqueio, 'SPREAD_ALTO');
});
test('bloqueio: EMAs 5m e 15m em lados diferentes', () => {
  assert.strictEqual(s.avaliarGate(base({ ema9_15m: 98 })).bloqueio, 'EMA_DIVERGENTE');
});

// ── GATE: cada condição LONG falhando sozinha (4 de 5 = NÃO) ──
const casosLong = {
  'fluxo (taker < 0.55)': { taker_buy_ratio_60s: 0.54 },
  'fluxo (cvd <= 0)': { cvd_delta_60s: 0 },
  'book (imbalance < 0.20)': { book_imbalance_10: 0.19 },
  'volume (rvol < 2)': { rvol: 1.99 },
  'vwap (preco <= vwap)': { preco: 100 }
};
for (const [nome, over] of Object.entries(casosLong)) {
  test(`LONG 4/5 = NÃO: ${nome}`, () => {
    const r = s.avaliarGate(base(over));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.direcao, 'NONE');
    assert.strictEqual(r.bloqueio, null); assert.strictEqual(r.condicoes_ok, 4);
  });
}
const casosShort = {
  'fluxo (taker > 0.45)': { taker_buy_ratio_60s: 0.46 },
  'fluxo (cvd >= 0)': { cvd_delta_60s: 0 },
  'book (imbalance > -0.20)': { book_imbalance_10: -0.19 },
  'volume (rvol < 2)': { rvol: 1.5 },
  'vwap (preco >= vwap)': { preco: 100 }
};
for (const [nome, over] of Object.entries(casosShort)) {
  test(`SHORT 4/5 = NÃO: ${nome}`, () => {
    const r = s.avaliarGate(baseShort(over));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.condicoes_ok, 4);
  });
}
// A 5ª condição (tendência) só falha sozinha com EMAs divergentes, que já é bloqueio.
test('tendência contra o fluxo: fluxo LONG com EMAs de baixa = NÃO', () => {
  const r = s.avaliarGate(base({ ema9_5m: 98, ema21_5m: 100, ema9_15m: 97, ema21_15m: 99 }));
  assert.strictEqual(r.ok, false); assert.strictEqual(r.condicoes_ok, 4);
});

// ── CÁLCULO DOS CAMPOS ──
test('ema com seed SMA', () => {
  quase(s.ema([1, 2, 3, 4], 2), 3.5);
  assert.strictEqual(s.ema([1, 2], 3), null);
});
test('atr_1m_pct (Wilder) com klines fixas', () => {
  const ks = []; for (let i = 0; i < 20; i++) ks.push(k(i * 60000, 100, 101, 99, 100, 10));
  quase(s.atrPct(ks), 2);
  assert.strictEqual(s.atrPct(ks.slice(0, 14)), null);
});
test('rvol = último fechado / média dos 20 anteriores', () => {
  const ks = []; for (let i = 0; i < 25; i++) ks.push(k(i * 60000, 1, 1, 1, 1, 10));
  ks.push(k(25 * 60000, 1, 1, 1, 1, 30));
  quase(s.rvol(ks), 3);
  assert.strictEqual(s.rvol(ks.slice(0, 20)), null);
});
test('vwap da sessão reinicia 00:00 UTC', () => {
  const dia = Math.floor(AGORA / 86400000) * 86400000;
  const ks = [k(dia - 60000, 500, 500, 500, 500, 1000), k(dia, 100, 100, 100, 100, 1), k(dia + 60000, 103, 103, 103, 103, 2)];
  quase(s.vwapSessao(ks, dia + 130000), 102);
  assert.strictEqual(s.vwapSessao([ks[0]], dia + 1000), null);
});
test('fluxo 60s: taker ratio e CVD (m=true = venda agressiva)', () => {
  const tr = [{ T: AGORA - 70000, q: 100, m: false }, { T: AGORA - 1000, q: 3, m: false }, { T: AGORA - 500, q: 1, m: true }];
  const f = s.fluxo60s(tr, AGORA);
  quase(f.taker_buy_ratio_60s, 0.75); quase(f.cvd_delta_60s, 2);
  assert.strictEqual(s.fluxo60s([], AGORA).taker_buy_ratio_60s, null);
});
test('book imbalance 10 níveis e slippage', () => {
  const book = { bids: [['99', '3']], asks: [['100', '1'], ['101', '1']] };
  quase(s.bookImbalance(book), 0.2); // (3 - 2) / (3 + 2)
  quase(s.slippageEstimadoPct(book, 'BUY', 150), ((150 / (1 + 50 / 101) - 100) / 100) * 100, 1e-9);
  assert.strictEqual(s.slippageEstimadoPct(book, 'BUY', 1000), null); // book raso
});
test('montarDados: campos completos com feed cheio; buffer incompleto anula fluxo', () => {
  const ks1 = []; for (let i = 0; i < 40; i++) ks1.push(k(AGORA - (40 - i) * 60000, 100, 101, 99, 100, i === 39 ? 50 : 10));
  const ks5 = []; for (let i = 0; i < 30; i++) ks5.push(k(AGORA - (30 - i) * 300000, 100, 100, 100, 100 + i, 1));
  const snap = {
    trades: [{ T: AGORA - 100, p: 100.5, q: 2, m: false }], book: { bids: [['100.4', '5']], asks: [['100.5', '1']] },
    tsTrade: AGORA - 100, tsBook: AGORA - 50, bufferCompleto: true
  };
  const { dados } = s.montarDados('ETHUSDT', { k1m: ks1, k5m: ks5, k15m: ks5, snap, agora: AGORA });
  for (const c of ['preco', 'taker_buy_ratio_60s', 'cvd_delta_60s', 'book_imbalance_10', 'rvol', 'ema9_5m', 'ema21_5m', 'atr_1m_pct', 'spread_pct']) {
    assert(Number.isFinite(dados[c]), c);
  }
  assert.strictEqual(dados.timestamp_dados_ms, AGORA - 100);
  quase(dados.rvol, 5);
  assert(dados.ema9_5m > dados.ema21_5m);
  const r2 = s.montarDados('ETHUSDT', { k1m: ks1, k5m: ks5, k15m: ks5, snap: { ...snap, bufferCompleto: false }, agora: AGORA });
  assert.strictEqual(r2.dados.taker_buy_ratio_60s, null);
  assert.strictEqual(s.avaliarGate(r2.dados).bloqueio, 'CAMPO_INVALIDO');
});
test('calcularPnl: taxa 0,05% por lado + slippage', () => {
  const p = s.calcularPnl({ lado: 'SHORT', qty: 1, entrada: 100, saida: 99, slipEntradaPct: 0.01, slipSaidaPct: 0.01 });
  quase(p.bruto, 1); quase(p.taxas, 0.0995); quase(p.slippage, 0.0199); quase(p.liquido, 1 - 0.0995 - 0.0199);
});

// ── VETO GEMINI (mock) ──
const OPTS = { apiKey: 'x', systemPrompt: 'p' };
const resp = (content) => async () => ({ data: { choices: [{ message: { content } }] } });
test('gemini aprova com JSON válido e mesma direção', async () => {
  const r = await s.vetoGemini(base(), 'LONG', { ...OPTS, post: resp('{"entrar":true,"direcao":"LONG","condicoes_ok":5,"bloqueio":null,"motivo":"ok"}') });
  assert.strictEqual(r.aprovado, true);
});
test('gemini timeout = NÃO entra', async () => {
  const r = await s.vetoGemini(base(), 'LONG', { ...OPTS, timeoutMs: 50, post: () => new Promise(() => {}) });
  assert.strictEqual(r.aprovado, false); assert.strictEqual(r.motivo, 'TIMEOUT');
});
test('gemini JSON inválido = NÃO entra', async () => {
  const r = await s.vetoGemini(base(), 'LONG', { ...OPTS, post: resp('claro! {entrar: sim}') });
  assert.strictEqual(r.aprovado, false); assert.strictEqual(r.motivo, 'JSON_INVALIDO');
});
test('gemini direção divergente = NÃO entra', async () => {
  const r = await s.vetoGemini(base(), 'LONG', { ...OPTS, post: resp('{"entrar":true,"direcao":"SHORT"}') });
  assert.strictEqual(r.motivo, 'DIRECAO_DIVERGENTE');
});
test('gemini erro HTTP e sem chave = NÃO entra', async () => {
  const r = await s.vetoGemini(base(), 'LONG', { ...OPTS, post: async () => { throw new Error('ECONNREFUSED'); } });
  assert.strictEqual(r.aprovado, false);
  assert.strictEqual((await s.vetoGemini(base(), 'LONG', { systemPrompt: 'p' })).motivo, 'SEM_ROUTER_API_KEY');
});
test('gemini envia system prompt e JSON de entrada', async () => {
  let enviado;
  await s.vetoGemini(base(), 'LONG', { ...OPTS, post: async (url, body) => { enviado = { url, body }; return { data: {} }; } });
  assert.strictEqual(enviado.url, 'http://127.0.0.1:20128/v1/chat/completions');
  assert.strictEqual(enviado.body.model, 'ag/gemini-3.8-flash-low');
  assert.strictEqual(enviado.body.messages[0].role, 'system');
  assert.deepStrictEqual(JSON.parse(enviado.body.messages[1].content), base());
});
test('contador de veto: alerta > 90% só com amostra >= 10', () => {
  const c = s.criarContadorVeto();
  for (let i = 0; i < 9; i++) c.registrar(false);
  assert.strictEqual(c.resumo().alerta, false);
  assert.strictEqual(c.registrar(false).alerta, true);
  c.registrar(true); c.registrar(true);
  assert.strictEqual(c.resumo().alerta, false); // 10/12 = 83%
});

// ── MOTOR (mocks, sem rede) ──
// Universo dos testes do motor: injetado como lista dinâmica já carregada (não há mais lista fixa no módulo).
const UNIVERSO_TESTE = ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
function montarMotor(over = {}) {
  const dir = over.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'scalp1m-'));
  const chamadas = [];
  let relogio = over.agora || AGORA;
  const localAlvos = {};
  const desfechos = [];
  const ordens = {}; // orderId -> ordem limite enviada (consulta padrão: FILLED no preço/qty pedidos)
  let nOrd = 0;
  const fut = {
    posicao: over.posicao || (async () => over.pos === undefined ? null : over.pos),
    garantirAlavancagem: async () => chamadas.push('alav'),
    livroOfertas: over.livroOfertas || (async () => ({ bids: [['100', '10']], asks: [['100.1', '10']] })),
    calcularQuantidade: () => ({ ok: true, qty: 0.5 }),
    simbolos: over.futSimbolos || (() => ['ETHUSDT']),
    colocarLimite: over.colocarLimite || (async (sym, lado, qty, preco, opts = {}) => {
      chamadas.push(`limite ${lado} ${qty} ${preco}${opts.reduceOnly ? ' RO' : ''} ${opts.timeInForce || 'GTC'}`);
      const id = ++nOrd; ordens[id] = { sym, lado, qty, preco, opts };
      return { orderId: id, status: 'NEW', executedQty: '0' };
    }),
    consultarOrdem: over.consultarOrdem || (async (sym, id) => ({ orderId: id, status: 'FILLED', executedQty: String(ordens[id].qty), avgPrice: String(ordens[id].preco) })),
    cancelarOrdem: over.cancelarOrdem || (async (sym, id) => chamadas.push(`cancelOrd ${id}`)),
    filtrosDe: over.filtrosDe || (() => ({ minQty: 0.001 })),
    colocarStopLoss: over.colocarStopLoss || (async (sym, lado, p) => chamadas.push(`sl ${lado} ${p.toFixed(4)}`)),
    fecharMercado: over.fecharMercado || (async (sym, lado) => { chamadas.push(`fechar ${lado}`); return { avgPrice: '100.3' }; }),
    abrirMercado: over.abrirMercado || (async (sym, lado, q) => { chamadas.push(`market ${lado} ${q}`); return { avgPrice: '100.2', executedQty: String(q) }; }),
    cancelarTodasOrdens: over.cancelarTodasOrdens || (async () => chamadas.push('cancelar')),
    tickerPreco: over.tickerPreco || (async () => ({ price: over.preco || '100.2' })),
    openAlgoOrdens: over.openAlgoOrdens // ausente = consulta falha (rearme do stop adiado)
  };
  const feed = over.feed || { iniciar: () => chamadas.push('feed on'), parar: () => {}, ativo: () => false, snapshot: () => null };
  const closing = new Set();
  const m = s.criarMotor({
    fut, feed, rest: over.rest || { klines: async () => [] }, localAlvos, salvarAlvos: () => {}, closingInProgress: closing,
    simboloOcupadoPsar: () => false, registrarDesfechoTrade: (...a) => desfechos.push(a), rag: null,
    configFile: path.join(dir, 'cfg.json'), logFile: path.join(dir, 'log.jsonl'), systemPrompt: 'p', routerKey: 'x',
    agora: () => relogio, dormir: async (ms) => { relogio += ms; },
    jevKey: over.jevKey, jevUrl: over.jevUrl, postJev: over.postJev, jevTimeoutMs: over.jevTimeoutMs, // sem chave (padrão): vale a direção do código
    baseOrdens: over.baseOrdens === undefined ? 'https://testnet.binancefuture.com' : over.baseOrdens,
    // universo injetado (lista dinâmica já carregada); null = boot sem lista (ranking real via rest mock)
    universoInicial: over.universoInicial === undefined ? UNIVERSO_TESTE : over.universoInicial,
    filtroTestnet: over.filtroTestnet,
    controlePeso: over.controlePeso === undefined ? null : over.controlePeso, // null = sem fila de peso (sem timers reais)
    whitelist: over.whitelist === undefined ? null : over.whitelist // testes usam símbolos próprios; a whitelist real é coberta em sniper2m
  });
  return { m, chamadas, localAlvos, desfechos, dir, closing, ordens, agora: () => relogio, avancar: (ms) => { relogio += ms; } };
}
test('flag OFF por padrão: tick não avalia nada', async () => {
  const t = montarMotor();
  assert.strictEqual(t.m.status().enabled, false);
  await t.m.tick();
  assert.deepStrictEqual(t.chamadas, []);
});
test('flag persiste em .auto_bot_config.json sem apagar enabled do PSAR', () => {
  const t = montarMotor();
  const cfg = path.join(t.dir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ enabled: true }));
  s.salvarFlag(cfg, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { enabled: true, SCALP_1M_ENABLED: true });
  assert.strictEqual(s.lerFlag(cfg), true);
});
test.skip('turno: candles com erro geram DECISAO com bloqueio duro e TURNO vazio (motivo real) no JSONL', async () => {
  const t = montarMotor({ agora: AGORA - (AGORA % 300000) + 2000 });
  t.m._estado.enabled = true;
  await t.m.tick();
  const linhas = fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(linhas.length, 5); // 4 símbolos (BTCUSDT fora) + 1 TURNO
  const dec = linhas.filter(l => l.tipo === 'DECISAO');
  assert.strictEqual(dec.length, 4);
  assert(dec.every(l => l.gate.ok === false && l.gate.bloqueio === 'CAMPO_INVALIDO'));
  assert(dec.every(l => l.bloqueio_duro === 'CAMPO_INVALIDO' && l.acao === 'BLOQUEADA'));
  const turnoId = new Date(AGORA - (AGORA % 300000)).toISOString();
  assert(linhas.every(l => l.turno_id === turnoId));
  const tu = linhas.find(l => l.tipo === 'TURNO');
  assert.strictEqual(tu.status, 'VAZIO'); assert.strictEqual(tu.motivo, 'SEM_CANDIDATA_VALIDA');
  assert.deepStrictEqual(tu.bloqueios, { ETHUSDT: 'CAMPO_INVALIDO', SOLUSDT: 'CAMPO_INVALIDO', BNBUSDT: 'CAMPO_INVALIDO', XRPUSDT: 'CAMPO_INVALIDO' });
  // fora da fronteira de 5 min (minuto seguinte = ANÁLISE): não grava decisão nova
  t.avancar(60000); await t.m.tick();
  assert.strictEqual(fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf8').trim().split('\n').length, 5);
});
test.skip('saída a Market aos 60s com exitReason SCALP_TEMPO_60S e linha TRADE', async () => {
  const t = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 } });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = { modo: 'scalp_1m', side: 'LONG', entryPrice: 100.1, slPrice: 99.8, quantidade: 0.5, openTime: AGORA, entrada: { precoMainnet: 100, slipMainnetPct: 0 } };
  await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  assert.deepStrictEqual(t.chamadas, []); // < 60s
  t.avancar(HOLD);
  await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  assert.deepStrictEqual(t.chamadas, ['cancelar', 'fechar LONG']);
  assert.strictEqual(t.desfechos[0][1], 'SCALP_TEMPO_60S');
  assert.strictEqual(t.localAlvos.ETHUSDT, undefined);
  assert.strictEqual(t.m._estado.slots[3].symbol, null);
  const tr = JSON.parse(fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf8').trim());
  assert.strictEqual(tr.tipo, 'TRADE'); quase(tr.pnl_testnet.bruto, 0.1, 1e-9);
});
test.skip('stop de emergência pelo monitor: SCALP_SL_EMERG', async () => {
  const t = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 99 }, preco: '99.7' });
  t.m._estado.slots[4] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = { modo: 'scalp_1m', side: 'LONG', entryPrice: 100, slPrice: 99.7, quantidade: 0.5, openTime: AGORA };
  await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  assert.strictEqual(t.desfechos[0][1], 'SCALP_SL_EMERG');
});
test('#4 posição sumiu da corretora: SCALP_DESCONHECIDO, fora do placar, pnl nulo', async () => {
  const t = montarMotor({ pos: null });
  t.m._estado.slots[3] = { symbol: 'SOLUSDT', side: 'SHORT', status: 'x', openTime: AGORA };
  t.localAlvos.SOLUSDT = { modo: 'scalp_1m', side: 'SHORT', entryPrice: 100, slPrice: 100.3, quantidade: 1, openTime: AGORA };
  await t.m.monitorarPosicao('SOLUSDT', t.localAlvos.SOLUSDT);
  assert.strictEqual(t.desfechos.length, 0); // registrarDesfechoTrade não chamado
  const tr = fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.saida_motivo, 'SCALP_DESCONHECIDO');
  assert.strictEqual(tr.pnl_testnet, null); assert.strictEqual(tr.pnl_mainnet, null); assert.strictEqual(tr.roi_testnet_pct, null);
  assert.strictEqual(t.localAlvos.SOLUSDT, undefined); assert.strictEqual(t.m._estado.slots[3].symbol, null);
});

// ── CORREÇÕES 1-11 ──
// Ciclo com gate 5/5 e Gemini aprovando: leva o motor até entrar().
function cicloAprovado(over = {}) {
  const t0 = AGORA - (AGORA % 300000) + 2000; // fronteira de turno (5 min) + 2 s
  const ks1 = []; for (let i = 0; i < 40; i++) ks1.push(k(t0 - (40 - i) * 60000 - 2000, 100, 101, 99, 100, i === 39 ? 50 : 10));
  const ks5 = []; for (let i = 0; i < 30; i++) ks5.push(k(t0 - (30 - i) * 300000 - 2000, 100, 100, 100, 90 + i, 1));
  const snap = { trades: [{ T: t0 - 100, p: 110, q: 3, m: false }], book: { bids: [['109.99', '9']], asks: [['110', '1']] }, tsTrade: t0 - 100, tsBook: t0 - 50, bufferCompleto: true };
  const feed = { iniciar: () => {}, parar: () => {}, ativo: () => true, snapshot: (sym) => sym === 'ETHUSDT' ? snap : null };
  return montarMotor({
    agora: t0, feed, rest: { klines: async (sym, tf) => (tf === '1m' ? ks1 : ks5) },
    postGemini: resp('{"entrar":true,"direcao":"LONG","condicoes_ok":5,"bloqueio":null,"motivo":"ok"}'), ...over
  });
}
test('#1 trava testnet: definirEnabled recusa base mainnet com erro claro', () => {
  assert.strictEqual(s.ehTestnet('https://testnet.binancefuture.com'), true);
  assert.strictEqual(s.ehTestnet('https://fapi.binance.com'), false);
  assert.strictEqual(s.ehTestnet('https://testnet.binancefuture.com/fapi/v1'), true);
  for (const ruim of ['https://fapi.binance.com/testnet', 'https://testnet.binancefuture.com.evil.com', 'https://evil.com/testnet.binancefuture.com',
    'https://notestnet.binancefuture.com', 'testnet.binancefuture.com', 'https://testnet.binancefuture.com@evil.com', 'ftp://testnet.binancefuture.com',
    'https://fapi.binance.com?x=testnet.binancefuture.com', '', null, 'https://my-testnet.example.com']) assert.strictEqual(s.ehTestnet(ruim), false, String(ruim));
  assert.strictEqual(s.ehTestnet(undefined), false);
  const t = montarMotor({ baseOrdens: 'https://fapi.binance.com' });
  assert.throws(() => t.m.definirEnabled(true), /não é testnet/);
  assert.strictEqual(t.m.status().enabled, false);
  assert.strictEqual(fs.existsSync(path.join(t.dir, 'cfg.json')), false); // flag não persistida
  assert.strictEqual(t.m.definirEnabled(false), false); // desligar sempre pode
});
test('#1 trava testnet: tick com flag ON em mainnet não avalia nem ordena', async () => {
  const t = cicloAprovado({ baseOrdens: 'https://fapi.binance.com' });
  t.m._estado.enabled = true;
  await t.m.tick();
  assert.strictEqual(t.m._estado.enabled, false);
  assert.deepStrictEqual(t.chamadas, []);
  assert.strictEqual(fs.existsSync(path.join(t.dir, 'log.jsonl')), false);
});
test.skip('#2 stop falhou 3x: fecha a Market já e grava TRADE SCALP_SL_FALHOU', async () => {
  let tent = 0;
  const t = cicloAprovado({ colocarStopLoss: async () => { tent++; throw new Error('rejeitado'); } });
  t.m._estado.enabled = true;
  await t.m.tick();
  assert.strictEqual(tent, 3);
  assert.deepStrictEqual(t.chamadas, ['alav', 'limite BUY 0.5 100 GTX', 'cancelar', 'fechar LONG']);
  assert.strictEqual(t.localAlvos.ETHUSDT, undefined);
  assert.strictEqual(t.m._estado.slots[3].symbol, null);
  assert.strictEqual(t.desfechos[0][1], 'SCALP_SL_FALHOU');
  const linhas = fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const tr = linhas.find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.saida_motivo, 'SCALP_SL_FALHOU'); quase(tr.saida.testnet, 100.3);
  const dec = linhas.find(l => l.tipo === 'DECISAO' && l.simbolo === 'ETHUSDT');
  assert.strictEqual(dec.motivo, 'SL_FALHOU_3X_FECHADA_MARKET');
});
test.skip('#3 preço ausente: erro logado, sem SL falso, saída de 60s ocorre', async () => {
  const t = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: null }, tickerPreco: async () => { throw new Error('timeout'); } });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = { modo: 'scalp_1m', side: 'LONG', entryPrice: 100.1, slPrice: 99.8, quantidade: 0.5, openTime: AGORA };
  const erros = []; const orig = console.error; console.error = (...a) => erros.push(a.join(' '));
  try {
    await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
    assert.deepStrictEqual(t.chamadas, []); // < 60s e sem preço: não dispara SL falso
    t.avancar(HOLD);
    await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  } finally { console.error = orig; }
  assert(erros.some(e => e.includes('[SCALP-PRECO] ETHUSDT')));
  assert.deepStrictEqual(t.chamadas, ['cancelar', 'fechar LONG']);
  assert.strictEqual(t.desfechos[0][1], 'SCALP_TEMPO_60S');
});
test('#5 monitor próprio: monitorarTodas com guarda de reentrância', async () => {
  let chamadasPos = 0, soltar;
  const trava = new Promise(r => { soltar = r; });
  const t = montarMotor({ posicao: async () => { chamadasPos++; await trava; return { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }; } });
  t.localAlvos.ETHUSDT = { modo: 'scalp_1m', side: 'LONG', entryPrice: 100.1, slPrice: 99.8, quantidade: 0.5, openTime: AGORA };
  t.localAlvos.ADAUSDT = { modo: 'sar', side: 'LONG' }; // PSAR: o monitor scalp ignora
  const a = t.m.monitorarTodas(); const b = t.m.monitorarTodas();
  soltar(); await Promise.all([a, b]);
  assert.strictEqual(chamadasPos, 1);
  assert.strictEqual(t.m._estado.monitorando, false);
});
test('#5 painel: loop PSAR só pula scalp_1m (não chama o monitor scalp)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'painel_futuros.js'), 'utf8');
  assert(!src.includes('scalp1m.monitorarPosicao('));
  assert(src.includes("if (alvo.modo === 'scalp_1m') continue;"));
});
test('#6 boot: scalp órfão sem cooldown 45 min; PSAR mantém', () => {
  assert.deepStrictEqual(s.limpezaBoot({ modo: 'scalp_1m' }, false), { exitReason: 'SCALP_BOOT_CLEANUP', cooldownMs: 0 });
  assert.deepStrictEqual(s.limpezaBoot({ modo: 'sar' }, false), { exitReason: 'BOOT_CLEANUP', cooldownMs: 2700000 });
  assert.deepStrictEqual(s.limpezaBoot(undefined, true), { exitReason: 'SL_FUNIL_TEMPO', cooldownMs: 2700000 });
});
test('#7 motivo do Gemini truncado em 300 caracteres', async () => {
  const longo = 'x'.repeat(1000);
  const r = await s.vetoGemini(base(), 'LONG', { ...OPTS, post: resp(JSON.stringify({ entrar: true, direcao: 'LONG', motivo: longo })) });
  assert.strictEqual(r.aprovado, true); assert.strictEqual(r.resposta.motivo.length, s.MOTIVO_MAX);
  assert.strictEqual(s.MOTIVO_MAX, 300);
  const e = await s.vetoGemini(base(), 'LONG', { ...OPTS, post: async () => { throw new Error(longo); } });
  assert(e.motivo.length <= 300);
});
test('#8 (adaptado: universo dinâmico) sem lista fixa; BTC/ETH/BNB/XRP em EXCLUIDOS', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scalp1m.js'), 'utf8');
  assert(!/const\s+SIMBOLOS\s*=\s*\[/.test(src), 'lista fixa SIMBOLOS voltou');
  assert(!/\bSIMBOLOS\b/.test(src));
  assert.strictEqual(s.SIMBOLOS, undefined);
  assert.deepStrictEqual(s.EXCLUIDOS, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT']);
  assert(!SRC_PAINEL().includes('scalpLib.SIMBOLOS'));
});
test('#10 painel sem ACESSO_SENHA: falha explícita no boot', () => {
  const { spawnSync } = require('child_process');
  const env = { ...process.env, ACESSO_SENHA: '', BINANCE_API_KEY: '', BINANCE_SECRET: '', ROUTER_API_KEY: '', JEV_API_KEY: '', FUTURES_BASE: 'http://127.0.0.1:9', PORT: '0' };
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'painel_futuros.js')], { env, timeout: 15000, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert(r.stderr.includes('ACESSO_SENHA ausente'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'painel_futuros.js'), 'utf8');
  assert(!/ACESSO_SENHA\s*\|\|/.test(src)); // sem senha padrão literal
});
test.skip('#11 ATR baixo (0,10%): toda moeda vai ao JSONL com atr_1m_pct e contagem; ATR baixo não invalida: as 2 primeiras entram', async () => {
  const t0 = AGORA - (AGORA % 60000) + 2000;
  const ks1 = []; for (let i = 0; i < 40; i++) ks1.push(k(t0 - (40 - i) * 60000 - 2000, 100, 100.05, 99.95, 100, 10)); // ATR 0,10%
  const ks5 = []; for (let i = 0; i < 30; i++) ks5.push(k(t0 - (30 - i) * 300000 - 2000, 100, 100, 100, 90 + i, 1));
  const snap = { trades: [{ T: t0 - 100, p: 100, q: 1, m: false }], book: { bids: [['99.99', '1']], asks: [['100', '1']] }, tsTrade: t0 - 100, tsBook: t0 - 50, bufferCompleto: true };
  const feed = { iniciar: () => {}, parar: () => {}, ativo: () => true, snapshot: () => snap };
  const t = montarMotor({ agora: t0, feed, rest: { klines: async (sym, tf) => (tf === '1m' ? ks1 : ks5) } });
  t.m._estado.enabled = true;
  await capturarErros(() => t.m.tick());
  const todas = fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const linhas = todas.filter(l => l.tipo === 'DECISAO');
  assert.strictEqual(linhas.length, 4); // toda moeda entra no JSONL
  const turnoId = new Date(t0 - (t0 % 300000)).toISOString();
  assert(linhas.every(l => l.gate.bloqueio === 'ATR_BAIXO' && l.bloqueio_duro === null && l.passou_gate_antigo === false && l.turno_id === turnoId));
  assert.deepStrictEqual(linhas.map(l => l.acao), ['ENTROU', 'ENTROU', 'NAO_ESCOLHIDA', 'NAO_ESCOLHIDA']);
  assert(t.chamadas.length > 0); // as 2 entram mesmo com ATR baixo
  assert(!todas.some(l => l.tipo === 'TURNO' && l.status === 'VAZIO'));
  assert(!t.m.status().hoje.top3Bloqueios.some(b => b.motivo === 'ATR_BAIXO')); // o gate antigo continua só informação
  assert(linhas.every(l => l.atr_baixo.atr_1m_pct < 0.15 && l.atr_baixo.atr_1m_pct === l.dados.atr_1m_pct && l.atr_baixo.atr_min_pct === 0.15));
  assert.deepStrictEqual(linhas.map(l => l.atr_baixo.contagem_total), [1, 2, 3, 4]);
  assert.strictEqual(t.m.status().atrBaixo.total, 4);
});
test('frescor: WS vivo com book recente não é DADOS_ATRASADOS só porque a moeda ficou > 3 s sem trade', () => {
  const agora = AGORA;
  const snap = (over) => ({ trades: [{ T: agora - 9000, p: 100, q: 1, m: false }], book: { bids: [['99.99', '1']], asks: [['100', '1']] }, tsTrade: agora - 9000, tsBook: agora - 100, bufferCompleto: true, ...over });
  assert.strictEqual(s.montarDados('XUSDT', { k1m: [], k5m: [], k15m: [], snap: snap({ wsVivo: true }), agora }).dados.timestamp_dados_ms, agora - 100);
  assert.strictEqual(s.montarDados('XUSDT', { k1m: [], k5m: [], k15m: [], snap: snap({ wsVivo: false }), agora }).dados.timestamp_dados_ms, agora - 9000);
});
test('script de expectativa separa Jev = código x Jev ≠ código e diz quem acertou nas divergências', () => {
  const tr = (dj, dc, liq, extra = {}) => ({ tipo: 'TRADE', saida_motivo: 'X', direcao_jev: dj, direcao_codigo: dc, pnl_testnet: { liquido: liq }, pnl_mainnet: null, jev_latencia_ms: 1000, ...extra });
  const r = resumir([tr('LONG', 'LONG', 0.2), tr('SHORT', 'SHORT', -0.1), tr('SHORT', 'LONG', 0.3), tr('LONG', 'SHORT', -0.2), tr(null, 'LONG', 0.1, { jev_timeout: true })]);
  assert.strictEqual(r.porJev.igual.n, 2); assert.strictEqual(r.porJev.igual.winRate, 0.5);
  assert.strictEqual(r.porJev.diferente.n, 2); assert.strictEqual(r.porJev.diferente.winRate, 0.5);
  assert.deepStrictEqual(r.porJev.divergencia, { n: 2, jevAcertou: 1, codigoAcertou: 1 });
  assert.strictEqual(r.porJev.timeouts, 1); assert.strictEqual(r.porJev.semOpiniaoJev, 1); assert.strictEqual(r.porJev.latenciaMediaMs, 1000);
});
test('script de expectativa soma PnL líquido', () => {
  const r = resumir([
    { tipo: 'DECISAO', gate: { ok: false, bloqueio: 'ATR_BAIXO' }, acao: 'NENHUMA' },
    { tipo: 'TRADE', saida_motivo: 'SCALP_TEMPO_60S', pnl_testnet: { liquido: 0.2 }, pnl_mainnet: { liquido: 0.1 } },
    { tipo: 'TRADE', saida_motivo: 'SCALP_SL_EMERG', pnl_testnet: { liquido: -0.4 }, pnl_mainnet: null }
  ]);
  assert.strictEqual(r.trades, 2);
  quase(r.testnet.expectativa, -0.1); quase(r.mainnet.soma, 0.1);
  assert.strictEqual(r.decisoes.bloqueios.ATR_BAIXO, 1);
});

// ── RODADA 2 (reauditoria) ──
const ALVO_ETH = () => ({ modo: 'scalp_1m', side: 'LONG', entryPrice: 100.1, slPrice: 99.8, quantidade: 0.5, openTime: AGORA, entrada: { precoMainnet: 100, slipMainnetPct: 0 } });
const lerJsonl = (t) => fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const capturarErros = async (fn) => {
  const erros = []; const orig = console.error; console.error = (...a) => erros.push(a.join(' '));
  try { await fn(); } finally { console.error = orig; }
  return erros;
};
test('R2#1 trava testnet no monitor: base mainnet não fecha nem cancela e desliga o motor', async () => {
  const t = montarMotor({ baseOrdens: 'https://fapi.binance.com', pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 } });
  t.m._estado.enabled = true;
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = ALVO_ETH();
  t.avancar(120000);
  const erros = await capturarErros(async () => {
    await t.m.monitorarTodas();
    await t.m.monitorarTodas();
  });
  assert.deepStrictEqual(t.chamadas, []);
  assert.strictEqual(t.m._estado.enabled, false);
  assert.strictEqual(erros.filter(e => e.includes('não é testnet')).length, 1); // log sem spam
  assert(t.localAlvos.ETHUSDT);
  // posição sumida também não cancela ordens fora do testnet
  const t2 = montarMotor({ baseOrdens: 'https://fapi.binance.com', pos: null });
  t2.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t2.localAlvos.ETHUSDT = ALVO_ETH();
  await capturarErros(() => t2.m.monitorarPosicao('ETHUSDT', t2.localAlvos.ETHUSDT));
  assert.deepStrictEqual(t2.chamadas, []);
});
test('R2#2 (adaptado) painel boot: trava testnet no ramo scalp e no ramo genérico, antes de qualquer ordem', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'painel_futuros.js'), 'utf8');
  const b = src.slice(src.indexOf('const scalpBoot = new Set();'), src.indexOf('// Posições remanescentes válidas'));
  const iScalp = b.indexOf("if (alvoExistente?.modo === 'scalp_1m') {");
  const iTravaS = b.indexOf('if (!scalpLib.ehTestnet(fut.FAPI))', iScalp);
  const iGen = b.indexOf("if (p.symbol === 'MUSDT' || !WHITELIST_VIP.has(p.symbol) || isZombieQNT) {");
  const iTravaG = b.indexOf('if (!scalpLib.ehTestnet(fut.FAPI))', iGen);
  assert(iScalp > 0 && iScalp < iTravaS && iTravaS < iGen && iGen < iTravaG);
  assert(iTravaS < b.indexOf('scalp1m.garantirStopOrfa('));
  assert(iTravaG < b.indexOf('[BOOT-LIMPEZA-ZUMBI] Encerrando') && iTravaG < b.indexOf('fut.cancelarTodasOrdens(p.symbol)') && iTravaG < b.indexOf('fut.fecharMercado(p.symbol'));
  assert(/fechamento\/cancelamento não enviado`\);\s*continue;/.test(b.slice(iTravaG)));
});
test('R2#3 monitor reconfere closingInProgress/alvo após cada await', async () => {
  let t;
  t = montarMotor({ posicao: async () => { t.closing.add('ETHUSDT'); return { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }; } });
  t.localAlvos.ETHUSDT = ALVO_ETH(); t.avancar(HOLD);
  await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  assert.deepStrictEqual(t.chamadas, []); // /api/close assumiu durante posicao()
  let t2;
  t2 = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, tickerPreco: async () => { delete t2.localAlvos.ETHUSDT; return { price: '100.2' }; } });
  const a2 = ALVO_ETH(); t2.localAlvos.ETHUSDT = a2; t2.avancar(HOLD);
  await t2.m.monitorarPosicao('ETHUSDT', a2);
  assert.deepStrictEqual(t2.chamadas, []); // alvo removido durante tickerPreco()
  assert.strictEqual(t2.desfechos.length, 0);
});
test.skip('R2#4 SL: monitor bloqueado durante tentativas; fechamento externo assume sem duplicar', async () => {
  let t, fechandoNoSl = null, monitorPos = 0;
  t = cicloAprovado({
    colocarStopLoss: async () => { fechandoNoSl = t.localAlvos.ETHUSDT.fechando; await t.m.monitorarTodas(); throw new Error('rejeitado'); },
    posicao: async () => { monitorPos++; return null; }
  });
  t.m._estado.enabled = true;
  await t.m.tick();
  assert.strictEqual(fechandoNoSl, true);
  assert.strictEqual(monitorPos, 1); // só a checagem de entrada; o monitor não leu posição
  // Com /api/close em curso: o SL-falhou não envia fechamento
  let t3;
  t3 = cicloAprovado({ colocarStopLoss: async () => { t3.closing.add('ETHUSDT'); throw new Error('rejeitado'); } });
  t3.m._estado.enabled = true;
  await t3.m.tick();
  assert.deepStrictEqual(t3.chamadas, ['alav', 'limite BUY 0.5 100 GTX']);
  const dec = lerJsonl(t3).find(l => l.tipo === 'DECISAO' && l.simbolo === 'ETHUSDT');
  assert.strictEqual(dec.motivo, 'FECHAMENTO_EXTERNO_EM_CURSO');
  assert.strictEqual(t3.localAlvos.ETHUSDT.fechando, false);
});
test.skip('R2#4b SL aceito: fechando volta a false e o monitor assume', async () => {
  let t, fechandoNoSl = null;
  t = cicloAprovado({ colocarStopLoss: async () => { fechandoNoSl = t.localAlvos.ETHUSDT.fechando; } });
  t.m._estado.enabled = true;
  await t.m.tick();
  assert.strictEqual(fechandoNoSl, true);
  assert.strictEqual(t.localAlvos.ETHUSDT.fechando, false);
  assert.strictEqual(t.localAlvos.ETHUSDT.slNaCorretora, true);
});
test('R2#5 painel /api/close: scalp grava SCALP_MANUAL sem cooldown 45 min; PSAR mantém MANUAL_CLOSE', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'painel_futuros.js'), 'utf8');
  const i = src.indexOf("app.post('/api/close'");
  const bloco = src.slice(i, src.indexOf("app.post('/api/tp-sl'"));
  assert(bloco.includes("const motivoClose = ehScalp ? 'SCALP_MANUAL' : 'MANUAL_CLOSE'"));
  assert(bloco.includes('registrarDesfechoTrade(symbol, motivoClose,'));
  assert(bloco.includes('if (!ehScalp) cooldownMoeda[symbol] = Date.now() + 2700000;'));
  assert(bloco.includes('exitReason: motivoClose'));
  assert(bloco.indexOf('const ehScalp') < bloco.indexOf('await fut.posicao(symbol)'));
  // SCALP_* no placar: sem quarentena 1h
  assert(src.includes("} else if (String(exitReason).startsWith('SCALP_')) {"));
});
test.skip('R2#6 (adaptado p/ fora 1 ciclo) sem cooldown de 120 s: lucro libera ETH para repetir no turno seguinte', async () => {
  assert.strictEqual(s.COOLDOWN_REENTRADA_MS, undefined); // cooldown de 120 s removido
  let cur = AGORA - (AGORA % 300000) + 2000; // feed acompanha o relógio do teste
  const feed = { iniciar: () => {}, parar: () => {}, ativo: () => true, snapshot: (sym) => sym === 'ETHUSDT'
    ? { trades: [{ T: cur - 100, p: 110, q: 3, m: false }], book: { bids: [['109.99', '9']], asks: [['110', '1']] }, tsTrade: cur - 100, tsBook: cur - 50, bufferCompleto: true }
    : null };
  let posAtual = null;
  const t = cicloAprovado({ feed, posicao: async () => posAtual });
  const avancar = (ms) => { t.avancar(ms); cur += ms; };
  const decEth = () => lerJsonl(t).filter(l => l.tipo === 'DECISAO' && l.simbolo === 'ETHUSDT').pop();
  t.m._estado.enabled = true;
  await t.m.tick(); // turno 1: ETH entra
  assert.strictEqual(decEth().acao, 'ENTROU');
  posAtual = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  avancar(HOLD + 1000); await t.m.monitorarTodas(); // Market 100,3 > entrada 100: lucro
  posAtual = null;
  assert(lerJsonl(t).filter(l => l.tipo === 'TRADE').pop().pnl_testnet.liquido > 0);
  assert.strictEqual(lerJsonl(t).filter(l => l.tipo === 'TURNO').pop().status, 'FECHADO');
  assert.deepStrictEqual(t.m.status().fora1Ciclo, []);
  avancar(299500 - (HOLD + 1000)); await t.m.tick(); // turno 2: ETH repete
  assert.strictEqual(decEth().acao, 'ENTROU');
  assert.strictEqual(t.chamadas.filter(c => c.startsWith('limite BUY')).length, 2);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scalp1m.js'), 'utf8');
  assert(!src.includes('cooldownMoeda'));
  assert(!src.includes('COOLDOWN_REENTRADA'));
  assert(!src.includes('REPETIDA_TURNO_ANTERIOR'));
});
test.skip('R2#7 posicao() com erro: loga [SCALP-POSICAO]; após HOLD+10s fecha mesmo assim', async () => {
  const t = montarMotor({ posicao: async () => { throw new Error('timeout'); } });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = ALVO_ETH();
  t.avancar(HOLD + 5000);
  const erros = await capturarErros(() => t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT));
  assert(erros.some(e => e.includes('[SCALP-POSICAO] ETHUSDT: timeout')));
  assert.deepStrictEqual(t.chamadas, []); // 65 s < 70 s
  t.avancar(5000);
  await capturarErros(() => t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT));
  assert.deepStrictEqual(t.chamadas, ['cancelar', 'fechar LONG']);
  assert.strictEqual(t.desfechos[0][1], 'SCALP_TEMPO_60S');
});
test.skip('R2#8 fill desconhecido após enviar a limite: fecha a Market e grava SCALP_ENTRADA_FALHOU', async () => {
  let n = 0, t;
  t = cicloAprovado({
    consultarOrdem: async () => { throw new Error('rede'); }, // consulta sempre falha: fill desconhecido
    posicao: async () => { n++; if (n === 1) return null; return { lado: 'LONG', quantidade: 0.5 }; }
  });
  t.m._estado.enabled = true;
  await capturarErros(() => t.m.tick());
  assert.deepStrictEqual(t.chamadas, ['alav', 'limite BUY 0.5 100 GTX', 'cancelOrd 1', 'cancelar', 'fechar LONG']);
  const linhas = lerJsonl(t);
  const ev = linhas.find(l => l.evento === 'SCALP_ENTRADA_FALHOU');
  assert.strictEqual(ev.tipo, 'EVENTO'); assert.strictEqual(ev.fechada_market, true);
  assert.strictEqual(ev.erro, 'consulta final da limite falhou: fill desconhecido');
  assert.strictEqual(linhas.find(l => l.tipo === 'DECISAO' && l.simbolo === 'ETHUSDT').acao, 'ENTRADA_FALHOU');
  assert.strictEqual(t.m._estado.slots[3].symbol, null);
  assert.strictEqual(t.localAlvos.ETHUSDT, undefined);
  // posição já existente antes do envio: não fecha posição alheia
  const t2 = cicloAprovado({ pos: { lado: 'LONG', quantidade: 1 } });
  t2.m._estado.enabled = true;
  await t2.m.tick();
  assert.deepStrictEqual(t2.chamadas, []);
  assert(!lerJsonl(t2).some(l => l.evento === 'SCALP_ENTRADA_FALHOU'));
});

// ── RODADA 3 ──
const SRC_PAINEL = () => fs.readFileSync(path.join(__dirname, '..', 'painel_futuros.js'), 'utf8');
const SRC_LIB = () => fs.readFileSync(path.join(__dirname, '..', 'lib', 'scalp1m.js'), 'utf8');
const bloco = (src, ini, fim) => { const i = src.indexOf(ini); return src.slice(i, src.indexOf(fim, i)); };
test('R3#1 /api/close scalp: trava testnet do motor antes de qualquer ordem, 400 sem enviar', () => {
  const b = bloco(SRC_PAINEL(), "app.post('/api/close'", "app.post('/api/tp-sl'");
  const iTrava = b.indexOf("if (ehScalp && !scalp1m.travaOk(symbol, 'API_CLOSE'))");
  assert(iTrava > 0);
  assert(b.indexOf('ehScalp = localAlvos[symbol]') < iTrava);
  assert(iTrava < b.indexOf('closingInProgress.add(symbol)'));
  assert(iTrava < b.indexOf('await fut.posicao(symbol)'));
  assert(/return res\.status\(400\)\.json\(\{ success: false/.test(b.slice(iTrava, iTrava + 250)));
  const t = montarMotor({ baseOrdens: 'https://fapi.binance.com' });
  t.m._estado.enabled = true;
  assert.strictEqual(t.m.travaOk('ETHUSDT', 'API_CLOSE'), false);
  assert.strictEqual(t.m._estado.enabled, false);
  assert.deepStrictEqual(t.chamadas, []);
  assert.strictEqual(montarMotor().m.travaOk('ETHUSDT', 'API_CLOSE'), true);
});
test('R3#2 boot: posição scalp_1m fora dos slots PSAR, com alerta [SCALP-BOOT]', () => {
  const src = SRC_PAINEL();
  const f = bloco(src, 'const posValidas =', 'for (let idx = 0; idx < posValidas.length');
  assert(f.includes("!scalpBoot.has(p.symbol) && localAlvos[p.symbol]?.modo !== 'scalp_1m'"));
  assert(f.includes('[SCALP-BOOT] ALERTA'));
  const i = src.indexOf('scalpBoot.add(p.symbol);');
  assert(i > 0 && i < src.indexOf('stop scalp não rearmado')); // marca antes da trava testnet: fica fora do PSAR mesmo sem ordem
});
test.skip('R3#3 fechar falhou após abrir sem alvo: slot ocupado, stop 1x, alvo órfão e SCALP_ORFA; monitor fecha depois', async () => {
  let t, sl = [], falhar = true, n = 0;
  t = cicloAprovado({
    consultarOrdem: async () => { throw new Error('rede'); }, // fill desconhecido após enviar a limite
    posicao: async () => { n++; return n <= 2 ? null : { lado: 'LONG', quantidade: 0.5, precoEntrada: 100.1, precoMarca: 100.2 }; },
    fecharMercado: async (sym, lado) => { t.chamadas.push(`fechar ${lado}`); if (falhar) throw new Error('rede'); return { avgPrice: '100.3' }; },
    colocarStopLoss: async (sym, lado, p) => { sl.push(p); }
  });
  t.m._estado.enabled = true;
  const erros = await capturarErros(() => t.m.tick());
  assert.strictEqual(sl.length, 1); quase(sl[0], 100 * 0.991); // stop órfão sobre o preço da limite (melhor bid); ATR 2% -> teto 0,90%
  const a = t.localAlvos.ETHUSDT;
  assert(a && a.modo === 'scalp_1m' && a.fechando === false && a.orfa === true && a.slNaCorretora === true);
  assert.strictEqual(t.m._estado.slots[3].symbol, 'ETHUSDT');
  assert(erros.some(e => e.includes('[SCALP-ORFA] ETHUSDT')));
  const linhas = lerJsonl(t);
  assert(linhas.some(l => l.tipo === 'EVENTO' && l.evento === 'SCALP_ORFA' && l.slot === 3));
  assert.strictEqual(linhas.find(l => l.tipo === 'DECISAO' && l.simbolo === 'ETHUSDT').acao, 'ENTRADA_FALHOU');
  // monitor: 1º ciclo falha (fica), 2º fecha e libera o slot
  await capturarErros(() => t.m.monitorarTodas());
  assert(t.localAlvos.ETHUSDT && t.localAlvos.ETHUSDT.fechando === false);
  falhar = false;
  await capturarErros(() => t.m.monitorarTodas());
  assert.strictEqual(t.localAlvos.ETHUSDT, undefined);
  assert.strictEqual(t.m._estado.slots[3].symbol, null);
  const tr = lerJsonl(t).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.saida_motivo, 'SCALP_TEMPO_60S'); quase(tr.entrada.testnet, 100.1); quase(tr.pnl_testnet.bruto, 0.1);
});
test('R3#4 watchdog: scalp_1m fora do reset de closingInProgress; /api/close solta trava scalp no erro', () => {
  const src = SRC_PAINEL();
  const w = bloco(src, 'for (const sym of Array.from(closingInProgress))', '12000');
  assert(w.includes("if (localAlvos[sym]?.modo === 'scalp_1m' || Object.values(scalp1m.status().slots).some(s => s.symbol === sym)) continue;"));
  assert(src.includes("if (a && a.modo !== 'scalp_1m' && a.fechando"));
  const b = bloco(src, "app.post('/api/close'", "app.post('/api/tp-sl'");
  assert(b.includes('lockScalp = ehScalp;'));
  assert(/catch \(err\) \{\s*if \(lockScalp\) \{ closingInProgress\.delete\(symbol\); delete closingStartedAt\[symbol\]; \}/.test(b));
});
test('R3#5 SCALP_MANUAL e SCALP_BOOT_CLEANUP: linha TRADE no JSONL (pnl nulo se desconhecido)', () => {
  const t = montarMotor();
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.m.registrarTradeExterno('ETHUSDT', { ...ALVO_ETH(), quantidade: 0.5 }, 'SCALP_MANUAL', 100.3);
  t.m.registrarTradeExterno('SOLUSDT', { side: 'SHORT', entryPrice: 50, quantidade: 1 }, 'SCALP_BOOT_CLEANUP', NaN);
  const [l1, l2] = lerJsonl(t);
  assert.strictEqual(l1.tipo, 'TRADE'); assert.strictEqual(l1.saida_motivo, 'SCALP_MANUAL'); quase(l1.pnl_testnet.bruto, 0.1);
  assert.strictEqual(l2.tipo, 'TRADE'); assert.strictEqual(l2.saida_motivo, 'SCALP_BOOT_CLEANUP');
  assert.strictEqual(l2.pnl_testnet, null); assert.strictEqual(l2.saida.testnet, null); assert.strictEqual(l2.roi_testnet_pct, null);
  assert.strictEqual(t.m._estado.slots[3].symbol, null);
  assert.strictEqual(t.desfechos.length, 0); // placar fica com o painel (sem duplicar)
  const src = SRC_PAINEL();
  const b = bloco(src, "app.post('/api/close'", "app.post('/api/tp-sl'");
  assert(b.includes('if (ehScalp) scalp1m.registrarTradeExterno(symbol,'));
  assert(!src.includes('scalp1m.registrarTradeExterno(p.symbol,')); // boot não fecha mais o scalp com alvo (turno retomado)
});
test.skip('R3#6 stop: alvo fechado durante o envio cancela o stop; alvo sumido não tenta de novo', async () => {
  let t, tent = 0;
  t = cicloAprovado({ colocarStopLoss: async () => { tent++; t.closing.add('ETHUSDT'); } }); // /api/close entrou no meio
  t.m._estado.enabled = true;
  await capturarErros(() => t.m.tick());
  assert.strictEqual(tent, 1);
  assert.deepStrictEqual(t.chamadas, ['alav', 'limite BUY 0.5 100 GTX', 'cancelar']);
  assert.strictEqual(t.localAlvos.ETHUSDT.slNaCorretora, false);
  assert.strictEqual(lerJsonl(t).find(l => l.tipo === 'DECISAO' && l.simbolo === 'ETHUSDT').motivo, 'FECHAMENTO_EXTERNO_EM_CURSO');
  let t2, tent2 = 0;
  t2 = cicloAprovado({ colocarStopLoss: async () => { tent2++; delete t2.localAlvos.ETHUSDT; throw new Error('rejeitado'); } });
  t2.m._estado.enabled = true;
  await capturarErros(() => t2.m.tick());
  assert.strictEqual(tent2, 1); // sem 2ª tentativa com alvo sumido
  assert.deepStrictEqual(t2.chamadas, ['alav', 'limite BUY 0.5 100 GTX']);
});
test.skip('R3#7 travaOk na entrada e antes do stop (não ehTestnet direto)', async () => {
  const src = SRC_LIB();
  assert(src.includes("if (!travaOk(sym, 'ENTRADA')) throw new Error(MSG_NAO_TESTNET);"));
  assert(src.includes("!travaOk(sym, 'SL_EMERG')"));
  assert(!src.includes('if (!ehTestnet(baseOrdens)) throw'));
  const t = cicloAprovado({ baseOrdens: 'https://fapi.binance.com' });
  t.m._estado.enabled = true;
  const erros = await capturarErros(() => t.m._avaliarTurno(AGORA - (AGORA % 300000)));
  assert.deepStrictEqual(t.chamadas, []);
  assert.strictEqual(t.m._estado.enabled, false);
  assert(erros.some(e => e.includes('ETHUSDT ENTRADA: ordem não enviada')));
  assert.strictEqual(lerJsonl(t).find(l => l.tipo === 'DECISAO' && l.simbolo === 'ETHUSDT').acao, 'ENTRADA_FALHOU');
});

// ── RODADA 4 ──
// Executa o laço de limpeza do boot do painel (BLOCO 1.3) com mocks: comportamento real, sem rede.
async function rodarBootPainel({ posicoes, alvos = {}, base = 'https://testnet.binancefuture.com', whitelist = ['ETHUSDT', 'SOLUSDT', 'BEAMXUSDT'], openAlgo = [] }) {
  const src = SRC_PAINEL();
  const ini = src.indexOf('const scalpBoot = new Set();');
  const corpo = src.slice(ini, src.indexOf('salvarAlvos();\n\n      // Posições remanescentes válidas', ini));
  const ordens = []; const desfechos = [];
  const fut = {
    FAPI: base,
    cancelarTodasOrdens: async (sym, o) => { ordens.push(`cancelar ${sym}${o?.estrito ? ' estrito' : ''}`); return true; },
    fecharMercado: async (sym, lado, q) => { ordens.push(`fechar ${sym} ${lado} ${q}`); return { avgPrice: '1' }; }
  };
  const motor = montarMotor({ baseOrdens: base, openAlgoOrdens: async () => openAlgo,
    colocarStopLoss: async (sym, lado, p) => { ordens.push(`sl ${sym} ${lado} ${p.toFixed(4)}`); } });
  Object.assign(motor.localAlvos, alvos);
  const fn = new Function('posComQtd', 'localAlvos', 'WHITELIST_VIP', 'fut', 'scalpLib', 'scalp1m', 'rag', 'registrarDesfechoTrade', 'cooldownMoeda',
    'return (async () => { ' + corpo + '; return scalpBoot; })();');
  const erros = []; let scalpBoot;
  const oe = console.error, ow = console.warn; console.error = (...a) => erros.push(a.join(' ')); console.warn = (...a) => erros.push(a.join(' '));
  try {
    scalpBoot = await fn(posicoes, motor.localAlvos, new Set(whitelist), fut, s, motor.m, { salvarSaidaRAG: async () => {} },
      (...a) => desfechos.push(a), {});
  } finally { console.error = oe; console.warn = ow; }
  return { ordens, desfechos, erros, scalpBoot, motor };
}
const posBoot = (symbol, o = {}) => ({ symbol, lado: 'LONG', quantidade: 0.5, precoEntrada: 100, precoMarca: 100.1, pnlNaoRealizado: 0.05, alavancagem: 3, positionAmt: '0.5', ...o });
test('B7a boot ramo genérico (fora da whitelist/zumbi) sem testnet: loga erro e não envia ordem', async () => {
  const r = await rodarBootPainel({ posicoes: [posBoot('LINKUSDT'), posBoot('MUSDT')], base: 'https://fapi.binance.com' });
  assert.deepStrictEqual(r.ordens, []);
  assert.strictEqual(r.desfechos.length, 0);
  assert(r.erros.some(e => e.includes('[BOOT-LIMPEZA-ZUMBI] LINKUSDT') && e.includes('não enviado')));
  const t = await rodarBootPainel({ posicoes: [posBoot('LINKUSDT')] }); // testnet: fecha como antes
  assert.deepStrictEqual(t.ordens, ['cancelar LINKUSDT', 'fechar LINKUSDT LONG 0.5']);
  assert.strictEqual(t.desfechos[0][1], 'BOOT_CLEANUP');
});
test('B7b BEAMXUSDT sem tratamento por nome: na whitelist e sem alvo scalp não é fechado no boot', async () => {
  assert(!SRC_PAINEL().includes("p.symbol === 'BEAMXUSDT'"));
  const r = await rodarBootPainel({ posicoes: [posBoot('BEAMXUSDT')] });
  assert.deepStrictEqual(r.ordens, []);
  const fora = await rodarBootPainel({ posicoes: [posBoot('BEAMXUSDT')], whitelist: ['ETHUSDT'] }); // fora da whitelist: regra genérica
  assert.deepStrictEqual(fora.ordens, ['cancelar BEAMXUSDT', 'fechar BEAMXUSDT LONG 0.5']);
});
test.skip('B7c boot: scalp_1m com alvo (turno em andamento) não é fechado; stop rearmado se ausente; monitor retoma e fecha aos 60 s', async () => {
  const alvo = { modo: 'scalp_1m', side: 'LONG', entryPrice: 100, slPrice: 99.5, stop_pct: 0.5, quantidade: 0.5, openTime: AGORA - 20000, slot: 3, slNaCorretora: true };
  const r = await rodarBootPainel({ posicoes: [posBoot('ETHUSDT', { alavancagem: 5 })], alvos: { ETHUSDT: alvo } });
  assert.deepStrictEqual(r.ordens, ['sl ETHUSDT LONG 99.5000']); // stop ausente na corretora: rearmado; nenhum fechamento
  assert(r.scalpBoot.has('ETHUSDT')); // fora dos slots PSAR
  assert.strictEqual(r.motor.localAlvos.ETHUSDT, alvo);
  // stop já na corretora: não duplica
  const r2 = await rodarBootPainel({ posicoes: [posBoot('ETHUSDT', { alavancagem: 5 })], alvos: { ETHUSDT: { ...alvo } }, openAlgo: [{ side: 'SELL', orderType: 'STOP_MARKET' }] });
  assert.deepStrictEqual(r2.ordens, []);
  // sem testnet: nenhuma ordem, mas segue marcado fora do PSAR
  const r3 = await rodarBootPainel({ posicoes: [posBoot('ETHUSDT', { alavancagem: 5 })], alvos: { ETHUSDT: { ...alvo } }, base: 'https://fapi.binance.com' });
  assert.deepStrictEqual(r3.ordens, []); assert(r3.scalpBoot.has('ETHUSDT'));
  // motor: iniciar retoma (não órfã), slot ocupado, monitor só fecha no fim do minuto
  const t = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.05 } });
  t.localAlvos.ETHUSDT = { ...alvo, slNaCorretora: true };
  const si = global.setInterval; global.setInterval = () => 0;
  try { await capturarErros(async () => { t.m.iniciar(); await t.m.monitorarTodas(); }); } finally { global.setInterval = si; }
  assert.deepStrictEqual(t.chamadas, []); // 20 s de idade: segue aberta
  assert(!t.localAlvos.ETHUSDT.orfa && t.localAlvos.ETHUSDT.retomadoBoot === true);
  assert.strictEqual(t.m._estado.slots[3].symbol, 'ETHUSDT'); assert.strictEqual(t.m.status().turnoAtual.slots[0].status, 'ATIVO');
  t.avancar(HOLD - 20000); await t.m.monitorarTodas(); // 60 s: saída normal (a limite de 50 s não foi colocada: Market)
  assert.deepStrictEqual(t.chamadas, ['cancelar', 'fechar LONG']);
  assert.strictEqual(lerJsonl(t).find(l => l.tipo === 'TRADE').saida_motivo, 'SCALP_TEMPO_60S');
  // openTime + HOLD_MS já vencido no boot: fecha no 1º ciclo
  const t2 = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.05 } });
  t2.localAlvos.ETHUSDT = { ...alvo, openTime: AGORA - (HOLD + 10000), slNaCorretora: true };
  global.setInterval = () => 0;
  try { await capturarErros(async () => { t2.m.iniciar(); await t2.m.monitorarTodas(); }); } finally { global.setInterval = si; }
  assert.deepStrictEqual(t2.chamadas, ['cancelar', 'fechar LONG']);
});
test('R4#2 /api/close scalp: cancela stop só após fechar; falha mantém stop e slNaCorretora=true', () => {
  const b = bloco(SRC_PAINEL(), "app.post('/api/close'", "app.post('/api/tp-sl'");
  assert(b.includes('if (!ehScalp) await fut.cancelarTodasOrdens(symbol);')); // PSAR inalterado
  const iRamo = b.indexOf('if (ehScalp) { // scalp: fecha primeiro');
  assert(iRamo > 0);
  const ramo = b.slice(iRamo, b.indexOf('} else r = await fut.fecharMercado', iRamo));
  const iFechar = ramo.indexOf('fut.fecharMercado(symbol');
  const iCatch = ramo.indexOf('catch (eF)');
  assert(iFechar > 0 && iFechar < iCatch && iCatch < ramo.indexOf('fut.cancelarTodasOrdens(symbol, { estrito: true })'));
  const c = ramo.slice(iCatch, ramo.indexOf('throw eF;'));
  assert(c.includes('slNaCorretora = true') && !c.includes('cancelarTodasOrdens'));
  assert(/catch \(err\) \{\s*if \(lockScalp\) \{ closingInProgress\.delete\(symbol\);/.test(b)); // solta trava, devolve erro
});
test.skip('R4#3 cancelarTodasOrdens=false: falha logada, slNaCorretora não vira false', async () => {
  let t;
  t = cicloAprovado({ colocarStopLoss: async () => { t.closing.add('ETHUSDT'); }, cancelarTodasOrdens: async () => { t.chamadas.push('cancelar'); return false; } });
  t.m._estado.enabled = true;
  const erros = await capturarErros(() => t.m.tick());
  assert.deepStrictEqual(t.chamadas, ['alav', 'limite BUY 0.5 100 GTX', 'cancelar']);
  assert.strictEqual(t.localAlvos.ETHUSDT.slNaCorretora, true);
  assert(erros.some(e => e.includes('[SCALP-CANCEL] ETHUSDT')));
  // R5#1: cancelamento false após a saída = alvo mantido sem TRADE; a retentativa grava o desfecho.
  let cancelOk2 = false;
  const t2 = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, cancelarTodasOrdens: async () => cancelOk2 });
  t2.localAlvos.ETHUSDT = { modo: 'scalp_1m', side: 'LONG', entryPrice: 100.1, slPrice: 99.8, quantidade: 0.5, openTime: AGORA - HOLD };
  const e2 = await capturarErros(() => t2.m.monitorarPosicao('ETHUSDT', t2.localAlvos.ETHUSDT));
  assert(e2.some(e => e.includes('[SCALP-CANCEL] ETHUSDT')));
  assert(t2.localAlvos.ETHUSDT && t2.localAlvos.ETHUSDT.cancelPendente);
  assert(!fs.existsSync(path.join(t2.dir, 'log.jsonl')) || !lerJsonl(t2).some(l => l.tipo === 'TRADE'));
  cancelOk2 = true;
  await capturarErros(() => t2.m.monitorarPosicao('ETHUSDT', t2.localAlvos.ETHUSDT));
  assert.strictEqual(t2.localAlvos.ETHUSDT, undefined);
  assert.strictEqual(lerJsonl(t2).find(l => l.tipo === 'TRADE').saida_motivo, 'SCALP_TEMPO_60S');
});

// ── TURNOS DE 5 MIN + ENTRADA/SAÍDA LIMITE ──
// Turno com várias moedas aprovando LONG no gate; score varia pelo imbalance do book mainnet.
function turnoMulti(books, over = {}) {
  const t0 = AGORA - (AGORA % 300000) + 2000;
  let cur = t0;
  const ks1 = []; for (let i = 0; i < 40; i++) ks1.push(k(t0 - (40 - i) * 60000 - 2000, 100, 101, 99, 100, i === 39 ? 50 : 10));
  const ks5 = []; for (let i = 0; i < 30; i++) ks5.push(k(t0 - (30 - i) * 300000 - 2000, 100, 100, 100, 90 + i, 1));
  const feed = { iniciar: () => {}, parar: () => {}, ativo: () => true, snapshot: (sym) => books[sym]
    ? { trades: [{ T: cur - 100, p: 110, q: 3, m: false }], book: { bids: [['109.99', String(books[sym][0])]], asks: [['110', String(books[sym][1])]] }, tsTrade: cur - 100, tsBook: cur - 50, bufferCompleto: true }
    : null };
  // Jev simulado: segue a direção sugerida pelo código; divergir = responde o lado oposto; vetar = responde WAIT
  const jevChamadas = [];
  const postJev = async (url, body) => {
    const sym = body.state.simbolo, sug = body.state.direcao_sugerida_codigo;
    jevChamadas.push(sym);
    const choice = (over.vetar || []).includes(sym) ? 'WAIT' : ((over.divergir || []).includes(sym) ? (sug === 'LONG' ? 'SHORT' : 'LONG') : sug);
    return { data: { answers: { acao: { choice, confidence: 0.8 } }, usage: { input_tokens: 10, output_tokens: 2 } } };
  };
  const t = montarMotor({ agora: t0, feed, rest: { klines: async (sym, tf) => (tf === '1m' ? ks1 : ks5) }, jevKey: 'jev-key', postJev, ...over });
  t.jevChamadas = jevChamadas;
  const avancar = t.avancar;
  t.avancar = (ms) => { avancar(ms); cur += ms; };
  return t;
}
const decisoes = (t) => Object.fromEntries(lerJsonl(t).filter(l => l.tipo === 'DECISAO').map(l => [l.simbolo, l]));
const BOOKS4 = { ETHUSDT: [9, 1], SOLUSDT: [8, 2], BNBUSDT: [7, 3], XRPUSDT: [6, 4] };

test('T1 rankearCandidatas: termos normalizados 0..1, score = soma, ordem decrescente, cobre todas as moedas', () => {
  const c = (sym, d, ok = true) => ({ simbolo: sym, dados: d, gate: { ok, direcao: 'LONG' } });
  const r = s.rankearCandidatas([
    c('A', base({ taker_buy_ratio_60s: 0.6, book_imbalance_10: 0.3, rvol: 2.5 })),
    c('B', base({ taker_buy_ratio_60s: 0.9, book_imbalance_10: -0.8, rvol: 9 })),
    c('C', base({ taker_buy_ratio_60s: 1, book_imbalance_10: 1, rvol: 5 }), false)
  ]);
  assert.deepStrictEqual(r.map(x => x.simbolo), ['C', 'B', 'A']); // C (gate reprovado) também entra no ranking
  quase(r[0].score, 3);
  quase(r[1].norm.taker, 0.8); quase(r[1].norm.imbalance, 0.8); quase(r[1].norm.rvol, 1); quase(r[1].score, 2.6);
  quase(r[2].norm.taker, 0.2); quase(r[2].norm.imbalance, 0.3); quase(r[2].norm.rvol, 0.5 / 3); quase(r[2].score, 0.5 + 0.5 / 3);
  const nulo = s.rankearCandidatas([{ simbolo: 'N', dados: { simbolo: 'N', taker_buy_ratio_60s: null } }])[0];
  assert.deepStrictEqual(nulo.norm, { taker: 0, imbalance: 0, rvol: 0 }); // campo ausente não infla o score
  const sh = s.rankearCandidatas([{ simbolo: 'S', dados: baseShort({ taker_buy_ratio_60s: 0.1, rvol: 2 }), gate: { ok: true } }])[0];
  quase(sh.norm.taker, 0.8); quase(sh.norm.imbalance, 0.3); quase(sh.norm.rvol, 0);
  assert.deepStrictEqual(s.rankearCandidatas(null), []);
});
test.skip('T2 turno: o Jev decide só as 2 escolhidas; entram as 2 primeiras, moedas diferentes, slots 3 e 4', async () => {
  const t = turnoMulti(BOOKS4);
  t.m._estado.enabled = true;
  await t.m.tick();
  assert.deepStrictEqual([...t.jevChamadas].sort(), ['ETHUSDT', 'SOLUSDT']); // Jev não vê a 3ª nem a 4ª
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU');
  assert.strictEqual(dec.BNBUSDT.acao, 'NAO_ESCOLHIDA'); assert.strictEqual(dec.XRPUSDT.acao, 'NAO_ESCOLHIDA');
  assert.strictEqual(dec.XRPUSDT.jev, null);
  assert.strictEqual(dec.ETHUSDT.direcao_jev, 'LONG'); assert.strictEqual(dec.ETHUSDT.direcao_codigo, 'LONG'); assert.strictEqual(dec.ETHUSDT.jev.fonte, 'JEV');
  quase(dec.ETHUSDT.score.taker, 1); quase(dec.ETHUSDT.score.imbalance, 0.8); quase(dec.ETHUSDT.score.rvol, 1); quase(dec.ETHUSDT.score.total, 2.8);
  quase(dec.SOLUSDT.score.total, 2.6); quase(dec.BNBUSDT.score.total, 2.4); quase(dec.XRPUSDT.score.total, 2.2);
  assert.strictEqual(t.m._estado.slots[3].symbol, 'ETHUSDT'); assert.strictEqual(t.m._estado.slots[4].symbol, 'SOLUSDT');
  assert.strictEqual(t.chamadas.filter(c => c === 'limite BUY 0.5 100 GTX').length, 2);
  assert.strictEqual(t.localAlvos.ETHUSDT.entradaTipo, 'LIMITE'); assert.strictEqual(t.localAlvos.ETHUSDT.turnoId, dec.ETHUSDT.turno_id);
  assert.strictEqual(t.m.status().turnoAtual.status, 'ATIVO');
});
test.skip('T2b Jev decide compra/venda: divergiu do código = vale o Jev (entra SHORT); WAIT = vale o código e a moeda entra igual (nunca pula)', async () => {
  const t = turnoMulti(BOOKS4, { divergir: ['ETHUSDT'] });
  t.m._estado.enabled = true;
  await t.m.tick();
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.ETHUSDT.direcao_codigo, 'LONG'); assert.strictEqual(dec.ETHUSDT.direcao_jev, 'SHORT');
  assert.strictEqual(t.localAlvos.ETHUSDT.side, 'SHORT'); assert.strictEqual(t.localAlvos.SOLUSDT.side, 'LONG');
  assert(t.chamadas.includes('limite SELL 0.1 100.1 GTX') || t.chamadas.some(c => c.startsWith('limite SELL')));
  assert.strictEqual(t.localAlvos.ETHUSDT.decisao.direcao_jev, 'SHORT'); assert.strictEqual(t.localAlvos.ETHUSDT.decisao.direcao_codigo, 'LONG');
  const j = t.m.status().jev;
  assert.strictEqual(j.total, 2); assert.strictEqual(j.diverge, 1); assert.strictEqual(j.falhas, 0); assert.strictEqual(j.pulou, 0);
  // WAIT: não invalida: entra na direção do código
  const t3 = turnoMulti(BOOKS4, { vetar: ['ETHUSDT'] });
  t3.m._estado.enabled = true;
  await t3.m.tick();
  const d3 = decisoes(t3);
  assert.strictEqual(d3.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(d3.ETHUSDT.direcao_jev, null); assert.strictEqual(d3.ETHUSDT.jev.motivo, 'WAIT');
  assert.strictEqual(t3.localAlvos.ETHUSDT.side, 'LONG'); assert.strictEqual(d3.ETHUSDT.jev_timeout, false);
  assert.strictEqual(d3.SOLUSDT.acao, 'ENTROU'); assert.strictEqual(d3.BNBUSDT.acao, 'NAO_ESCOLHIDA');
  const j3 = t3.m.status().jev; assert.strictEqual(j3.pulou, 0); assert.strictEqual(j3.falhas, 0); // WAIT é opinião, não falha
});
// Ciclo completo até 4:57 (plano às 4:30 + decisão do Jev) em um motor turnoMulti/cicloNovo.
async function ate457(t) {
  t.m._estado.enabled = true;
  t.avancar(270000); await t.m.tick();      // 4:30: plano (sem IA)
  t.avancar(27000); await t.m.tick();       // 4:57: dados frescos + Jev
}
test.skip('J1 4:57 prepara SEMPRE 3 moedas (2 titulares + reserva na agulha); o Jev só é consultado nas 2 titulares', async () => {
  const t = cicloNovo(BOOKS4);
  await ate457(t);
  assert.deepStrictEqual([...t.jevChamadas].sort(), ['ETHUSDT', 'SOLUSDT']); // reserva sem consulta
  const ord = t.m._estado.plano.ordem;
  assert.deepStrictEqual(ord.slice(0, 3).map(c => c.simbolo), ['ETHUSDT', 'SOLUSDT', 'BNBUSDT']);
  assert(ord.slice(0, 3).every(c => c.preparada === true && c.dados && c.contexto)); // as 3 com dados e contexto prontos
  assert(ord[2].jev === undefined); assert.strictEqual(ord[3].preparada, undefined); // a 4ª nem foi preparada
  t.avancar(3500); await t.m.tick(); // 5:00,5: entram as 2 titulares; a reserva não é chamada
  assert.deepStrictEqual([...t.jevChamadas].sort(), ['ETHUSDT', 'SOLUSDT']);
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU'); assert.strictEqual(dec.BNBUSDT.acao, 'NAO_ESCOLHIDA');
});
test.skip('J2 titular com WAIT do Jev: não é recusada, entra na direção do código; a reserva não é consultada', async () => {
  const t = cicloNovo(BOOKS4, { vetar: ['SOLUSDT'] });
  await ate457(t);
  assert.deepStrictEqual([...t.jevChamadas].sort(), ['ETHUSDT', 'SOLUSDT']);
  assert.deepStrictEqual(t.m.status().proximas.map(p => p.simbolo), ['ETHUSDT', 'SOLUSDT']);
  t.avancar(3500); await t.m.tick();
  const dec = decisoes(t);
  assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU'); assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.BNBUSDT.acao, 'NAO_ESCOLHIDA'); assert.strictEqual(dec.XRPUSDT.acao, 'NAO_ESCOLHIDA');
  assert.strictEqual(t.jevChamadas.length, 2); // sem consulta repetida às 5:00
});
test.skip('J3 ATR baixo na titular não invalida: segue titular, vai ao Jev e entra', async () => {
  const t0 = AGORA - (AGORA % 300000) + 2000;
  const ks5 = Array.from({ length: 30 }, (_, i) => k(t0 - (30 - i) * 300000 - 2000, 100, 100, 100, 90 + i, 1));
  const ks1 = (sym) => Array.from({ length: 40 }, (_, i) => (sym === 'ETHUSDT' ? k(t0 - (40 - i) * 60000 - 2000, 100, 100.1, 99.95, 100, i === 39 ? 50 : 10) : k(t0 - (40 - i) * 60000 - 2000, 100, 101, 99, 100, i === 39 ? 50 : 10)));
  const t = cicloNovo(BOOKS4, { rest: { klines: async (sym, tf) => (tf === '1m' ? ks1(sym) : ks5) } });
  await ate457(t);
  const ord = t.m._estado.plano.ordem;
  assert.deepStrictEqual(ord.slice(0, 3).map(c => c.simbolo), ['ETHUSDT', 'SOLUSDT', 'BNBUSDT']); // ETH continua titular
  assert.deepStrictEqual([...t.jevChamadas].sort(), ['ETHUSDT', 'SOLUSDT']);
  t.avancar(3500); await t.m.tick();
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU'); assert.strictEqual(dec.BNBUSDT.acao, 'NAO_ESCOLHIDA'); assert.strictEqual(dec.XRPUSDT.acao, 'NAO_ESCOLHIDA');
});
test.skip('J4 entrada falha às 5:00: a reserva preparada só recebe a consulta do Jev nesse momento', async () => {
  const t = cicloNovo(BOOKS4, { posicao: async (sym) => (sym === 'ETHUSDT' ? { lado: 'LONG', quantidade: 1 } : null) });
  await ate457(t);
  assert.deepStrictEqual([...t.jevChamadas].sort(), ['ETHUSDT', 'SOLUSDT']);
  await capturar('warn', async () => { t.avancar(3500); await t.m.tick(); });
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTRADA_FALHOU'); assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU'); assert.strictEqual(dec.BNBUSDT.acao, 'ENTROU');
  assert.deepStrictEqual([...t.jevChamadas].sort(), ['BNBUSDT', 'ETHUSDT', 'SOLUSDT']); // BNB consultada agora, com dados de 4:57
  assert.strictEqual(t.localAlvos.BNBUSDT.decisao.direcao_jev, 'LONG');
});
test.skip('J6 feed da reserva envelhece durante a consulta do Jev: reconferido antes de entrar (DADOS_ATRASADOS_ENTRADA); Jev lento cai no código sem travar', async () => {
  let t;
  const postJev = async (u, body) => {
    if (body.state.simbolo === 'BNBUSDT') t.st.atrasar.add('BNBUSDT'); // feed fica velho enquanto o Jev responde
    return { data: { answers: { acao: { choice: body.state.direcao_sugerida_codigo, confidence: 0.9 } } } };
  };
  t = cicloNovo(BOOKS4, { postJev, posicao: async (sym) => (sym === 'ETHUSDT' ? { lado: 'LONG', quantidade: 1 } : null) });
  await ate457(t);
  await capturar('warn', async () => { t.avancar(3500); await t.m.tick(); });
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTRADA_FALHOU'); assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU');
  assert.strictEqual(dec.BNBUSDT.acao, 'DADOS_ATRASADOS_ENTRADA'); assert.strictEqual(t.localAlvos.BNBUSDT, undefined); // reserva velha não entra
  assert.strictEqual(dec.XRPUSDT.acao, 'ENTROU'); // entrou a próxima
  // Jev que nunca responde: o timeout próprio (20 ms) devolve o código e o turno não trava (o prazo JEV_PRAZO de 3,5 s não é exercitado aqui)
  const t2 = turnoMulti(BOOKS4, { postJev: () => new Promise(() => {}), jevTimeoutMs: 20 });
  t2.m._estado.enabled = true;
  const ini = Date.now();
  await t2.m.tick();
  assert(Date.now() - ini < 5000);
  assert(decisoes(t2).ETHUSDT.acao === 'ENTROU'); // Jev lento: timeout próprio (20 ms) cai no código; sem travar
});
test.skip('J5 confiança baixa do Jev não pula a moeda (entra na direção do Jev); falha/timeout vale o código com jev_timeout=true', async () => {
  const resp = (conf) => async (u, body) => ({ data: { answers: { acao: { choice: body.state.direcao_sugerida_codigo, confidence: conf } } } });
  const t = turnoMulti(BOOKS4, { postJev: resp(0.59) });
  t.m._estado.enabled = true; await t.m.tick();
  assert.strictEqual(decisoes(t).ETHUSDT.acao, 'ENTROU'); assert.strictEqual(decisoes(t).SOLUSDT.acao, 'ENTROU'); // 59% entra igual
  assert.strictEqual(decisoes(t).ETHUSDT.jev.conf, 59); assert.strictEqual(decisoes(t).ETHUSDT.jev_timeout, false);
  const t2 = turnoMulti(BOOKS4, { postJev: resp(0.6) });
  t2.m._estado.enabled = true; await t2.m.tick();
  assert.strictEqual(decisoes(t2).ETHUSDT.acao, 'ENTROU'); assert.strictEqual(decisoes(t2).ETHUSDT.jev.conf, 60);
  const t3 = turnoMulti(BOOKS4, { postJev: async () => { throw new Error('HTTP 500'); } });
  t3.m._estado.enabled = true; await t3.m.tick();
  assert.strictEqual(decisoes(t3).ETHUSDT.acao, 'ENTROU'); assert.strictEqual(t3.m.status().jev.falhas, 2); assert.strictEqual(t3.m.status().jev.pulou, 0);
  assert.strictEqual(decisoes(t3).ETHUSDT.jev_timeout, true); assert.strictEqual(t3.m.status().jev.timeouts, 2); assert(t3.localAlvos.ETHUSDT.decisao.jev_timeout === true);
});

test.skip('T3 sem chave do Jev o turno não esvazia: vale a direção do código (SEM_JEV_API_KEY); numeração de turno', async () => {
  const t = turnoMulti({ ETHUSDT: [9, 1], SOLUSDT: [8, 2], BNBUSDT: [7, 3] }, { jevKey: null });
  t.m._estado.enabled = true;
  await t.m.tick();
  assert.deepStrictEqual(t.jevChamadas, []);
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.ETHUSDT.jev.motivo, 'SEM_JEV_API_KEY'); assert.strictEqual(dec.ETHUSDT.jev.fonte, 'CODIGO');
  const tu = lerJsonl(t).filter(l => l.tipo === 'TURNO');
  assert.strictEqual(tu.length, 0); // turno ativo: o TURNO só é gravado ao fechar
  const st = t.m.status();
  assert.strictEqual(st.turnoAtual.numero, 1); // log vazio: sequência começa em #1 (contínua após restart: teste F1)
  assert.strictEqual(st.jev.ativo, false); assert.strictEqual(st.jev.falhas, 2);
});
test.skip('T4 entrada limite sem fill: reprecifica a cada 3 s, 12 s no total, cancela e entra a Market (taxa taker)', async () => {
  let t, consultas = 0;
  t = cicloAprovado({ consultarOrdem: async (sym, id) => { consultas++; return { orderId: id, status: t.chamadas.includes(`cancelOrd ${id}`) ? 'CANCELED' : 'NEW', executedQty: '0', avgPrice: '0' }; } });
  t.m._estado.enabled = true;
  const ini = t.agora();
  await t.m.tick();
  assert.deepStrictEqual(t.chamadas, ['alav', 'limite BUY 0.5 100 GTX', 'cancelOrd 1', 'limite BUY 0.5 100 GTX', 'cancelOrd 2',
    'limite BUY 0.5 100 GTX', 'cancelOrd 3', 'limite BUY 0.5 100 GTX', 'cancelOrd 4', 'market BUY 0.5', 'sl LONG 99.2982']); // stop 0,90% (ATR 2%)
  assert.strictEqual(t.agora() - ini, 12000); // 4 tentativas x 3 s (6 consultas de 500 ms cada)
  assert.strictEqual(consultas, 28); // (6 no laço + 1 final após o cancelamento) x 4
  const a = t.localAlvos.ETHUSDT;
  assert.strictEqual(a.entradaTipo, 'MARKET'); assert.strictEqual(a.taxaEntradaPct, 0.05); assert.strictEqual(a.entryPrice, 100.2);
  assert.strictEqual(t.m._estado.slots[3].symbol, 'ETHUSDT');
  const linhas = lerJsonl(t);
  assert.strictEqual(linhas.find(l => l.evento === 'SCALP_ENTRADA_LIMITE').resultado, 'CANCELADA');
  const em = linhas.find(l => l.evento === 'SCALP_ENTRADA_MARKET');
  assert.strictEqual(em.motivo, 'SEM_FILL_12S'); assert.strictEqual(em.qty, 0.5);
  assert.strictEqual(linhas.find(l => l.evento === 'SCALP_ENTRADA_LIMITE').tentativas, 4);
  assert.strictEqual(decisoes(t).ETHUSDT.acao, 'ENTROU');
  assert(!linhas.some(l => l.tipo === 'TURNO' && l.status === 'VAZIO'));
  const h = t.m.status().hoje;
  assert.strictEqual(h.pctEntradasCanceladas, 100); assert.strictEqual(h.pctEntradasLimitePreenchidas, 0);
});
test.skip('T5 GTX rejeitada (-5022): entra a Market na hora, sem cancelamento', async () => {
  let t;
  t = cicloAprovado({ colocarLimite: async (sym, lado, qty, preco, opts) => {
    t.chamadas.push(`limite ${lado} ${opts.timeInForce}`);
    const e = new Error('Request failed with status code 400'); e.response = { data: { code: -5022, msg: 'Post Only order will be rejected' } }; throw e;
  } });
  t.m._estado.enabled = true;
  await t.m.tick();
  assert.deepStrictEqual(t.chamadas, ['alav', 'limite BUY GTX', 'market BUY 0.5', 'sl LONG 99.2982']);
  assert.strictEqual(t.m._estado.slots[3].symbol, 'ETHUSDT');
  assert.strictEqual(decisoes(t).ETHUSDT.acao, 'ENTROU');
  const linhas = lerJsonl(t);
  assert.strictEqual(linhas.find(l => l.evento === 'SCALP_ENTRADA_LIMITE').resultado, 'GTX_REJEITADA');
  assert.strictEqual(linhas.find(l => l.evento === 'SCALP_ENTRADA_MARKET').motivo, 'GTX_REJEITADA');
  assert(!linhas.some(l => l.evento === 'SCALP_ENTRADA_FALHOU'));
  assert(!linhas.some(l => l.tipo === 'TURNO'));
});
test.skip('T6 fill parcial: executedQty após cancelar + resto a Market (taxa ponderada); abaixo do minQty zera a Market reduceOnly', async () => {
  const parcial = (tt) => async (sym, id) => { // ordem 1: fill parcial 0,2; reprecificações: sem fill
    const ex = id === 1 ? '0.2' : '0';
    return tt().chamadas.includes(`cancelOrd ${id}`)
      ? { orderId: id, status: 'CANCELED', executedQty: ex, avgPrice: id === 1 ? '100' : '0' }
      : { orderId: id, status: id === 1 ? 'PARTIALLY_FILLED' : 'NEW', executedQty: ex, avgPrice: id === 1 ? '100' : '0' };
  };
  let t;
  t = cicloAprovado({ consultarOrdem: parcial(() => t) });
  t.m._estado.enabled = true;
  await t.m.tick();
  assert.deepStrictEqual(t.chamadas, ['alav', 'limite BUY 0.5 100 GTX', 'cancelOrd 1', 'limite BUY 0.3 100 GTX', 'cancelOrd 2',
    'limite BUY 0.3 100 GTX', 'cancelOrd 3', 'limite BUY 0.3 100 GTX', 'cancelOrd 4', 'market BUY 0.3', 'sl LONG 99.2189']); // só o restante é reprecificado
  const a = t.localAlvos.ETHUSDT;
  assert.strictEqual(a.quantidade, 0.5); quase(a.entryPrice, (0.2 * 100 + 0.3 * 100.2) / 0.5);
  assert.strictEqual(a.entradaTipo, 'MISTA'); quase(a.taxaEntradaPct, (0.2 * 0.02 + 0.3 * 0.05) / 0.5);
  assert.strictEqual(lerJsonl(t).find(l => l.evento === 'SCALP_ENTRADA_MARKET').motivo, 'PARCIAL_12S');
  const ev = lerJsonl(t).find(l => l.evento === 'SCALP_ENTRADA_LIMITE');
  assert.strictEqual(ev.resultado, 'PARCIAL'); assert.strictEqual(ev.qty_executada, 0.2); assert.strictEqual(ev.qty_pedida, 0.5);
  assert.strictEqual(decisoes(t).ETHUSDT.acao, 'ENTROU');
  let t2;
  t2 = cicloAprovado({ consultarOrdem: parcial(() => t2), filtrosDe: () => ({ minQty: 0.35 }), // resto 0,3 < 0,35: sem Market
    fecharMercado: async (sym, lado, q) => { t2.chamadas.push(`fechar ${lado} ${q}`); return { avgPrice: '99.9' }; } });
  t2.m._estado.enabled = true;
  await capturarErros(() => t2.m.tick());
  assert.deepStrictEqual(t2.chamadas, ['alav', 'limite BUY 0.5 100 GTX', 'cancelOrd 1', 'fechar LONG 0.2']);
  assert.strictEqual(t2.localAlvos.ETHUSDT, undefined); assert.strictEqual(t2.m._estado.slots[3].symbol, null);
  const z = lerJsonl(t2).find(l => l.evento === 'SCALP_PARCIAL_ZERADA');
  assert.strictEqual(z.qty, 0.2); assert.strictEqual(z.min_qty, 0.35);
  assert.strictEqual(decisoes(t2).ETHUSDT.acao, 'PARCIAL_ABAIXO_MINQTY');
  assert.deepStrictEqual(t2.m._estado.turno.moedas, ['ETHUSDT']); // houve fill: moeda não repete no turno seguinte
});
const ALVO_LIMITE = () => ({ ...ALVO_ETH(), entryPrice: 100, entradaTipo: 'LIMITE', taxaEntradaPct: 0.02 });
test.skip('T7 saída limite GTX reduceOnly aos 50 s: fill = SCALP_TEMPO_LIMITE, maker nas 2 pernas', async () => {
  const t = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 } });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = ALVO_LIMITE();
  t.avancar(SAIDA - 1000); await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  assert.deepStrictEqual(t.chamadas, []);
  t.avancar(1000); await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  assert.deepStrictEqual(t.chamadas, ['limite SELL 0.5 100.1 RO GTX']); // melhor ask (maker no lado de saída)
  assert.strictEqual(t.localAlvos.ETHUSDT.saidaLimite.orderId, 1);
  await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT); // consulta: FILLED
  assert.deepStrictEqual(t.chamadas, ['limite SELL 0.5 100.1 RO GTX', 'cancelar']);
  assert.strictEqual(t.desfechos[0][1], 'SCALP_TEMPO_LIMITE');
  assert.strictEqual(t.localAlvos.ETHUSDT, undefined); assert.strictEqual(t.m._estado.slots[3].symbol, null);
  const tr = lerJsonl(t).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.saida_tipo, 'LIMITE'); assert.strictEqual(tr.entrada_tipo, 'LIMITE');
  assert.strictEqual(tr.taxas.entrada_pct, 0.02); assert.strictEqual(tr.taxas.saida_pct, 0.02);
  quase(tr.saida.testnet, 100.1); quase(tr.pnl_testnet.bruto, 0.05); quase(tr.pnl_testnet.taxas, (50 + 50.05) * 0.0002);
  quase(tr.taxas.entrada_usdt, 0.01); quase(tr.taxas.saida_usdt, 50.05 * 0.0002);
  assert('turno_id' in tr);
});
test.skip('T7b limite de saída cheia deixa sobra (0,01): fecha a sobra a Market reduceOnly; sem sobra ou leitura velha: nada', async () => {
  let n = 0;
  const t = montarMotor({ posicao: async () => (++n <= 2 ? { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 } : { lado: 'LONG', quantidade: 0.01, precoMarca: 100.2 }),
    fecharMercado: async (sym, lado, q) => { t.chamadas.push(`fechar ${lado} ${q}`); return { avgPrice: '100.3' }; } });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = ALVO_LIMITE();
  t.avancar(SAIDA); await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT); // coloca a limite (posicao #1)
  await capturarErros(async () => { await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT); }); // FILLED (posicao #2); sobra lida em #3
  assert.deepStrictEqual(t.chamadas.filter(c => c.startsWith('fechar')), ['fechar LONG 0.01']);
  assert.strictEqual(t.localAlvos.ETHUSDT, undefined);
  const tr = lerJsonl(t).find(l => l.tipo === 'TRADE');
  quase(tr.qty, 0.51); assert.strictEqual(tr.saida_tipo, 'MARKET'); // 0,5 limite + 0,01 Market
  // leitura da posição falha após a limite cheia: assume zerada (comportamento anterior), sem Market
  let m = 0;
  const u = montarMotor({ posicao: async () => { if (++m <= 2) return { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }; throw new Error('timeout'); } });
  u.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  u.localAlvos.ETHUSDT = ALVO_LIMITE();
  u.avancar(SAIDA); await u.m.monitorarPosicao('ETHUSDT', u.localAlvos.ETHUSDT);
  await u.m.monitorarPosicao('ETHUSDT', u.localAlvos.ETHUSDT);
  assert(!u.chamadas.some(c => c.startsWith('fechar'))); assert.strictEqual(u.desfechos[0][1], 'SCALP_TEMPO_LIMITE');
});
test('PL1 placar do scalp usa o líquido REAL: bruto +0,036 com taxas 0,035 = W; perda = L; sem líquido real mantém a regra antiga', async () => {
  // motor entrega o líquido real no alvo
  const t = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 } });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = ALVO_ETH(); t.avancar(HOLD);
  await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  const tr = lerJsonl(t).find(l => l.tipo === 'TRADE');
  quase(t.desfechos[0][4].pnlLiquidoReal, tr.pnl_testnet.liquido);
  // painel: decisão W/L
  const src = SRC_PAINEL();
  const fsrc = bloco(src, 'function registrarDesfechoTrade(', 'function formatarPrecoAtivo');
  const rodar = (pnlBruto, alvo) => {
    const placarStats = { wins: 0, losses: 0, total: 0 };
    new Function('placarStats', 'closedTradeEvents', 'salvarPlacarStats', 'symbolLossCooldown', 'salvarLossCooldown', 'console',
      fsrc + "; registrarDesfechoTrade('XUSDT', 'SCALP_TEMPO_LIMITE', 0.36, " + pnlBruto + ', ' + JSON.stringify(alvo) + ');')(
      placarStats, new Map(), () => {}, {}, () => {}, { log() {}, warn() {}, error() {} });
    return placarStats;
  };
  assert.deepStrictEqual([rodar(0.036, { pnlLiquidoReal: 0.0011 }).wins, rodar(0.036, { pnlLiquidoReal: 0.0011 }).losses], [1, 0]); // INJ: antes virava L
  assert.deepStrictEqual([rodar(-0.039, { pnlLiquidoReal: -0.0692 }).wins, rodar(-0.039, { pnlLiquidoReal: -0.0692 }).losses], [0, 1]);
  assert.deepStrictEqual([rodar(0.5, { pnlLiquidoReal: 0 }).wins, rodar(0.5, { pnlLiquidoReal: 0 }).losses], [0, 1]); // zero = L
  assert.strictEqual(rodar(0.036, {}).losses, 1); // sem líquido real (PSAR): taxa estimada 0,04 como antes
});
test.skip('T8 aos 60 s: cancela a limite, consulta e manda o restante a Market (SCALP_TEMPO_60S)', async () => {
  let t, posAtual = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  t = montarMotor({
    posicao: async () => posAtual,
    consultarOrdem: async (sym, id) => (t.chamadas.includes(`cancelOrd ${id}`)
      ? { orderId: id, status: 'CANCELED', executedQty: '0.1', avgPrice: '100.4' }
      : { orderId: id, status: 'PARTIALLY_FILLED', executedQty: '0.1', avgPrice: '100.4' }),
    fecharMercado: async (sym, lado, q) => { t.chamadas.push(`fechar ${lado} ${q}`); return { avgPrice: '100.3' }; }
  });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = ALVO_LIMITE();
  t.avancar(SAIDA); await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  posAtual = { ...posAtual, quantidade: 0.4 }; // 0,1 preencheu na limite
  t.avancar(5000); await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT); // parcial: aguarda
  assert.deepStrictEqual(t.chamadas, ['limite SELL 0.5 100.1 RO GTX']);
  t.avancar(HOLD - SAIDA - 5000); await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  assert.deepStrictEqual(t.chamadas, ['limite SELL 0.5 100.1 RO GTX', 'cancelOrd 1', 'cancelar', 'fechar LONG 0.4']);
  assert.strictEqual(t.desfechos[0][1], 'SCALP_TEMPO_60S');
  const tr = lerJsonl(t).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.saida_motivo, 'SCALP_TEMPO_60S'); assert.strictEqual(tr.saida_tipo, 'MARKET');
  quase(tr.qty, 0.5); quase(tr.saida.testnet, (0.1 * 100.4 + 0.4 * 100.3) / 0.5);
  quase(tr.taxas.saida_pct, (0.1 * 0.02 + 0.4 * 0.05) / 0.5); assert.strictEqual(tr.taxas.entrada_pct, 0.02);
  // sem limite no livro (ex.: órfã), aos 60 s vai direto a Market com taxa taker
  const t2 = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 } });
  t2.localAlvos.ETHUSDT = ALVO_ETH(); t2.avancar(HOLD);
  await t2.m.monitorarPosicao('ETHUSDT', t2.localAlvos.ETHUSDT);
  const tr2 = lerJsonl(t2).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr2.saida_tipo, 'MARKET'); assert.strictEqual(tr2.entrada_tipo, 'MARKET');
  assert.strictEqual(tr2.taxas.entrada_pct, 0.05); assert.strictEqual(tr2.taxas.saida_pct, 0.05);
});
test.skip('T8b saída rejeitada porque o stop disparou: consulta a posição antes de SCALP_DESCONHECIDO', async () => {
  let t, posAtual = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  t = montarMotor({
    posicao: async () => posAtual,
    colocarLimite: async () => { t.chamadas.push('limite'); posAtual = null; const e = new Error('ReduceOnly Order is rejected'); e.response = { data: { code: -2022 } }; throw e; }
  });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = ALVO_LIMITE();
  t.avancar(SAIDA);
  await capturarErros(() => t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT));
  assert(t.localAlvos.ETHUSDT); // rejeição não vira desfecho na hora
  assert.strictEqual(fs.existsSync(path.join(t.dir, 'log.jsonl')), false); // nenhuma linha TRADE gravada
  await capturarErros(() => t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT)); // posição consultada: zerada
  assert.strictEqual(lerJsonl(t).find(l => l.tipo === 'TRADE').saida_motivo, 'SCALP_DESCONHECIDO');
  // limite de saída cheia e posição zerada: consulta a ordem e registra SCALP_TEMPO_LIMITE (não DESCONHECIDO)
  let t2, pos2 = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  t2 = montarMotor({ posicao: async () => pos2 });
  t2.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t2.localAlvos.ETHUSDT = ALVO_LIMITE();
  t2.avancar(SAIDA); await t2.m.monitorarPosicao('ETHUSDT', t2.localAlvos.ETHUSDT);
  pos2 = null;
  await t2.m.monitorarPosicao('ETHUSDT', t2.localAlvos.ETHUSDT);
  const tr = lerJsonl(t2).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.saida_motivo, 'SCALP_TEMPO_LIMITE'); assert.strictEqual(tr.saida_tipo, 'LIMITE'); quase(tr.saida.testnet, 100.1);
});
test.skip('T9 soma do turno: TURNO fechado soma o líquido dos trades (testnet e mainnet); hoje refeito no boot', async () => {
  const posicoes = {};
  const t = turnoMulti({ ETHUSDT: [9, 1], SOLUSDT: [8, 2] }, { posicao: async (sym) => posicoes[sym] || null });
  t.m._estado.enabled = true;
  await t.m.tick();
  posicoes.ETHUSDT = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  posicoes.SOLUSDT = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  t.avancar(HOLD + 1000); await t.m.monitorarTodas();
  const linhas = lerJsonl(t);
  const trades = linhas.filter(l => l.tipo === 'TRADE');
  assert.strictEqual(trades.length, 2);
  const tu = linhas.filter(l => l.tipo === 'TURNO');
  assert.strictEqual(tu.length, 1); assert.strictEqual(tu[0].status, 'FECHADO'); assert.strictEqual(tu[0].trades, 2);
  const liqT = 0.15 - (50 * 0.0002 + 50.15 * 0.0005); // entrada maker no bid 100, saída Market 100,3
  quase(trades[0].pnl_testnet.liquido, liqT);
  quase(tu[0].soma_liquida_testnet, 2 * liqT);
  quase(tu[0].soma_liquida_mainnet, trades[0].pnl_mainnet.liquido + trades[1].pnl_mainnet.liquido);
  assert.strictEqual(tu[0].positivo, true);
  assert(linhas.indexOf(tu[0]) > linhas.indexOf(trades[1])); // TURNO depois dos TRADEs
  const st = t.m.status();
  assert.strictEqual(st.turnoAtual.status, 'FECHADO');
  quase(st.turnoAtual.somaTurno.testnet, 2 * liqT);
  assert.strictEqual(st.ultimoTurno.positivo, true); quase(st.ultimoTurno.somaLiquida, 2 * liqT);
  assert.strictEqual(st.hoje.turnos, 1); assert.strictEqual(st.hoje.positivos, 1); assert.strictEqual(st.hoje.operacoes, 2);
  assert.strictEqual(st.hoje.winRatePorOperacao, 100); quase(st.hoje.expectativaLiquidaMediaPorOperacao, liqT);
  assert.strictEqual(st.hoje.pctSaidasMarket, 100); assert.strictEqual(st.hoje.pctEntradasLimitePreenchidas, 100);
  quase(st.hoje.taxasPagas, 2 * (50 * 0.0002 + 50.15 * 0.0005));
  const reboot = montarMotor({ dir: t.dir, agora: t.agora() }); // boot: lê o JSONL do dia
  assert.deepStrictEqual(reboot.m.status().hoje, st.hoje);
  assert.deepStrictEqual(reboot.m.status().ultimoTurno, st.ultimoTurno);
});
test.skip('T10 órfã não bloqueia o turno: só slots livres; alerta [SCALP-ORFA] aos 5 min, sem fechar', async () => {
  const t = turnoMulti({ ETHUSDT: [9, 1], SOLUSDT: [8, 2] });
  const t0 = t.agora();
  t.m._estado.slots[3] = { symbol: 'BNBUSDT', side: 'SHORT', status: '[SCALP ÓRFÃ] BNBUSDT SHORT', openTime: t0 - 400000 };
  t.localAlvos.BNBUSDT = { modo: 'scalp_1m', side: 'SHORT', entryPrice: 50, quantidade: 1, openTime: t0 - 400000, orfa: true, orfaDesde: t0 - 300000, turnoId: 'antigo' };
  t.m._estado.enabled = true;
  const erros = await capturarErros(() => t.m.tick());
  assert(erros.some(e => e.includes('[SCALP-ORFA] ALERTA BNBUSDT')));
  assert.strictEqual(t.m._estado.slots[3].symbol, 'BNBUSDT');
  assert.strictEqual(t.m._estado.slots[4].symbol, 'ETHUSDT');
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.SOLUSDT.acao, 'NAO_ESCOLHIDA');
  assert(!t.chamadas.some(c => c.startsWith('fechar'))); // órfã não é fechada à força
  assert.strictEqual(lerJsonl(t).filter(l => l.evento === 'SCALP_ORFA_ALERTA').length, 1);
  const e2 = await capturarErros(() => t.m.tick());
  assert(!e2.some(e => e.includes('ALERTA BNBUSDT'))); // alerta uma vez
  // posição do turno que passa da fronteira seguinte vira órfã; o turno anterior fecha e o próximo roda
  const t2 = turnoMulti({ ETHUSDT: [9, 1] });
  t2.m._estado.enabled = true;
  await t2.m.tick();
  assert.strictEqual(t2.localAlvos.ETHUSDT.orfa, undefined);
  t2.avancar(300000);
  const e3 = await capturarErros(() => t2.m.tick());
  assert(e3.some(e => e.includes('[SCALP-ORFA] ETHUSDT')));
  assert.strictEqual(t2.localAlvos.ETHUSDT.orfa, true);
  const tus = lerJsonl(t2).filter(l => l.tipo === 'TURNO');
  assert.strictEqual(tus[0].status, 'FECHADO'); assert.deepStrictEqual(tus[0].orfas, ['ETHUSDT']);
  assert.strictEqual(tus.length, 2); // o turno seguinte rodou (vazio: ETH órfã ocupa o símbolo)
  assert.strictEqual(tus[1].motivo, 'SEM_CANDIDATA_VALIDA');
});
test('T11 taxas: maker 0,02% na limite, taker 0,05% na Market; calcularPnl compatível', () => {
  assert.strictEqual(s.TAXA_MAKER_PCT, 0.02); assert.strictEqual(s.TAXA_TAKER_PCT, 0.05);
  const p = s.calcularPnl({ lado: 'LONG', qty: 1, entrada: 100, saida: 101, taxaEntradaPct: s.TAXA_MAKER_PCT, taxaSaidaPct: s.TAXA_TAKER_PCT });
  quase(p.taxas, 100 * 0.0002 + 101 * 0.0005); quase(p.liquido, 1 - (0.02 + 0.0505));
  quase(s.calcularPnl({ lado: 'LONG', qty: 1, entrada: 100, saida: 101 }).taxas, 201 * 0.0005); // padrão: 0,05% por lado
  quase(s.calcularPnl({ lado: 'LONG', qty: 1, entrada: 100, saida: 101, taxaPct: 0.02 }).taxas, 201 * 0.0002);
});
test.skip('T12 status()/GET /api/scalp-1m: turnoAtual, ultimoTurno e hoje com todos os campos, sem segredos', async () => {
  const posicoes = {};
  const t = turnoMulti({ ETHUSDT: [9, 1] }, { posicao: async (sym) => posicoes[sym] || null });
  t.m._estado.enabled = true;
  await t.m.tick();
  posicoes.ETHUSDT = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  t.avancar(10000); await t.m.monitorarTodas(); // ticker testnet 100,2 -> PnL ao vivo
  const st = t.m.status();
  const ta = st.turnoAtual;
  for (const c of ['numero', 'proximoEmMs', 'slots', 'somaTurno', 'status']) assert(c in ta, c);
  assert.strictEqual(ta.proximoEmMs, (AGORA - (AGORA % 300000)) + 300000 - t.agora());
  const sl = ta.slots[0];
  assert.deepStrictEqual(Object.keys(sl).sort(), ['direcao', 'moeda', 'pnlAoVivo', 'precoEntrada', 'segundosRestantes', 'slot', 'status']);
  assert.strictEqual(sl.moeda, 'ETHUSDT'); assert.strictEqual(sl.direcao, 'LONG'); assert.strictEqual(sl.precoEntrada, 100);
  quase(sl.pnlAoVivo, 0.1); assert.strictEqual(sl.segundosRestantes, HOLD / 1000 - 10); assert.strictEqual(sl.status, 'ATIVO');
  assert('ultimoTurno' in st);
  for (const c of ['turnos', 'positivos', 'negativos', 'pnlLiquido', 'taxasPagas', 'winRatePorOperacao', 'expectativaLiquidaMediaPorOperacao',
    'pctEntradasLimitePreenchidas', 'pctEntradasCanceladas', 'pctSaidasMarket', 'top3Bloqueios']) assert(c in st.hoje, c);
  assert(Array.isArray(st.hoje.top3Bloqueios));
  assert.deepStrictEqual(st.hoje.top3Bloqueios[0], { motivo: 'CAMPO_INVALIDO', n: 3 }); // SOL/BNB/XRP sem feed
  const json = JSON.stringify(st);
  assert(!json.includes('binancefuture') && !json.includes('routerKey') && !json.includes('Bearer'));
  const src = SRC_PAINEL();
  assert(src.includes("app.get('/api/scalp-1m', (req, res) => {\n  res.json({ success: true, ...scalp1m.status() });"));
});
test('T13 UI: tela do ciclo (topo, relógio/fase, cards 3/4, ranking, histórico) entre a barra e a grelha, fetch 1 s, escape, script válido', () => {
  const src = SRC_PAINEL();
  const iBarra = src.indexOf('<!-- BARRA DE CONTROLE DO ROBÔ AUTÔNOMO -->\n    <div class="bot-control-bar">');
  const iScalp = src.indexOf('<div class="scalp-turno-bar" id="scalp-turno-bar">');
  const iGrelha = src.indexOf('<!-- GRELHA DOS CARTÕES (1 E 2) -->\n    <div id="psar-off-nota"');
  assert(iBarra > 0 && iBarra < iScalp && iScalp < iGrelha);
  for (const id of ['scalp-estado', 'scalp-turno-num', 'scalp-contagem', 'scalp-soma-turno', 'scalp-slots', 'scalp-hoje',
    'scalp-relogio', 'scalp-fase', 'scalp-ciclo-resta', 'scalp-barra-pos', 'scalp-proximas', 'scalp-ranking', 'scalp-historico']) assert(src.includes(`id="${id}"`), id);
  // PSAR desligado: tela inteira do scalp (100vh, sem rolar) e PSAR/robô IA/MTF fora da tela
  assert(src.includes('<body class="${psarSlotsOcultos() ? \'modo-scalp\' : \'\'}">'));
  assert(src.includes('body.modo-scalp { padding: 6px; height: 100vh; min-height: 0; overflow: hidden; }'));
  assert(src.includes('body.modo-scalp #psar-off-nota, body.modo-scalp #psar-grid { display: none !important; }'));
  assert(src.includes('body.modo-scalp .perf-header-bar, body.modo-scalp .volatility-bar, body.modo-scalp .bot-control-bar,'));
  assert(src.includes('grid-template-rows: auto auto auto minmax(0, 1fr);'));
  assert(src.includes("const r = await fetch('/api/scalp-1m');"));
  assert(src.includes('setInterval(atualizarScalpTurno, 1000);'));
  assert(src.includes('setInterval(atualizarStatusAutoBot, 3000);')); // painel existente intacto
  const render = bloco(src, 'function renderScalpTurno()', '// ── ROBÔ AUTÔNOMO ──');
  for (const c of ['precoEntrada', 'pnlAoVivo', 'segundosRestantes', 'somaTurno', 'winRatePorOperacao', 'expectativaLiquidaMediaPorOperacao',
    'taxasPagas', 'pnlLiquido', 'saldoGlobal', 'd.ranking', 'd.historico', 'd.proximas', 'dentroMs', 'faseAnaliseIniMs', 'faseConfirmacaoIniMs', 'condicoes_ok']) assert(render.includes(c), c);
  for (const c of ['escHtml(s.moeda)', 'escHtml(c.simbolo)', 'escHtml(c.bloqueio)', 'escHtml(u.numero)', 'escHtml(u.motivo', 'map(escHtml)', 'escHtml(p.simbolo)']) assert(render.includes(c), c);
  assert(bloco(src, 'function scalpDirHtml(dir)', 'const SCALP_STATUS_TXT').includes('escHtml(dir)'));
  // script do cliente (como o Express serve) é JavaScript válido
  const i = src.indexOf('<script>', iGrelha);
  const raw = src.slice(i + 8, src.indexOf('</script>', i));
  const codigo = new Function('return `' + raw + '`')();
  assert.doesNotThrow(() => new Function(codigo));
  const esc = new Function(codigo.slice(codigo.indexOf('function escHtml'), codigo.indexOf('function scalpUsd')) + '; return escHtml;')();
  assert.strictEqual(esc('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});
test('T14 boot: alvo scalp mantido = log informativo; ALERTA SEM GESTÃO só sem alvo', () => {
  const f = bloco(SRC_PAINEL(), 'const posValidas =', 'for (let idx = 0; idx < posValidas.length');
  const iMantido = f.indexOf("if (localAlvos[p.symbol]?.modo === 'scalp_1m') {");
  const iInfo = f.indexOf('mantida e monitorada pelo motor scalp');
  const iElse = f.indexOf('} else {', iMantido);
  const iAlerta = f.indexOf('[SCALP-BOOT] ALERTA');
  assert(iMantido > 0 && iMantido < iInfo && iInfo < iElse && iElse < iAlerta);
  assert(!f.slice(iMantido, iElse).includes('SEM GESTÃO'));
});
test('T15 futuresApi.colocarLimite aceita timeInForce (padrão GTC); chamadas PSAR sem mudança', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'lib', 'futuresApi.js'), 'utf8');
  const b = bloco(api, 'async function colocarLimite(', 'async function cancelarOrdem(');
  assert(b.includes("timeInForce: opts.timeInForce || 'GTC'"));
  const chamadas = SRC_PAINEL().match(/fut\.colocarLimite\([^)]*\)/g);
  assert.strictEqual(chamadas.length, 5);
  assert(chamadas.every(c => !c.includes('timeInForce') && !c.includes('GTX')));
  const lib = SRC_LIB();
  for (const a of ['ENTRADA_GTX', 'ENTRADA_CANCEL', 'PARCIAL_MINQTY', 'SAIDA_GTX', 'SAIDA_CANCEL', 'SAIDA_MARKET']) assert(lib.includes(`travaOk(sym, '${a}')`), a);
  // trava testnet: base mainnet não envia a limite de saída
  const t = montarMotor({ baseOrdens: 'https://fapi.binance.com', pos: { lado: 'LONG', quantidade: 0.5 } });
  t.localAlvos.ETHUSDT = ALVO_LIMITE(); t.avancar(SAIDA);
  return capturarErros(() => t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT)).then(() => assert.deepStrictEqual(t.chamadas, []));
});
test('T16 script de expectativa: turnos, % limite preenchida/cancelada, % saída a Market, top 3 bloqueios', () => {
  const dec = (bloqueio, n, ok = false, acao = 'NENHUMA') => Array.from({ length: n }, () => ({ tipo: 'DECISAO', gate: { ok, bloqueio }, acao }));
  const ev = (resultado, n) => Array.from({ length: n }, () => ({ tipo: 'EVENTO', evento: 'SCALP_ENTRADA_LIMITE', resultado }));
  const r = resumir([
    { tipo: 'TURNO', status: 'FECHADO', soma_liquida_testnet: 0.2 },
    { tipo: 'TURNO', status: 'FECHADO', soma_liquida_testnet: -0.1 },
    { tipo: 'TURNO', status: 'VAZIO', motivo: 'VETO_GEMINI' },
    ...ev('PREENCHIDA', 2), ...ev('PARCIAL', 1), ...ev('CANCELADA', 1),
    { tipo: 'TRADE', saida_tipo: 'MARKET', saida_motivo: 'SCALP_TEMPO_60S', pnl_testnet: { liquido: 0.2, taxas: 0.01 }, pnl_mainnet: null },
    { tipo: 'TRADE', saida_tipo: 'LIMITE', saida_motivo: 'SCALP_TEMPO_LIMITE', pnl_testnet: { liquido: -0.1, taxas: 0.01 }, pnl_mainnet: null },
    ...dec('ATR_BAIXO', 3), ...dec('SPREAD_ALTO', 2), ...dec(null, 1, true, 'VETO_GEMINI'), ...dec(null, 1, true, 'ENTROU')
  ]);
  assert.deepStrictEqual(r.turnos, { total: 3, vazios: 1, positivos: 1, negativos: 1 });
  assert.strictEqual(r.entradas.total, 4); quase(r.entradas.pctPreenchidas, 75); quase(r.entradas.pctCanceladas, 25);
  quase(r.saidas.pctMarket, 50);
  assert.deepStrictEqual(r.top3Bloqueios, [{ motivo: 'ATR_BAIXO', n: 3 }, { motivo: 'SPREAD_ALTO', n: 2 }, { motivo: 'VETO_GEMINI', n: 1 }]);
  quase(r.testnet.soma, 0.1);
});

// ── RODADA 5 ──
const temTrade = (t) => fs.existsSync(path.join(t.dir, 'log.jsonl')) && lerJsonl(t).some(l => l.tipo === 'TRADE');
test.skip('R5#1a stop enviado com alvo sumido: travaOk antes do cancel; cancel false retenta só com o símbolo livre', async () => {
  assert(SRC_LIB().includes("if (!travaOk(sym, 'SL_ORFAO_CANCEL') || !(await fut.cancelarTodasOrdens(sym, { estrito: true })"));
  let t, ok = false;
  t = cicloAprovado({
    colocarStopLoss: async () => { delete t.localAlvos.ETHUSDT; },
    cancelarTodasOrdens: async () => { t.chamadas.push('cancelar'); return ok; }
  });
  t.m._estado.enabled = true;
  const erros = await capturarErros(() => t.m.tick());
  assert(erros.some(e => e.includes('[SCALP-CANCEL] ETHUSDT')));
  assert.deepStrictEqual(t.chamadas, ['alav', 'limite BUY 0.5 100 GTX', 'cancelar']);
  await capturarErros(() => t.m.monitorarTodas()); // slot ainda ocupado pelo fechamento externo: não toca
  assert.strictEqual(t.chamadas.filter(c => c === 'cancelar').length, 1);
  t.m._estado.slots[3] = { symbol: null, side: null, status: 'LIVRE', openTime: null };
  await capturarErros(() => t.m.monitorarTodas()); // falha de novo
  ok = true;
  await capturarErros(() => t.m.monitorarTodas());
  await capturarErros(() => t.m.monitorarTodas());
  assert.strictEqual(t.chamadas.filter(c => c === 'cancelar').length, 3); // retenta até passar e para
});
test.skip('R5#1b SL falhou 3x e cancel false: alvo e slot mantidos sem TRADE; retentativa grava SCALP_SL_FALHOU', async () => {
  let t, ok = false;
  t = cicloAprovado({
    colocarStopLoss: async () => { throw new Error('rejeitado'); },
    cancelarTodasOrdens: async () => { t.chamadas.push('cancelar'); return ok; }
  });
  t.m._estado.enabled = true;
  await capturarErros(() => t.m.tick());
  const a = t.localAlvos.ETHUSDT;
  assert(a && a.cancelPendente && a.fechando === false);
  assert.strictEqual(t.m._estado.slots[3].symbol, 'ETHUSDT');
  assert.strictEqual(t.desfechos.length, 0); assert(!temTrade(t));
  ok = true;
  await capturarErros(() => t.m.monitorarTodas());
  assert.strictEqual(t.localAlvos.ETHUSDT, undefined); assert.strictEqual(t.m._estado.slots[3].symbol, null);
  const tr = lerJsonl(t).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.saida_motivo, 'SCALP_SL_FALHOU'); quase(tr.saida.testnet, 100.3);
  assert.strictEqual(t.chamadas.filter(c => c.startsWith('fechar')).length, 1); // sem 2º fechamento
});
test.skip('R5#1c entrada falhou, fechou a Market e cancel false: alvo mínimo segura o slot; retentativa libera sem TRADE', async () => {
  let t, ok = false;
  t = cicloAprovado({
    consultarOrdem: async () => { throw new Error('rede'); },
    cancelarTodasOrdens: async () => { t.chamadas.push('cancelar'); return ok; }
  });
  t.m._estado.enabled = true;
  const erros = await capturarErros(() => t.m.tick());
  assert(erros.some(e => e.includes('[SCALP-CANCEL] ETHUSDT')));
  const a = t.localAlvos.ETHUSDT;
  assert(a && a.modo === 'scalp_1m' && a.cancelPendente && a.cancelPendente.semTrade === true);
  assert.strictEqual(t.m._estado.slots[3].symbol, 'ETHUSDT');
  const ev = lerJsonl(t).find(l => l.evento === 'SCALP_ENTRADA_FALHOU');
  assert.strictEqual(ev.fechada_market, true); assert.strictEqual(ev.cancel_ok, false);
  ok = true;
  await capturarErros(() => t.m.monitorarTodas());
  assert.strictEqual(t.localAlvos.ETHUSDT, undefined); assert.strictEqual(t.m._estado.slots[3].symbol, null);
  assert(!temTrade(t));
});
test('R5#1d posição sumiu e cancel false: alvo mantido; retentativa grava SCALP_DESCONHECIDO', async () => {
  let ok = false;
  const t = montarMotor({ pos: null, cancelarTodasOrdens: async () => ok });
  t.m._estado.slots[3] = { symbol: 'SOLUSDT', side: 'SHORT', status: 'x', openTime: AGORA };
  t.localAlvos.SOLUSDT = { modo: 'scalp_1m', side: 'SHORT', entryPrice: 100, slPrice: 100.3, quantidade: 1, openTime: AGORA };
  const erros = await capturarErros(() => t.m.monitorarPosicao('SOLUSDT', t.localAlvos.SOLUSDT));
  assert(erros.some(e => e.includes('[SCALP-CANCEL] SOLUSDT')));
  assert(t.localAlvos.SOLUSDT && t.localAlvos.SOLUSDT.cancelPendente);
  assert.strictEqual(t.m._estado.slots[3].symbol, 'SOLUSDT'); assert(!temTrade(t));
  ok = true;
  await t.m.monitorarPosicao('SOLUSDT', t.localAlvos.SOLUSDT);
  assert.strictEqual(t.localAlvos.SOLUSDT, undefined);
  assert.strictEqual(lerJsonl(t).find(l => l.tipo === 'TRADE').saida_motivo, 'SCALP_DESCONHECIDO');
});
test('R5#1e painel: boot e /api/close scalp com cancel false mantêm o alvo (marcarCancelPendente), sem apagar', () => {
  // boot (adaptado): scalp com alvo não é mais fechado no boot (B7c); só o /api/close segue neste caminho
  const c = bloco(SRC_PAINEL(), "app.post('/api/close'", "app.post('/api/tp-sl'");
  const iC = c.indexOf('if (!(await fut.cancelarTodasOrdens(symbol, { estrito: true }).catch(() => false))) {');
  const rc = c.slice(iC, c.indexOf('return res.json(', iC));
  assert(iC > 0 && rc.includes('scalp1m.marcarCancelPendente(symbol, aP') && !rc.includes('delete localAlvos'));
  assert(iC < c.indexOf('delete localAlvos[symbol]'));
  // motor: marcarCancelPendente com [motivo, preço] completa o desfecho e a retentativa grava a linha TRADE
  let ok = false;
  const t = montarMotor({ cancelarTodasOrdens: async () => ok });
  t.localAlvos.ETHUSDT = ALVO_ETH();
  t.m.marcarCancelPendente('ETHUSDT', t.localAlvos.ETHUSDT, { fin: ['SCALP_MANUAL', 100.3] });
  ok = true;
  return t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT).then(() => {
    assert.strictEqual(t.localAlvos.ETHUSDT, undefined);
    const tr = lerJsonl(t).find(l => l.tipo === 'TRADE');
    assert.strictEqual(tr.saida_motivo, 'SCALP_MANUAL'); quase(tr.pnl_testnet.bruto, 0.1);
  });
});
test.skip('R5#2 ENTRANDO sem alvo: emEntrada=true e /api/close devolve 409 antes de qualquer ordem', async () => {
  const c = bloco(SRC_PAINEL(), "app.post('/api/close'", "app.post('/api/tp-sl'");
  const i409 = c.indexOf('if (scalp1m.emEntrada(symbol)) {');
  assert(i409 > 0);
  assert(/return res\.status\(409\)\.json\(\{ success: false, error: 'SCALP_1M em fase ENTRANDO/.test(c.slice(i409, i409 + 300)));
  for (const s2 of ['closingInProgress.has(symbol)', 'closingInProgress.add(symbol)', 'fut.posicao(symbol)', 'fut.cancelarTodasOrdens(symbol)', 'fut.fecharMercado(symbol']) assert(i409 < c.indexOf(s2), s2);
  let t, soltar, dentro = null;
  const trava = new Promise(r => { soltar = r; });
  t = cicloAprovado({
    colocarLimite: async (sym, lado, qty, preco, opts = {}) => {
      dentro = { emEntrada: t.m.emEntrada(sym), alvo: t.localAlvos[sym] };
      await trava;
      t.chamadas.push(`limite ${lado} ${qty} ${preco} ${opts.timeInForce}`);
      return { orderId: 1, status: 'EXPIRED', executedQty: '0' };
    }
  });
  t.m._estado.enabled = true;
  assert.strictEqual(t.m.emEntrada('ETHUSDT'), false);
  const p = t.m.tick();
  for (let i = 0; i < 50 && !dentro; i++) await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(dentro, { emEntrada: true, alvo: undefined }); // ENTRANDO, alvo ainda inexistente
  assert.strictEqual(t.m.status().turnoAtual.slots[0].status, 'ENTRANDO');
  soltar(); await p;
  assert.strictEqual(t.m.emEntrada('ETHUSDT'), false); // fase encerrada no finally
});
test.skip('R5#3 órfã sem stop: rearma 0,30% antes da saída; stop já na corretora não duplica; boot rearma antes de fechar', async () => {
  const orfa = () => ({ modo: 'scalp_1m', side: 'LONG', entryPrice: 100, slPrice: 99.7, quantidade: 0.5, openTime: AGORA - HOLD, orfa: true, orfaDesde: AGORA, slNaCorretora: false });
  const t = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, openAlgoOrdens: async () => [] });
  t.localAlvos.ETHUSDT = orfa();
  await capturarErros(() => t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT));
  assert.deepStrictEqual(t.chamadas, ['sl LONG 99.7000', 'cancelar', 'fechar LONG']); // stop antes da saída
  assert(lerJsonl(t).some(l => l.evento === 'SCALP_SL_REARMADO'));
  const t2 = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, openAlgoOrdens: async () => [{ side: 'SELL', orderType: 'STOP_MARKET', closePosition: true }] });
  t2.localAlvos.ETHUSDT = orfa();
  await capturarErros(() => t2.m.monitorarPosicao('ETHUSDT', t2.localAlvos.ETHUSDT));
  assert.deepStrictEqual(t2.chamadas, ['cancelar', 'fechar LONG']); // sem stop duplicado
  // herdada no boot (iniciar): o 1º ciclo do monitor rearma antes de sair
  const t3 = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, openAlgoOrdens: async () => [] });
  t3.localAlvos.ETHUSDT = { ...orfa(), orfa: undefined, slot: 3 };
  const si = global.setInterval; global.setInterval = () => 0; // sem timers reais no teste
  try { await capturarErros(async () => { t3.m.iniciar(); await t3.m.monitorarTodas(); }); } finally { global.setInterval = si; }
  assert.deepStrictEqual(t3.chamadas.slice(0, 3), ['sl LONG 99.7000', 'cancelar', 'fechar LONG']);
  // boot do painel (adaptado): rearma o stop e NÃO fecha (B7c)
  const b = bloco(SRC_PAINEL(), 'const scalpBoot = new Set();', '// Posições remanescentes válidas');
  const iSc = b.indexOf("if (alvoExistente?.modo === 'scalp_1m') {");
  const ramo = b.slice(iSc, b.indexOf("if (p.symbol === 'MUSDT'", iSc));
  assert(ramo.includes('scalp1m.garantirStopOrfa(p.symbol, alvoExistente, p)') && !ramo.includes('fecharMercado') && !ramo.includes('cancelarTodasOrdens'));
  // stop_pct do alvo no rearme (sem slPrice); fallback 0,30%
  const t4 = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, openAlgoOrdens: async () => [] });
  t4.localAlvos.ETHUSDT = { ...orfa(), slPrice: null, stop_pct: 0.6 };
  await capturarErros(() => t4.m.garantirStopOrfa('ETHUSDT', t4.localAlvos.ETHUSDT));
  assert.deepStrictEqual(t4.chamadas, ['sl LONG 99.4000']);
  const t5 = montarMotor({ openAlgoOrdens: async () => [] });
  t5.localAlvos.ETHUSDT = { ...orfa(), slPrice: null };
  await capturarErros(() => t5.m.garantirStopOrfa('ETHUSDT', t5.localAlvos.ETHUSDT));
  assert.deepStrictEqual(t5.chamadas, ['sl LONG 99.7000']);
});
test.skip('R5#4 teto de 20 tentativas de saída: [SCALP-ORFA] + EVENTO, para de tentar, slot ocupado', async () => {
  assert.strictEqual(s.MAX_TENTATIVAS_SAIDA, 20);
  let t;
  t = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, fecharMercado: async () => { t.chamadas.push('fechar'); throw new Error('rede'); } });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = { ...ALVO_ETH(), openTime: AGORA - HOLD };
  const erros = await capturarErros(async () => { for (let i = 0; i < 25; i++) await t.m.monitorarTodas(); });
  assert.strictEqual(t.chamadas.filter(c => c === 'fechar').length, 20);
  const a = t.localAlvos.ETHUSDT;
  assert(a && a.abandonada === true && a.orfa === true && a.tentativasSaida === 20);
  assert.strictEqual(t.m._estado.slots[3].symbol, 'ETHUSDT');
  assert(erros.some(e => e.includes('[SCALP-ORFA] ALERTA ETHUSDT') && e.includes('20 tentativas')));
  const ev = lerJsonl(t).filter(l => l.evento === 'SCALP_ORFA_ABANDONADA');
  assert.strictEqual(ev.length, 1); assert.strictEqual(ev[0].simbolo, 'ETHUSDT'); assert.strictEqual(ev[0].tentativas, 20);
  // GTX expirada na saída conta 1 tentativa
  const t2 = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5 }, colocarLimite: async () => ({ orderId: 9, status: 'EXPIRED', executedQty: '0' }) });
  t2.localAlvos.ETHUSDT = ALVO_LIMITE(); t2.avancar(SAIDA);
  await capturarErros(() => t2.m.monitorarPosicao('ETHUSDT', t2.localAlvos.ETHUSDT));
  assert.strictEqual(t2.localAlvos.ETHUSDT.tentativasSaida, 1);
  // falhas abaixo do teto: a posição fecha e o contador some com o alvo
  let n = 0;
  const t3 = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, fecharMercado: async () => { if (++n <= 5) throw new Error('rede'); return { avgPrice: '100.3' }; } });
  t3.localAlvos.ETHUSDT = { ...ALVO_ETH(), openTime: AGORA - HOLD };
  await capturarErros(async () => { for (let i = 0; i < 6; i++) await t3.m.monitorarTodas(); });
  assert.strictEqual(t3.localAlvos.ETHUSDT, undefined);
  assert.strictEqual(lerJsonl(t3).find(l => l.tipo === 'TRADE').saida_motivo, 'SCALP_TEMPO_60S');
});
test('R5#5 boot: posição scalp sem alvo fora dos slots PSAR; PSAR legítimo mantido', () => {
  const f = s.posicaoScalpSemAlvo;
  assert.strictEqual(f({ symbol: 'SOLUSDT', alavancagem: 5 }, undefined), true);
  assert.strictEqual(f({ symbol: 'SOLUSDT', alavancagem: NaN }, undefined), true);  // ilegível: lado seguro (fora do PSAR)
  assert.strictEqual(f({ symbol: 'SOLUSDT', alavancagem: 3 }, undefined), false);   // PSAR automático (3x)
  assert.strictEqual(f({ symbol: 'SOLUSDT', alavancagem: 5 }, { modo: 'sar' }), false); // alvo PSAR conhecido
  assert.strictEqual(f({ symbol: 'LINKUSDT', alavancagem: 5 }, undefined), true);   // sem lista fixa: qualquer moeda 5x sem alvo
  assert.strictEqual(f({ symbol: 'LINKUSDT', alavancagem: 4 }, undefined), false);  // PSAR (teto 4x)
  assert.strictEqual(f(null, undefined), false); assert.strictEqual(f({ alavancagem: 5 }, undefined), false);
  assert.strictEqual(f({ symbol: 'ETHUSDT', alavancagem: 5 }, undefined), true);
  const src = bloco(SRC_PAINEL(), 'const posValidas =', 'for (let idx = 0; idx < posValidas.length');
  const iSem = src.indexOf('const scalpSemAlvo = scalpLib.posicaoScalpSemAlvo(p, localAlvos[p.symbol]);');
  const iRet = src.indexOf("if (!scalpSemAlvo && !scalpBoot.has(p.symbol) && localAlvos[p.symbol]?.modo !== 'scalp_1m') return true;");
  assert(iSem > 0 && iSem < iRet && iRet < src.indexOf('[SCALP-BOOT] ALERTA'));
});

// ── RODADA 6 ──
test.skip('R6#1 alvo abandonado com cancelPendente: retenta o cancel a cada ciclo, sem novas saídas; ORFA 1 vez; finaliza ao cancelar', async () => {
  let ok = false; const opts = [];
  const t = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, cancelarTodasOrdens: async (sym, o) => { t.chamadas.push('cancelar'); opts.push(o); return ok; } });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = ALVO_ETH();
  const erros = await capturarErros(async () => {
    t.m.marcarCancelPendente('ETHUSDT', t.localAlvos.ETHUSDT, { fin: ['SCALP_MANUAL', 100.3] });
    for (let i = 0; i < 25; i++) await t.m.monitorarTodas();
  });
  const a = t.localAlvos.ETHUSDT;
  assert(a && a.abandonada === true && a.cancelPendente, 'abandonada com cancel pendente');
  assert.strictEqual(t.chamadas.filter(c => c === 'cancelar').length, 25); // teto de 20 não para o cancel
  assert(t.chamadas.every(c => c === 'cancelar')); // nenhuma ordem de saída nova
  assert(opts.every(o => o && o.estrito === true));
  assert.strictEqual(erros.filter(e => e.includes('[SCALP-ORFA] ALERTA ETHUSDT')).length, 1);
  assert.strictEqual(erros.filter(e => e.includes('órfã abandonada')).length, 1); // log espaçado: sem relógio, 1 só
  const e2 = await capturarErros(async () => { t.avancar(30000); await t.m.monitorarTodas(); await t.m.monitorarTodas(); });
  assert.strictEqual(e2.filter(e => e.includes('órfã abandonada')).length, 1);
  assert(!e2.some(e => e.includes('[SCALP-ORFA]')));
  assert(!temTrade(t)); assert.strictEqual(t.m._estado.slots[3].symbol, 'ETHUSDT');
  ok = true;
  await t.m.monitorarTodas();
  assert.strictEqual(t.localAlvos.ETHUSDT, undefined);
  assert.strictEqual(t.m._estado.slots[3].symbol, null);
  assert.strictEqual(lerJsonl(t).find(l => l.tipo === 'TRADE').saida_motivo, 'SCALP_MANUAL');
  // abandonada SEM cancelPendente segue parada
  const t2 = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 } });
  t2.localAlvos.ETHUSDT = { ...ALVO_ETH(), abandonada: true, orfa: true };
  await t2.m.monitorarTodas(); await t2.m.monitorarPosicao('ETHUSDT', t2.localAlvos.ETHUSDT);
  assert.deepStrictEqual(t2.chamadas, []);
});

test('R6#2 cancelarTodasOrdens: sem opts idêntico (algoOrder falha -> true); estrito -> false; PSAR sem estrito', () => {
  const { execFileSync } = require('child_process');
  const script = `
    const Module = require('module'); const orig = Module._load;
    let falhaLista = false;
    const axios = async (cfg) => {
      if (cfg.method === 'delete' && cfg.url.includes('/fapi/v1/algoOrder')) { const e = new Error('x'); e.response = { data: { code: -1000, msg: 'falha' } }; throw e; }
      if (cfg.method === 'get' && cfg.url.includes('/fapi/v1/openAlgoOrders')) { if (falhaLista) throw new Error('lista'); return { data: [{ algoId: 1 }, { algoId: 2 }] }; }
      return { data: {} };
    };
    axios.get = async () => ({ data: {} });
    Module._load = function (req, ...r) { if (req === 'axios') return axios; if (req === 'dotenv') return { config: () => ({}) }; return orig.call(this, req, ...r); };
    const fut = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'futuresApi.js'))});
    console.error = () => {};
    (async () => {
      const a = await fut.cancelarTodasOrdens('ETHUSDT');
      const b = await fut.cancelarTodasOrdens('ETHUSDT', { estrito: true });
      falhaLista = true;
      const c = await fut.cancelarTodasOrdens('ETHUSDT');
      const d = await fut.cancelarTodasOrdens('ETHUSDT', { estrito: true });
      process.stdout.write(JSON.stringify([a, b, c, d]));
    })();`;
  const out = execFileSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, BINANCE_API_KEY: 'k', BINANCE_SECRET: 's', FUTURES_BASE: 'https://testnet.invalid' }, encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(out), [true, false, false, false]);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'futuresApi.js'), 'utf8');
  assert(src.includes('async function cancelarTodasOrdens(symbol, opts = {})'));
  // PSAR: loop/monitor, /api/close não-scalp, reverse e boot órfã sem estrito
  const p = SRC_PAINEL();
  for (const l of ['          await fut.cancelarTodasOrdens(sym);', 'if (!ehScalp) await fut.cancelarTodasOrdens(symbol);', '    await fut.cancelarTodasOrdens(symbol);', '          await fut.cancelarTodasOrdens(p.symbol).catch(() => {});', '          await fut.cancelarTodasOrdens(p.symbol);']) assert(p.includes(l), l);
});

test('CM1 cancela as ordens do símbolo ANTES da Market; pré-cancel falho: Market segue e cancela de novo; Market falha após cancelar: stop rearmado', async () => {
  let n = 0;
  const t = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, cancelarTodasOrdens: async () => { t.chamadas.push('cancelar'); return ++n > 1; } });
  t.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  t.localAlvos.ETHUSDT = ALVO_ETH(); t.avancar(HOLD);
  await t.m.monitorarPosicao('ETHUSDT', t.localAlvos.ETHUSDT);
  assert.deepStrictEqual(t.chamadas, ['cancelar', 'fechar LONG', 'cancelar']); // 1º falhou: Market não espera; refaz depois
  assert.strictEqual(t.localAlvos.ETHUSDT, undefined);
  const u = montarMotor({ pos: { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 }, fecharMercado: async () => { throw new Error('rejeitada'); }, openAlgoOrdens: async () => [] });
  u.m._estado.slots[3] = { symbol: 'ETHUSDT', side: 'LONG', status: 'x', openTime: AGORA };
  u.localAlvos.ETHUSDT = ALVO_ETH(); u.avancar(HOLD);
  await capturarErros(() => u.m.monitorarPosicao('ETHUSDT', u.localAlvos.ETHUSDT));
  assert.deepStrictEqual(u.chamadas, ['cancelar', 'sl LONG 99.8000']); // stop caiu no cancela e a Market falhou: reprotege
  assert(u.localAlvos.ETHUSDT); assert.strictEqual(u.localAlvos.ETHUSDT.slNaCorretora, true);
});

test('R6#3 todas as chamadas do scalp passam { estrito: true }', () => {
  const lib = SRC_LIB().split('\n').filter(l => l.includes('cancelarTodasOrdens('));
  assert(lib.length >= 3);
  for (const l of lib) assert(l.includes('cancelarTodasOrdens(sym, { estrito: true })'), l);
  assert(SRC_LIB().split('\n').filter(l => l.includes('cancelarAntesDaMarket(sym)')).length >= 6); // todas as demais passam pelo helper estrito
  const p = SRC_PAINEL().split('\n').filter(l => l.includes('cancelarTodasOrdens(') && l.includes('estrito'));
  assert.strictEqual(p.length, 1); // só o /api/close (o boot não fecha mais scalp com alvo)
  const c = bloco(SRC_PAINEL(), "app.post('/api/close'", "app.post('/api/tp-sl'");
  assert(c.includes('if (!(await fut.cancelarTodasOrdens(symbol, { estrito: true }).catch(() => false))) {'));
  const b = bloco(SRC_PAINEL(), 'const scalpBoot = new Set();', '// Posições remanescentes válidas');
  assert(!b.includes('ehScalpBoot'));
});

test('R6#4 painel: slots PSAR ocultos com robô OFF e sem posição; visíveis com posição', () => {
  const src = SRC_PAINEL();
  const fsrc = bloco(src, 'function psarSlotsOcultos() {', "app.get('/api/auto-status'");
  const mk = (autoBotState, localAlvos) => new Function('autoBotState', 'localAlvos', fsrc + '; return psarSlotsOcultos();')(autoBotState, localAlvos);
  const slots = (s1, s2) => ({ 1: { symbol: s1, status: 'AGUARDANDO_VIRADA_SAR' }, 2: { symbol: s2 } });
  assert.strictEqual(mk({ enabled: false, slots: slots(null, null) }, {}), true);
  assert.strictEqual(mk({ enabled: false, slots: slots(null, null) }, { ETHUSDT: { modo: 'scalp_1m' } }), true); // scalp não conta
  assert.strictEqual(mk({ enabled: false, slots: slots('SOLUSDT', null) }, {}), false);
  assert.strictEqual(mk({ enabled: false, slots: slots(null, null) }, { SOLUSDT: { modo: 'sar' } }), false);
  assert.strictEqual(mk({ enabled: true, slots: slots(null, null) }, {}), false);
  assert(src.includes('psarOcultar: psarSlotsOcultos(),'));
  assert(src.includes('<div class="grid" id="psar-grid">') && src.includes('id="psar-off-nota"'));
  const cli = bloco(src, 'async function atualizarStatusAutoBot()', 'if (d.enabled) {');
  assert(cli.includes('const psarOcultar = d.psarOcultar === true;'));
  assert(cli.includes("document.body.classList.toggle('modo-scalp', psarOcultar);"));
  assert(!cli.includes('cardHasPosition')); // posição SCALP em ETH/SOL nos cards 1/2 mantinha o PSAR na tela
  assert(src.includes("if (document.body.classList.contains('modo-scalp')) return; // PSAR fora da tela"));
});

// ── CICLO NOVO (sempre entra): fases pelo relógio, ranking de todas, voto majoritário, Gemini confirma direção ──
// Feed por símbolo que acompanha o relógio do motor; st.atrasar / st.spread forçam bloqueio duro por moeda.
function cicloNovo(books, over = {}) {
  let t;
  const st = { atrasar: new Set(), spread: new Set() };
  const feed = { iniciar: () => {}, parar: () => {}, ativo: () => true, snapshot: (sym) => {
    if (!books[sym]) return null;
    const cur = t.agora();
    const ts = st.atrasar.has(sym) ? cur - 5000 : cur - 100;
    return {
      trades: [{ T: cur - 100, p: 110, q: 3, m: false }],
      book: { bids: [[st.spread.has(sym) ? '109' : '109.99', String(books[sym][0])]], asks: [['110', String(books[sym][1])]] },
      tsTrade: ts, tsBook: ts, bufferCompleto: true
    };
  } };
  t = turnoMulti(books, { feed, ...over });
  t.st = st;
  return t;
}
const F0 = AGORA - (AGORA % 300000);

test.skip('C1 faseCiclo: 0:00-2:00 ABERTO, 2:00-4:30 ANALISE, 4:30-5:00 CONFIRMACAO, restantes da fase e do ciclo', () => {
  const f = (ms) => s.faseCiclo(F0 + ms);
  assert.deepStrictEqual(f(0), { fase: 'ABERTO', inicio: F0, dentroMs: 0, faseRestanteMs: 120000, cicloRestanteMs: 300000 });
  assert.strictEqual(f(119999).fase, 'ABERTO');
  assert.strictEqual(f(120000).fase, 'ANALISE'); assert.strictEqual(f(120000).faseRestanteMs, 150000);
  assert.strictEqual(s.SCALP_DURACAO_MS, 120000); assert.strictEqual(s.SAIDA_LIMITE_MS, 100000); // limite 1:40, Market 2:00
  assert.strictEqual(f(269999).fase, 'ANALISE');
  assert.strictEqual(f(270000).fase, 'CONFIRMACAO'); assert.strictEqual(f(270000).faseRestanteMs, 30000);
  assert.strictEqual(f(299999).fase, 'CONFIRMACAO'); assert.strictEqual(f(299999).cicloRestanteMs, 1);
  assert.strictEqual(f(300000).fase, 'ABERTO'); assert.strictEqual(f(300000).inicio, F0 + 300000);
  assert.strictEqual(s.ENTRADA_LIMITE_MS, 12000); assert.strictEqual(s.ENTRADA_REPRECO_MS, 3000); assert.strictEqual(s.GEMINI_CONFIRMA_MS, 5000); assert.strictEqual(s.ANALISE_INTERVALO_MS, 10000);
});

test.skip('C2 voto majoritário (fluxo, book, VWAP, EMA 5m, EMA 15m), desempate e condicoes_ok do lado escolhido', () => {
  const v = s.votarDirecao(base());
  assert.strictEqual(v.direcao, 'LONG'); assert.strictEqual(v.long, 5);
  assert.strictEqual(s.votarDirecao(baseShort()).direcao, 'SHORT');
  // 3 x 2: fluxo/book/vwap SHORT contra EMAs LONG = SHORT
  const m = s.votarDirecao(base({ cvd_delta_60s: -5, taker_buy_ratio_60s: 0.4, book_imbalance_10: -0.3, preco: 99 }));
  assert.strictEqual(m.direcao, 'SHORT'); assert.deepStrictEqual(m.votos, { fluxo: -1, book: -1, vwap: -1, ema5m: 1, ema15m: 1 });
  // empate 2 x 2 (book neutro): decide o fluxo
  assert.strictEqual(s.votarDirecao(base({ book_imbalance_10: 0, preco: 99, ema9_15m: 98 })).direcao, 'LONG');
  // fluxo sem CVD usa o taker; tudo neutro = NONE
  assert.strictEqual(s.votarDirecao(base({ cvd_delta_60s: 0, taker_buy_ratio_60s: 0.3, book_imbalance_10: 0, preco: 100, ema9_5m: 100, ema9_15m: 99 })).direcao, 'SHORT');
  assert.strictEqual(s.votarDirecao({}).direcao, 'NONE');
  // condicoes_ok = do lado escolhido pelo voto; passou_gate_antigo só com 5/5
  const c = s.avaliarCandidata('ETHUSDT', base({ rvol: 1, atr_1m_pct: 0.05 }));
  assert.strictEqual(c.direcao, 'LONG'); assert.strictEqual(c.condicoes_ok, 4); assert.strictEqual(c.passou_gate_antigo, false);
  assert.strictEqual(c.bloqueio, null); assert.strictEqual(c.gate.bloqueio, 'ATR_BAIXO');
  assert.strictEqual(s.avaliarCandidata('ETHUSDT', base()).passou_gate_antigo, true);
  const sh = s.avaliarCandidata('ETHUSDT', baseShort({ book_imbalance_10: 0.1 }));
  assert.strictEqual(sh.direcao, 'SHORT'); assert.strictEqual(sh.condicoes_ok, 4);
});

test('C3 bloqueio duro: dados > 3 s, campo ausente, spread > 0,05%; ATR_BAIXO, EMA divergente e condições não bloqueiam', () => {
  assert.strictEqual(s.bloqueioDuro(base({ timestamp_dados_ms: AGORA - 3001 })), 'DADOS_ATRASADOS');
  const d = base(); delete d.rvol;
  assert.strictEqual(s.bloqueioDuro(d), 'CAMPO_INVALIDO');
  assert.strictEqual(s.bloqueioDuro(base({ spread_pct: 0.051 })), 'SPREAD_ALTO');
  assert.strictEqual(s.bloqueioDuro(base({ spread_pct: 0.051, atr_1m_pct: 0.01 })), 'SPREAD_ALTO'); // ATR baixo não mascara o spread
  assert.strictEqual(s.bloqueioDuro(base({ atr_1m_pct: 0.01 })), null);
  assert.strictEqual(s.bloqueioDuro(base({ ema9_15m: 98 })), null);
  assert.strictEqual(s.bloqueioDuro(base({ rvol: 0.5, book_imbalance_10: 0 })), null);
});

test.skip('C4 ciclo pelo relógio: análise a cada 10 s, plano às 4:30 sem IA, Jev às 4:57 (3 s antes), entrada às 5:00 pelo plano', async () => {
  const posicoes = {};
  const t = cicloNovo(BOOKS4, { posicao: async (sym) => posicoes[sym] || null });
  t.m._estado.enabled = true;
  const log = path.join(t.dir, 'log.jsonl');
  t.avancar(HOLD); await t.m.tick(); // 2:02 ANÁLISE
  let st = t.m.status();
  assert.strictEqual(st.ciclo.fase, 'ANALISE'); assert.strictEqual(st.ciclo.segundosFase, 148); assert.strictEqual(st.ciclo.segundosCiclo, 178);
  assert.deepStrictEqual(st.ranking.map(r => r.simbolo), ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT']); // todas as moedas
  assert(st.ranking.every(r => r.direcao === 'LONG' && r.condicoes_ok === 5 && r.bloqueio === null && Number.isFinite(r.score)));
  assert.strictEqual(fs.existsSync(log), false); // análise não grava decisão
  assert.strictEqual(t.jevChamadas.length, 0);
  const ts1 = st.rankingTs;
  t.avancar(5000); await t.m.tick();
  assert.strictEqual(t.m.status().rankingTs, ts1); // < 10 s: sem nova análise
  t.avancar(5000); await t.m.tick();
  assert.strictEqual(t.m.status().rankingTs, t.agora()); // 10 s: ranking recalculado
  t.avancar(268000 - HOLD - 10000); await t.m.tick(); // 4:30 CONFIRMAÇÃO
  st = t.m.status();
  assert.strictEqual(st.ciclo.fase, 'CONFIRMACAO');
  assert.deepStrictEqual(t.jevChamadas, []); // 4:30: plano sem IA
  assert.deepStrictEqual(st.proximas, [{ simbolo: 'ETHUSDT', direcao: 'LONG', direcaoJev: null, jevFeito: false }, { simbolo: 'SOLUSDT', direcao: 'LONG', direcaoJev: null, jevFeito: false }]);
  t.avancar(1000); await t.m.tick();
  assert.deepStrictEqual(t.jevChamadas, []); // 4:31: ainda sem Jev
  t.avancar(25500); await t.m.tick(); // 4:56,5: ainda faltam mais de 3 s
  assert.deepStrictEqual(t.jevChamadas, []);
  t.avancar(500); await t.m.tick(); // 4:57 = 3 s antes da fronteira: dados frescos + Jev nas 2 escolhidas
  assert.deepStrictEqual([...t.jevChamadas].sort(), ['ETHUSDT', 'SOLUSDT']);
  assert.deepStrictEqual(t.m.status().proximas, [{ simbolo: 'ETHUSDT', direcao: 'LONG', direcaoJev: 'LONG', jevFeito: true }, { simbolo: 'SOLUSDT', direcao: 'LONG', direcaoJev: 'LONG', jevFeito: true }]);
  assert.deepStrictEqual(t.chamadas, []); // nenhuma ordem antes das 5:00
  t.avancar(3500); await t.m.tick(); // 5:00,5 = fronteira seguinte: entra pelo plano
  assert.strictEqual(t.jevChamadas.length, 2); // uma decisão por moeda, sem nova consulta na entrada
  assert.strictEqual(t.m._estado.slots[3].symbol, 'ETHUSDT'); assert.strictEqual(t.m._estado.slots[4].symbol, 'SOLUSDT');
  const idNovo = new Date(F0 + 300000).toISOString();
  const dec = decisoes(t);
  assert(Object.values(dec).every(l => l.turno_id === idNovo && l.candle === F0 + 300000));
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.BNBUSDT.acao, 'NAO_ESCOLHIDA');
  st = t.m.status();
  assert.strictEqual(st.ciclo.fase, 'ABERTO'); assert.strictEqual(st.turnoAtual.slots.length, 2);
  // fecha aos 60 s: TRADE com os campos novos e TURNO com moedas/direções no histórico
  posicoes.ETHUSDT = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  posicoes.SOLUSDT = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  t.avancar(HOLD + 1000); await t.m.monitorarTodas();
  const trades = lerJsonl(t).filter(l => l.tipo === 'TRADE');
  assert.strictEqual(trades.length, 2);
  for (const tr of trades) {
    assert.strictEqual(tr.condicoes_ok, 5); assert.strictEqual(tr.passou_gate_antigo, true); assert.strictEqual(tr.forcada, false);
    assert.strictEqual(tr.direcao_codigo, 'LONG'); assert.strictEqual(tr.direcao_jev, 'LONG'); assert.strictEqual(tr.turno_id, idNovo);
  }
  const tu = lerJsonl(t).find(l => l.tipo === 'TURNO');
  assert.deepStrictEqual(tu.moedas, ['ETHUSDT', 'SOLUSDT']); assert.deepStrictEqual(tu.direcoes, ['LONG', 'LONG']);
  const h = t.m.status().historico[0];
  assert.deepStrictEqual(h.moedas, ['ETHUSDT', 'SOLUSDT']); assert.deepStrictEqual(h.direcoes, ['LONG', 'LONG']); quase(h.somaLiquida, tu.soma_liquida_testnet);
  const reboot = montarMotor({ dir: t.dir, agora: t.agora() });
  assert.deepStrictEqual(reboot.m.status().historico, t.m.status().historico); // histórico refeito do JSONL no boot
});

test('CTX1 contextoMercado: retornos, RSI, faixa de 15 min, VWAP, BTC, custo x movimento esperado, histórico', () => {
  const ag = 100 * 60000;
  const ks = Array.from({ length: 40 }, (_, i) => k(i * 60000, 100 + i * 0.1, 100.2 + i * 0.1, 99.8 + i * 0.1, 100 + i * 0.1, 10)); // sobe 0,1 por candle
  const btc = Array.from({ length: 20 }, (_, i) => k(i * 300000, 1000 + i, 1000 + i, 1000 + i, 1000 + i, 1));
  const d = base({ preco: 104, vwap: 102, atr_1m_pct: 0.2, ema9_5m: 101, ema21_5m: 100, ema9_15m: 99, ema21_15m: 100 });
  const c = s.contextoMercado({ k1m: ks, dados: d, btc5m: btc, agora: ag, hist: { moeda: [0.01, -0.02], bot: [0.1, -0.05, 0.02] } });
  assert(c.ret_1m_pct > 0 && c.ret_5m_pct > c.ret_3m_pct && c.ret_15m_pct > c.ret_5m_pct);
  assert.strictEqual(c.rsi14_1m, 100); // só sobe
  assert(c.posicao_faixa_15m > 0.5 && c.posicao_faixa_15m <= 1);
  quase(c.dist_vwap_pct, (104 / 102 - 1) * 100, 1e-3); quase(c.ema_gap_5m_pct, 1, 1e-6); quase(c.ema_gap_15m_pct, -1, 1e-6);
  assert(c.btc_ret_5m_pct > 0 && c.btc_ret_60m_pct > c.btc_ret_15m_pct);
  quase(c.movimento_esperado_2min_pct, 0.2 * Math.SQRT2, 1e-3); quase(c.razao_movimento_custo, 0.2 * Math.SQRT2 / 0.1, 1e-3);
  assert.deepStrictEqual(c.ultimos_trades_moeda_usdt, [0.01, -0.02]); assert.deepStrictEqual(c.bot_ultimos_trades, { n: 3, vitorias: 2, liquido_usdt: 0.07 });
  // sem dados: campos nulos, sem exceção
  const v = s.contextoMercado({ k1m: [], dados: {}, btc5m: null, agora: ag });
  assert.strictEqual(v.ret_1m_pct, null); assert.strictEqual(v.rsi14_1m, null); assert.strictEqual(v.btc_ret_5m_pct, null); assert.strictEqual(v.razao_movimento_custo, null);
  assert.strictEqual(s.rsi14([1, 2]), null);
});
test.skip('C5 Jev timeout / resposta inválida / sem WAIT: vale a direção do código (direcao_jev null); payload e cabeçalho do Jev', async () => {
  const t = cicloNovo({ ETHUSDT: [9, 1], SOLUSDT: [8, 2] }, { jevTimeoutMs: 50, postJev: () => new Promise(() => {}) });
  t.m._estado.enabled = true;
  const ini = Date.now();
  await t.m.tick();
  assert(Date.now() - ini < 2000);
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU');
  assert.strictEqual(dec.ETHUSDT.jev.motivo, 'TIMEOUT'); assert.strictEqual(dec.ETHUSDT.direcao_jev, null);
  assert.strictEqual(dec.ETHUSDT.jev_timeout, true); assert(Number.isFinite(dec.ETHUSDT.jev_latencia_ms));
  assert.strictEqual(t.m.status().jev.falhas, 2); assert.strictEqual(t.m.status().jev.diverge, 0);
  assert.strictEqual(t.localAlvos.ETHUSDT.decisao.direcao_jev, null); assert.strictEqual(t.localAlvos.ETHUSDT.decisao.direcao_codigo, 'LONG');
  let corpo = null, cfg = null, url = null;
  const t2 = cicloNovo({ ETHUSDT: [9, 1] }, { postJev: async (u, body, c) => { url = u; corpo = corpo || body; cfg = cfg || c; return { data: { answers: { acao: { choice: 'talvez' } } } }; } });
  t2.m._estado.enabled = true;
  await t2.m.tick();
  assert.strictEqual(decisoes(t2).ETHUSDT.acao, 'ENTROU'); assert.strictEqual(decisoes(t2).ETHUSDT.jev.motivo, 'RESPOSTA_INVALIDA'); assert.strictEqual(decisoes(t2).ETHUSDT.jev_timeout, true);
  assert.strictEqual(url, 'https://api.typesafe.ai/v1/systemone'); assert.strictEqual(cfg.headers.Authorization, 'Bearer jev-key');
  assert.strictEqual(corpo.model, 'jev-latest'); assert.strictEqual(corpo.state.simbolo, 'ETHUSDT'); assert.strictEqual(corpo.state.direcao_sugerida_codigo, 'LONG');
  assert.strictEqual(corpo.state.holding_seconds, 120); assert.strictEqual(corpo.questions.acao.type, 'choice');
  assert.deepStrictEqual(Object.keys(corpo.questions.acao.criteria), ['LONG', 'SHORT', 'WAIT']);
  assert(!JSON.stringify(corpo).includes('jev-key')); // chave só no cabeçalho
  // consultarJev direto
  const ok = (choice, confidence) => async () => ({ data: { answers: { acao: { choice, confidence } }, usage: { input_tokens: 5, output_tokens: 1 } } });
  let uso = null;
  const jl = await s.consultarJev(base(), 'SHORT', {}, { apiKey: 'k', post: ok('long', 0.7), onUsage: (u) => { uso = u; } });
  assert.deepStrictEqual([jl.direcao, jl.fonte, jl.conf], ['LONG', 'JEV', 70]); assert.deepStrictEqual(uso, { input_tokens: 5, output_tokens: 1 });
  const jw = await s.consultarJev(base(), 'SHORT', {}, { apiKey: 'k', post: ok('WAIT', 0.9) });
  assert.deepStrictEqual([jw.direcao, jw.fonte, jw.motivo, jw.timeout], [null, 'CODIGO', 'WAIT', false]);
  const je = await s.consultarJev(base(), 'SHORT', {}, { apiKey: 'k', post: async () => { throw new Error('HTTP 500'); } });
  assert.strictEqual(je.direcao, null); assert(/ERRO_HTTP: HTTP 500/.test(je.motivo)); assert.strictEqual(je.timeout, true);
  assert.strictEqual((await s.consultarJev(base(), 'SHORT', {}, {})).motivo, 'SEM_JEV_API_KEY');
  assert.strictEqual(s.JEV_ANTECEDENCIA_MS, 3000);
  // contexto enviado ao Jev
  const ctxk = corpoCtx => corpoCtx.state.contexto;
  assert.deepStrictEqual(Object.keys(ctxk(corpo)).sort(), ['bot_ultimos_trades', 'btc_ret_15m_pct', 'btc_ret_5m_pct', 'btc_ret_60m_pct', 'custo_ida_e_volta_maker_pct',
    'custo_ida_e_volta_taker_pct', 'dist_vwap_pct', 'ema_gap_15m_pct', 'ema_gap_5m_pct', 'movimento_esperado_2min_pct', 'posicao_faixa_15m',
    'razao_movimento_custo', 'ret_15m_pct', 'ret_1m_pct', 'ret_3m_pct', 'ret_5m_pct', 'rsi14_1m', 'ultimos_trades_moeda_usdt']);
  assert.strictEqual(ctxk(corpo).custo_ida_e_volta_taker_pct, 0.1); assert.strictEqual(ctxk(corpo).custo_ida_e_volta_maker_pct, 0.04);
  assert(/razao_movimento_custo/.test(corpo.questions.acao.instructions) && /NET of fees/.test(corpo.questions.acao.instructions));
  // prazo duro: promessa lenta devolve PRAZO_JEV (sem segurar o processo); rápida devolve o valor
  assert.strictEqual(await s.comPrazo(new Promise(() => {}), 20), 'PRAZO_JEV');
  assert.strictEqual(await s.comPrazo(Promise.resolve('ok'), 1000), 'ok');
  assert(SRC_LIB().includes("if (dir !== 'LONG' && dir !== 'SHORT') throw new Error")); // direção inválida: sem ordem
});

test.skip('C6 bloqueio duro pula para a próxima do ranking (spread na 1ª, dado atrasado na 2ª: entram a 3ª e a 4ª); recheque na entrada também pula', async () => {
  const t = cicloNovo(BOOKS4);
  t.st.spread.add('ETHUSDT'); t.st.atrasar.add('SOLUSDT');
  t.m._estado.enabled = true;
  await t.m.tick();
  let dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.bloqueio_duro, 'SPREAD_ALTO'); assert.strictEqual(dec.ETHUSDT.acao, 'BLOQUEADA');
  assert.strictEqual(dec.SOLUSDT.bloqueio_duro, 'DADOS_ATRASADOS'); assert.strictEqual(dec.SOLUSDT.acao, 'BLOQUEADA');
  assert.strictEqual(dec.BNBUSDT.acao, 'ENTROU'); assert.strictEqual(dec.XRPUSDT.acao, 'ENTROU');
  assert.deepStrictEqual([...t.jevChamadas].sort(), ['BNBUSDT', 'XRPUSDT']);
  assert.strictEqual(t.m._estado.slots[3].symbol, 'BNBUSDT'); assert.strictEqual(t.m._estado.slots[4].symbol, 'XRPUSDT');
  const bl = t.m.status().hoje.top3Bloqueios.map(b => b.motivo).sort();
  assert.deepStrictEqual(bl, ['DADOS_ATRASADOS', 'SPREAD_ALTO']);
  // plano feito às 4:30; às 5:00 o feed da 1ª ficou atrasado: entra a 3ª
  const t2 = cicloNovo(BOOKS4);
  t2.m._estado.enabled = true;
  t2.avancar(270000); await t2.m.tick();
  t2.st.atrasar.add('ETHUSDT');
  t2.avancar(29000); await t2.m.tick();
  dec = decisoes(t2);
  assert.strictEqual(dec.ETHUSDT.acao, 'DADOS_ATRASADOS_ENTRADA');
  assert.strictEqual(t2.m._estado.slots[3].symbol, 'SOLUSDT'); assert.strictEqual(t2.m._estado.slots[4].symbol, 'BNBUSDT');
  // nenhuma passa no bloqueio duro: turno vazio com alerta do motivo de cada uma
  const t3 = cicloNovo({ ETHUSDT: [9, 1] });
  t3.st.spread.add('ETHUSDT');
  t3.m._estado.enabled = true;
  const avisos = await capturar('warn', () => t3.m.tick());
  const tu = lerJsonl(t3).find(l => l.tipo === 'TURNO');
  assert.strictEqual(tu.motivo, 'SEM_CANDIDATA_VALIDA'); assert.strictEqual(tu.bloqueios.ETHUSDT, 'SPREAD_ALTO');
  assert(avisos.some(l => l.startsWith('[SCALP-ALERTA]') && l.includes('ETHUSDT')));
});

test.skip('C7 TRADE forçado (gate antigo reprovaria): passou_gate_antigo=false, forcada=true, condicoes_ok do lado', async () => {
  const t = cicloNovo({ ETHUSDT: [5, 5] }, { posicao: async () => t.posAtual || null }); // book neutro: 4/5 condições
  t.m._estado.enabled = true;
  await t.m.tick();
  const dec = decisoes(t).ETHUSDT;
  assert.strictEqual(dec.acao, 'ENTROU'); assert.strictEqual(dec.passou_gate_antigo, false); assert.strictEqual(dec.condicoes_ok, 4);
  t.posAtual = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  t.avancar(HOLD + 1000); await t.m.monitorarTodas();
  const tr = lerJsonl(t).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.passou_gate_antigo, false); assert.strictEqual(tr.forcada, true); assert.strictEqual(tr.condicoes_ok, 4);
  assert.strictEqual(tr.direcao_codigo, 'LONG'); assert.strictEqual(tr.direcao_jev, 'LONG');
  // TRADE externo sem decisão (legado): campos novos nulos
  const t2 = montarMotor();
  t2.m.registrarTradeExterno('ETHUSDT', { ...ALVO_ETH(), quantidade: 0.5 }, 'SCALP_MANUAL', 100.3);
  const l2 = lerJsonl(t2)[0];
  assert.strictEqual(l2.passou_gate_antigo, null); assert.strictEqual(l2.forcada, null); assert.strictEqual(l2.direcao_jev, null);
});

test('C8 script de expectativa: separa expectativa líquida passou_gate_antigo=true x false', () => {
  const tr = (liq, passou) => ({ tipo: 'TRADE', saida_motivo: 'SCALP_TEMPO_60S', pnl_testnet: { liquido: liq }, pnl_mainnet: { liquido: liq / 2 }, ...(passou === undefined ? {} : { passou_gate_antigo: passou }) });
  const r = resumir([tr(0.3, true), tr(0.1, true), tr(-0.2, false), tr(-0.4, false), tr(0.05, false), tr(1)]);
  assert.strictEqual(r.porGateAntigo.passou.testnet.n, 2); quase(r.porGateAntigo.passou.testnet.expectativa, 0.2);
  assert.strictEqual(r.porGateAntigo.forcada.testnet.n, 3); quase(r.porGateAntigo.forcada.testnet.expectativa, -0.55 / 3);
  quase(r.porGateAntigo.forcada.mainnet.soma, -0.275);
  assert.strictEqual(r.porGateAntigo.semCampo, 1);
  quase(r.testnet.soma, 0.85);
  const d = resumir([{ tipo: 'DECISAO', bloqueio_duro: null, gate: { ok: false, bloqueio: 'ATR_BAIXO' }, acao: 'ENTROU' }]);
  assert.deepStrictEqual(d.decisoes.bloqueios, { SEM_BLOQUEIO_DURO: 1 }); // ATR_BAIXO não conta como bloqueio no ciclo novo
});

test('C9 guarda PSAR enabled:false: loop/janela, /api/trade e /api/reverse não enviam ordem', async () => {
  const src = SRC_PAINEL();
  // loop de entrada: o setInterval só roda com enabled e executarEntradaSar recusa antes de qualquer chamada à corretora
  assert(src.includes('  if (!autoBotState.enabled || autoBotLoopRunning) return;'));
  const fsrc = bloco(src, 'async function executarEntradaSar(sym, dir, alav) {', '// Saída: Limite passivo');
  const linhas = fsrc.split('\n');
  assert(linhas[1].startsWith("  if (!autoBotState.enabled) return { ok: false, motivo: 'PSAR desligado (enabled:false)"));
  const chamadas = [];
  const fut = new Proxy({}, { get: (o, k) => async () => { chamadas.push(k); return null; } });
  const exec = new Function('autoBotState', 'fut', 'MARGEM_POR_SLOT', fsrc + '; return executarEntradaSar;')({ enabled: false }, fut, 10);
  const r = await exec('ETHUSDT', 'LONG', 3);
  assert.strictEqual(r.ok, false); assert(/PSAR desligado/.test(r.motivo));
  assert.deepStrictEqual(chamadas, []); // nenhuma consulta nem ordem
  // único chamador no loop: a janela de decisão passa por executarEntradaSar antes de registrarPosicaoSar
  assert.strictEqual((src.match(/executarEntradaSar\(/g) || []).length, 2);
  // /api/trade e /api/reverse: guarda antes de qualquer fut.*
  for (const [ini, fim] of [["app.post('/api/trade'", "app.post('/api/close'"], ["app.post('/api/reverse'", 'function psarSlotsOcultos()']]) {
    const b = bloco(src, ini, fim);
    const iG = b.indexOf('if (!autoBotState.enabled) throw new Error(');
    assert(iG > 0, ini);
    assert(iG < b.indexOf('fut.'), ini);
  }
  // abrirMercado/colocarLimite de entrada no painel: só nesses 3 caminhos (boot só sincroniza posição existente)
  assert.strictEqual((src.match(/fut\.abrirMercado\(/g) || []).length, 1);
});

// ── FORA 1 CICLO (sem geladeira: prejuízo, zero ou erro técnico fica fora SÓ do próximo ciclo) ──
const alvoG = (turnoId = null) => ({ modo: 'scalp_1m', side: 'LONG', entryPrice: 100, quantidade: 0.5, openTime: AGORA, turnoId });
// Marca as moedas como fora no ciclo atual (=> fora do seguinte) e avança o relógio para o ciclo seguinte, motor ligado.
const foraDoCiclo = (syms, books = BOOKS4, over = {}) => {
  const t = turnoMulti(books, over);
  syms.forEach(x => t.m._classificarFora(x, 'SCALP_TEMPO_60S', { liquido: -1 }));
  t.avancar(300000);
  t.m._estado.enabled = true;
  return t;
};
test('FC1 prejuízo e zero marcam fora do PRÓXIMO ciclo; lucro não marca; EVENTO SCALP_FORA_1_CICLO; geladeira não existe mais', () => {
  const t = montarMotor();
  const sai = (sym, motivo, saida) => { t.localAlvos[sym] = alvoG(); t.m._registrarTrade(sym, t.localAlvos[sym], motivo, saida, null, 0); };
  sai('ETHUSDT', 'SCALP_TEMPO_60S', 99.9);       // prejuízo
  sai('SOLUSDT', 'SCALP_TEMPO_LIMITE', 100.035); // lucro bruto < taxas: líquido negativo
  sai('BNBUSDT', 'SCALP_TEMPO_60S', 101);        // lucro
  const st = t.m.status();
  assert.deepStrictEqual([...st.fora1Ciclo].sort(), ['ETHUSDT', 'SOLUSDT']);
  const ev = lerJsonl(t).filter(l => l.evento === 'SCALP_FORA_1_CICLO');
  assert.deepStrictEqual(ev.map(e => e.simbolo), ['ETHUSDT', 'SOLUSDT']);
  assert(ev[0].liquido < 0); assert.strictEqual(ev[0].ciclo_fora_ms, AGORA + s.TURNO_MS);
  assert(!('geladeira' in st)); assert(!('geladeiraMs' in st.config));
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scalp1m.js'), 'utf8');
  assert(!/GELADEIRA_MS|salvarGeladeira|lerGeladeira|scalp_geladeira/.test(src));
});
test('FC2 líquido zero, PnL desconhecido (erro técnico) e qualquer motivo com perda marcam; lucro (inclusive SL_EMERG) não', () => {
  const t = montarMotor();
  const pnlZero = s.calcularPnl({ lado: 'LONG', qty: 1, entrada: 100, saida: 100, taxaPct: 0 });
  assert.strictEqual(pnlZero.liquido, 0);
  t.m._classificarFora('ETHUSDT', 'SCALP_TEMPO_60S', pnlZero);
  t.m._classificarFora('SOLUSDT', 'SCALP_SL_EMERG', { liquido: 0.5 }); // lucro: não marca
  t.m._classificarFora('XRPUSDT', 'SCALP_SL_FALHOU', { liquido: -0.1 });
  t.m._classificarFora('BNBUSDT', 'SCALP_DESCONHECIDO', null);         // PnL desconhecido = erro técnico
  assert.deepStrictEqual([...t.m.status().fora1Ciclo].sort(), ['BNBUSDT', 'ETHUSDT', 'XRPUSDT']);
  // fechamento externo (SCALP_MANUAL) com prejuízo também marca
  const u = montarMotor();
  u.localAlvos.BNBUSDT = alvoG();
  u.m.registrarTradeExterno('BNBUSDT', u.localAlvos.BNBUSDT, 'SCALP_MANUAL', 90);
  assert(u.m.status().fora1Ciclo.includes('BNBUSDT'));
});
test.skip('FC3 moeda fora é pulada no ciclo seguinte (FORA_1_CICLO, sem Jev) e o turno escolhe a próxima; selo no ranking', async () => {
  const b = turnoMulti(BOOKS4);
  await b.m._analisar();
  b.m._classificarFora('ETHUSDT', 'SCALP_TEMPO_60S', { liquido: -1 });
  const rk0 = b.m.status().ranking;
  assert.strictEqual(rk0.find(c => c.simbolo === 'ETHUSDT').fora1Ciclo, true);
  assert.strictEqual(rk0.find(c => c.simbolo === 'SOLUSDT').fora1Ciclo, false);
  assert.deepStrictEqual(b.m.status().fora1Ciclo, ['ETHUSDT']);
  const t = foraDoCiclo(['ETHUSDT']);
  await t.m.tick();
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'FORA_1_CICLO');
  assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU'); assert.strictEqual(dec.BNBUSDT.acao, 'ENTROU');
  assert(!t.jevChamadas.includes('ETHUSDT')); // fora 1 ciclo: nem chega ao Jev
});
test('FC4 depois de 1 ciclo a moeda volta normalmente (selo some, elegível de novo)', async () => {
  const t = foraDoCiclo(['ETHUSDT']);
  await t.m.tick(); // ciclo em que ETH está fora
  t.avancar(300000); // ciclo seguinte: ETH volta
  assert.deepStrictEqual(t.m.status().fora1Ciclo, []);
  const plano = await t.m._confirmar(AGORA - (AGORA % 300000) + 600000);
  assert.notStrictEqual(plano.regs.find(r => r.simbolo === 'ETHUSDT').acao, 'FORA_1_CICLO');
});
test.skip('FC5 menos de 2 elegíveis: entra com 1; 0 elegíveis = TURNO VAZIO FORA_1_CICLO_TODAS / FORA_1_CICLO_E_BLOQUEIOS', async () => {
  const a = foraDoCiclo(['ETHUSDT', 'SOLUSDT', 'BNBUSDT']);
  await a.m.tick();
  assert.strictEqual(decisoes(a).XRPUSDT.acao, 'ENTROU');
  assert.strictEqual(a.m._estado.slots[3].symbol, 'XRPUSDT'); assert.strictEqual(a.m._estado.slots[4].symbol, null);
  const b = foraDoCiclo(UNIVERSO_TESTE);
  await b.m.tick();
  const tu = lerJsonl(b).find(l => l.tipo === 'TURNO');
  assert.strictEqual(tu.status, 'VAZIO'); assert.strictEqual(tu.motivo, 'FORA_1_CICLO_TODAS');
  assert.strictEqual(tu.fora.length, 4); assert.strictEqual(tu.bloqueios.ETHUSDT, 'FORA_1_CICLO');
  const c = foraDoCiclo(['ETHUSDT'], { ETHUSDT: [9, 1] }); // demais sem feed: bloqueio duro
  await c.m.tick();
  assert.strictEqual(lerJsonl(c).find(l => l.tipo === 'TURNO').motivo, 'FORA_1_CICLO_E_BLOQUEIOS');
});
test.skip('FC6 erro técnico na entrada (book testnet vazio) tira a moeda do próximo ciclo; o turno segue para a próxima', async () => {
  const t = turnoMulti(BOOKS4, { livroOfertas: async (sym) => (sym === 'ETHUSDT' ? { bids: [], asks: [] } : { bids: [['100', '10']], asks: [['100.1', '10']] }) });
  t.m._estado.enabled = true;
  await t.m.tick();
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTRADA_FALHOU');
  assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU'); assert.strictEqual(dec.BNBUSDT.acao, 'ENTROU');
  assert.deepStrictEqual(t.m.status().fora1Ciclo, ['ETHUSDT']);
});
test.skip('FC7 ciclo real: prejuízo no turno 1 tira ETH e SOL do turno 2, que entra BNB e XRP', async () => {
  let posAtual = null;
  const t = turnoMulti(BOOKS4, { posicao: async () => posAtual, fecharMercado: async () => ({ avgPrice: '99.5' }) });
  t.m._estado.enabled = true;
  await t.m.tick();
  assert.strictEqual(decisoes(t).ETHUSDT.acao, 'ENTROU');
  posAtual = { lado: 'LONG', quantidade: 0.5, precoMarca: 99.5 };
  t.avancar(HOLD + 1000); await t.m.monitorarTodas();
  posAtual = null;
  assert(lerJsonl(t).some(l => l.evento === 'SCALP_FORA_1_CICLO' && l.simbolo === 'ETHUSDT'));
  t.avancar(299000 - HOLD); await t.m.tick();
  const ult = (sym) => lerJsonl(t).filter(l => l.tipo === 'DECISAO' && l.simbolo === sym).pop().acao;
  assert.strictEqual(ult('ETHUSDT'), 'FORA_1_CICLO'); assert.strictEqual(ult('SOLUSDT'), 'FORA_1_CICLO');
  assert.strictEqual(ult('BNBUSDT'), 'ENTROU'); assert.strictEqual(ult('XRPUSDT'), 'ENTROU');
});

// ── UNIVERSO DINÂMICO / FEED SEM BURACO / 2 ENTRADAS / NUMERAÇÃO (rodada ranking 15 min) ──
const capturar = async (metodo, fn) => {
  const linhas = []; const orig = console[metodo]; console[metodo] = (...a) => linhas.push(a.join(' '));
  try { await fn(); } finally { console[metodo] = orig; }
  return linhas;
};
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const FILTRO_OK = { minNotional: 5, stepSize: '0.001', minQty: 0.001 };
const symInfo = (symbol, o = {}) => ({ symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', onboardDate: AGORA - 400 * 86400000, ...o });

test('U1 (adaptado) filtros do universo: exclui as 4, volume >= 50 M, spread <= 0,05%, TRADING no testnet, minNotional cabe em 10 x 5x', () => {
  const syms = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'OKUSDT', 'VOLBAIXOUSDT', 'VOLLIMUSDT', 'LARGOUSDT', 'SPRLIMUSDT',
    'SEMTESTUSDT', 'MINALTOUSDT', 'STEPUSDT', 'ARREDUSDT', 'ARREDOKUSDT'];
  const info = { symbols: [...syms.map(x => symInfo(x)), symInfo('TRIMUSDT_260327', { contractType: 'CURRENT_QUARTER' }),
    symInfo('PARADOUSDT', { status: 'SETTLING' }), symInfo('OUTROBUSD', { quoteAsset: 'BUSD' })] };
  const vol = { VOLBAIXOUSDT: 49999999, VOLLIMUSDT: 50000000 };
  const tickers = [...syms, 'TRIMUSDT_260327', 'PARADOUSDT', 'OUTROBUSD'].map(x => ({ symbol: x, quoteVolume: String(vol[x] ?? 5e8) }));
  const preco = { STEPUSDT: 1000, ARREDUSDT: 3, ARREDOKUSDT: 3 };
  const books = tickers.map(({ symbol }) => {
    const p = preco[symbol] || 10;
    if (symbol === 'SPRLIMUSDT') return { symbol, bidPrice: '9.9975', askPrice: '10.0025' }; // 0,05% (limite: entra)
    const sp = symbol === 'LARGOUSDT' ? 0.0006 : 0.0001; // fração do preço
    return { symbol, bidPrice: String(p * (1 - sp / 2)), askPrice: String(p * (1 + sp / 2)) };
  });
  const testnet = {
    SEMTESTUSDT: null, MINALTOUSDT: { ...FILTRO_OK, minNotional: 100 }, STEPUSDT: { minNotional: 5, stepSize: '1', minQty: 1 },
    ARREDUSDT: { minNotional: 50, stepSize: '1', minQty: 1 }, ARREDOKUSDT: { minNotional: 5, stepSize: '1', minQty: 1 }
  };
  const r = s.filtrarUniverso({ info, tickers, books, filtroTestnet: (x) => (x in testnet ? testnet[x] : FILTRO_OK) });
  assert.deepStrictEqual(r.lista.map(c => c.simbolo).sort(), ['ARREDOKUSDT', 'OKUSDT', 'SPRLIMUSDT', 'VOLLIMUSDT']);
  assert.deepStrictEqual(r.descartes, { EXCLUIDO: 4, VOLUME: 1, SPREAD: 1, FORA_TESTNET: 1, MIN_NOTIONAL: 3 });
  const ok = r.lista.find(c => c.simbolo === 'OKUSDT');
  assert.strictEqual(ok.volume_24h, 5e8); quase(ok.spread_pct, 0.01, 1e-9);
  // arredondamento por stepSize: 50/3 = 16,67 -> 16 x 3 = 48 < minNotional 50
  assert.strictEqual(s.cabeNaMargem({ minNotional: 50, stepSize: '1', minQty: 1 }, 3), false);
  assert.strictEqual(s.cabeNaMargem({ minNotional: 50, stepSize: '0.001', minQty: 0.001 }, 3), false); // 16,666 x 3 = 49,998
  assert.strictEqual(s.cabeNaMargem({ minNotional: 50, stepSize: '0.001', minQty: 0.001 }, 2.5), true); // 20 x 2,5 = 50
  assert.strictEqual(s.cabeNaMargem({ minNotional: 50.01, stepSize: '0.001' }, 3), false);
});

test.skip('U2 rodízio (montarLista20): novas com ATR em [0,15%; 0,60%] primeiro, depois repetidas, depois ATR mais próximo da faixa; sempre 20', () => {
  assert.strictEqual(s.corteAtr(0.15), null); assert.strictEqual(s.corteAtr(0.60), null);
  assert.strictEqual(s.corteAtr(0.6001), 'ATR_ALTO'); assert.strictEqual(s.corteAtr(0.1499), 'ATR_BAIXO'); assert.strictEqual(s.corteAtr(null), 'ATR_INVALIDO');
  assert.strictEqual(s.ATR_MIN_PCT, 0.15); assert.strictEqual(s.ATR_MAX_PCT, 0.60);
  assert.strictEqual(s.RANKING_MAX, 20); assert.strictEqual(s.ROTACAO_CICLOS, 6); assert.strictEqual(s.RANKING_INTERVALO_MS, 6 * 300000);
  // (a) 23 em faixa (0,16..0,60); anterior = C20..C25 (topo da faixa): 17 novas (ATR decrescente) + 3 repetidas
  const uni = Array.from({ length: 40 }, (_, i) => ({ simbolo: `C${i}`, atr_pct: (10 + i * 2) / 100, volume_24h: 1e8 + i }));
  uni.push({ simbolo: 'NULO', atr_pct: null, volume_24h: 1e9 });
  const ant = ['C20', 'C21', 'C22', 'C23', 'C24', 'C25'];
  const a = s.montarLista20(uni, ant);
  assert.strictEqual(a.length, 20); assert.strictEqual(new Set(a.map(c => c.simbolo)).size, 20);
  assert(!a.some(c => c.simbolo === 'NULO'));
  assert.deepStrictEqual(a.slice(0, 17).map(c => c.simbolo), Array.from({ length: 17 }, (_, i) => `C${19 - i}`));
  assert(a.slice(0, 17).every(c => c.origem === 'NOVA' && c.atr_pct >= 0.15 && c.atr_pct <= 0.60));
  assert.deepStrictEqual(a.slice(17).map(c => `${c.simbolo}:${c.origem}`), ['C25:REPETIDA', 'C24:REPETIDA', 'C23:REPETIDA']);
  // (b) poucas em faixa: 10 novas + 3 repetidas + 7 de ATR mais próximo da faixa (por distância)
  const mk = (sim, atr) => ({ simbolo: sim, atr_pct: atr, volume_24h: 1e8 });
  const uniB = [
    ...Array.from({ length: 10 }, (_, i) => mk(`N${i}`, 0.20 + i / 100)), mk('P0', 0.30), mk('P1', 0.31), mk('P2', 0.32),
    mk('L0', 0.14), mk('L1', 0.13), mk('L2', 0.12), mk('L3', 0.11), mk('L4', 0.10),
    mk('H0', 0.605), mk('H1', 0.615), mk('H2', 0.635), mk('H3', 0.655), mk('H4', 0.675)
  ];
  const b = s.montarLista20(uniB, ['P0', 'P1', 'P2']);
  assert.strictEqual(b.length, 20);
  assert.deepStrictEqual(b.slice(0, 10).map(c => c.simbolo), ['N9', 'N8', 'N7', 'N6', 'N5', 'N4', 'N3', 'N2', 'N1', 'N0']);
  assert.deepStrictEqual(b.slice(10, 13).map(c => `${c.simbolo}:${c.origem}`), ['P2:REPETIDA', 'P1:REPETIDA', 'P0:REPETIDA']);
  assert.deepStrictEqual(b.slice(13).map(c => `${c.simbolo}:${c.origem}`), ['H0:ATR_PROXIMO', 'L0:ATR_PROXIMO', 'H1:ATR_PROXIMO', 'L1:ATR_PROXIMO', 'L2:ATR_PROXIMO', 'H2:ATR_PROXIMO', 'L3:ATR_PROXIMO']);
  // (c) anterior fora da faixa fica depois das repetidas em faixa; universo menor que 20 = só as que houver; sem anterior = tudo NOVA
  const c = s.montarLista20([mk('A', 0.30), mk('B', 0.90), mk('C', 0.20)], ['B', 'C']);
  assert.deepStrictEqual(c.map(x => `${x.simbolo}:${x.origem}`), ['A:NOVA', 'C:REPETIDA', 'B:REPETIDA']);
  assert(s.montarLista20(uniB, []).slice(0, 13).every(x => x.origem === 'NOVA'));
  assert.deepStrictEqual(s.montarLista20(null, null), []);
});

test('U2b desempate: score com diferença < 10% -> maior volume 24h vence; >= 10% -> score vence', () => {
  const c = (sim, imb, vol) => ({ simbolo: sim, volume_24h: vol, dados: base({ taker_buy_ratio_60s: 0.5, rvol: 2, book_imbalance_10: imb }) });
  const r = s.rankearCandidatas([c('A', 0.50, 1e8), c('B', 0.46, 5e8), c('C', 0.44, 9e8), c('D', 0.30, 9e9)]);
  quase(r.find(x => x.simbolo === 'A').score, 0.5);
  assert.deepStrictEqual(r.map(x => x.simbolo), ['B', 'A', 'C', 'D']); // B (8%) passa A pelo volume; C (12%) e D (40%) ficam atrás do líder
  assert.strictEqual(s.DESEMPATE_SCORE_PCT, 0.10);
  const sem = s.rankearCandidatas([c('X', 0.50, null), c('Y', 0.49, 1)]); // volume ausente fica por último no grupo
  assert.deepStrictEqual(sem.map(x => x.simbolo), ['Y', 'X']);
  const iguais = s.rankearCandidatas([c('P', 0.3, 1), c('Q', 0.3, 2)]);
  assert.deepStrictEqual(iguais.map(x => x.simbolo), ['Q', 'P']);
});

// Mercado mainnet mock (exchangeInfo/ticker/bookTicker/klines) com ATR por símbolo mutável.
function mercadoMock(atr) {
  const chamadas = { exchangeInfo: 0, klines: 0 };
  const t0 = AGORA - (AGORA % 300000);
  const ksAtr = (pct) => { const h = pct / 2; const ks = []; for (let i = 0; i < 40; i++) ks.push(k(t0 - (41 - i) * 60000, 100, 100 + h, 100 - h, 100, 10)); return ks; };
  return {
    chamadas,
    rest: {
      exchangeInfo: async () => { chamadas.exchangeInfo++; return { symbols: Object.keys(atr).map(x => symInfo(x)) }; },
      ticker24h: async () => Object.keys(atr).map(symbol => ({ symbol, quoteVolume: '50000000' })),
      bookTicker: async () => Object.keys(atr).map(symbol => ({ symbol, bidPrice: '99.999', askPrice: '100.001' })),
      klines: async (sym) => { chamadas.klines++; if (atr[sym] === 'erro') throw new Error('timeout'); return ksAtr(atr[sym]); }
    }
  };
}
function feedMock() {
  const assinados = new Set(); const log = { assinar: [], desassinar: [], aquecer: [] };
  return {
    log, assinados,
    iniciar: () => {}, parar: () => {}, ativo: () => true, snapshot: () => null,
    simbolos: () => [...assinados],
    assinar: (l) => { log.assinar.push(l.slice()); l.forEach(x => assinados.add(x)); },
    desassinar: (l) => { log.desassinar.push(l.slice()); l.forEach(x => assinados.delete(x)); },
    aquecer: async (x) => { log.aquecer.push(x); return true; }
  };
}

test.skip('U3 boot sem lista: carrega o ranking antes de aceitar entradas; assina e aquece as 20; JSONL RANKING + [SCALP-RANKING]', async () => {
  const atr = {}; for (let i = 1; i <= 25; i++) atr[`S${String(i).padStart(2, '0')}USDT`] = 0.5 - i * 0.01;
  atr.ERRUSDT = 'erro'; // tolerância a erro por símbolo
  const mk = mercadoMock(atr); const feed = feedMock();
  const t = montarMotor({ universoInicial: null, rest: mk.rest, feed, filtroTestnet: () => FILTRO_OK, agora: AGORA - (AGORA % 300000) + 130000 }); // 2:10 = ANÁLISE
  assert.deepStrictEqual(t.m.status().simbolos, []);
  t.m._estado.enabled = true;
  const out = await capturar('log', () => t.m.tick());
  const st = t.m.status();
  assert.strictEqual(st.simbolos.length, 20);
  assert.strictEqual(st.simbolos[0], 'S01USDT'); assert.strictEqual(st.simbolos[19], 'S20USDT');
  assert.strictEqual(feed.log.assinar[0].length, 20);
  assert.deepStrictEqual(feed.log.aquecer.slice().sort(), st.simbolos.slice().sort()); // warmup REST no boot
  assert(out.some(l => l.startsWith('[SCALP-RANKING] troca de lista: 20 moedas | 20 novas, 0 repetidas: S01USDT 0.490% 50M NOVA')));
  const rk = lerJsonl(t).find(l => l.tipo === 'RANKING');
  assert.strictEqual(rk.moedas.length, 20); quase(rk.moedas[0].atr_pct, 0.49, 1e-9); assert.strictEqual(rk.moedas[0].volume_24h, 50000000);
  assert.strictEqual(rk.moedas[0].origem, 'NOVA'); assert.strictEqual(rk.novas.length, 20); assert.deepStrictEqual(rk.repetidas, []);
  assert.strictEqual(st.rotacao.ciclosRestantes, 6); assert.strictEqual(st.rotacao.ciclosTotal, 6);
  assert(st.universo.every(u => Number.isFinite(u.atr_pct)));
  assert.strictEqual(st.ranking.length, 20); // análise rodou sobre as 20 (status expõe 20 com atr)
  assert(st.ranking.every(r => 'atr' in r && r.volume_24h === 50000000 && r.fora1Ciclo === false));
  // ranking falhou e lista vazia: nenhuma entrada (tick sai antes do ciclo)
  const u = montarMotor({ universoInicial: null, rest: { klines: async () => [] }, feed: feedMock(), agora: AGORA - (AGORA % 300000) + 2000 });
  u.m._estado.enabled = true;
  await capturar('warn', () => u.m.tick());
  assert.deepStrictEqual(u.chamadas, []); assert.strictEqual(fs.existsSync(path.join(u.dir, 'log.jsonl')), false);
});

test.skip('U4 rodízio a cada 6 ciclos / 30 min (relógio injetável): nova assinada+aquecida, saída desassinada, com posição nunca desassinada', async () => {
  const atr = {}; for (let i = 1; i <= 22; i++) atr[`S${String(i).padStart(2, '0')}USDT`] = 0.5 - i * 0.01;
  const mk = mercadoMock(atr); const feed = feedMock();
  const t = montarMotor({ universoInicial: null, rest: mk.rest, feed, filtroTestnet: () => FILTRO_OK, agora: AGORA - (AGORA % 300000) + 130000 }); // 2:10 = ANÁLISE
  t.m._estado.enabled = true;
  await capturar('log', () => t.m.tick());
  assert.strictEqual(mk.chamadas.exchangeInfo, 1);
  atr.S01USDT = 0.10; atr.S02USDT = 0.12;                // saem do ranking
  t.localAlvos.S02USDT = { modo: 'scalp_1m', side: 'LONG' }; // S02 tem posição aberta
  feed.log.aquecer.length = 0;
  const F0u = AGORA - (AGORA % 300000);
  t.avancar(F0u + 6 * 300000 - 1 - t.agora()); // 1 ms antes do 6º ciclo seguinte
  await capturar('log', () => t.m.tick()); await flush();
  assert.strictEqual(mk.chamadas.exchangeInfo, 1); // antes de 6 ciclos: sem troca
  assert.strictEqual(t.m.status().rotacao.ciclosRestantes, 1);
  t.avancar(1);
  await capturar('log', async () => { await t.m.tick(); await flush(); });
  assert.strictEqual(mk.chamadas.exchangeInfo, 2);
  const st = t.m.status();
  assert(!st.simbolos.includes('S01USDT') && !st.simbolos.includes('S02USDT'));
  assert(st.simbolos.includes('S21USDT') && st.simbolos.includes('S22USDT'));
  assert.deepStrictEqual(feed.log.desassinar.pop(), ['S01USDT']);  // S02 (posição) não sai do WS
  assert(feed.assinados.has('S02USDT'));
  assert.deepStrictEqual(feed.log.assinar.pop().sort(), ['S21USDT', 'S22USDT']);
  assert.deepStrictEqual(feed.log.aquecer.sort(), ['S21USDT', 'S22USDT']);
  const rks = lerJsonl(t).filter(l => l.tipo === 'RANKING');
  assert.strictEqual(rks.length, 2); assert.deepStrictEqual(rks[1].sairam, ['S01USDT']);
  assert.deepStrictEqual(rks[1].novas.sort(), ['S21USDT', 'S22USDT']); assert.strictEqual(rks[1].repetidas.length, 18);
  assert.strictEqual(t.m.status().rotacao.ciclosRestantes, 6); // lista nova: contagem recomeça
  assert.strictEqual(st.universo.filter(u => u.origem === 'NOVA').length, 2);
});

// WebSocket falso (sem rede) e timers manuais para o feed.
function wsFalso() {
  const todos = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.h = {}; this.enviados = []; todos.push(this); }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); }
    emit(e, ...a) { (this.h[e] || []).forEach(f => f(...a)); }
    send(m) { this.enviados.push(JSON.parse(m)); }
    terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
    abrir() { this.readyState = 1; this.emit('open'); }
    msg(o) { this.emit('message', JSON.stringify(o)); }
  }
  return { FakeWS, todos };
}
function montarFeed(simbolos, over = {}) {
  const mf = require('../lib/mainnetFeed');
  const { FakeWS, todos } = wsFalso();
  let relogio = over.agora || AGORA;
  const timers = [];
  const f = mf.criarFeed(simbolos, {
    WebSocket: FakeWS, agora: () => relogio, rest: over.rest || {},
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: (t) => { t.cancelado = true; }
  });
  return { f, mf, todos, timers, agora: () => relogio, avancar: (ms) => { relogio += ms; } };
}

test('W1 assinatura dinâmica: /market e /public; SUBSCRIBE/UNSUBSCRIBE no socket aberto; > 150 streams = outro socket', () => {
  const x = montarFeed(['AAAUSDT', 'BBBUSDT']);
  x.f.iniciar();
  try {
    assert.strictEqual(x.todos.length, 2);
    assert.strictEqual(x.todos[0].url, 'wss://fstream.binance.com/market/stream?streams=aaausdt@aggTrade/bbbusdt@aggTrade');
    assert.strictEqual(x.todos[1].url, 'wss://fstream.binance.com/public/stream?streams=aaausdt@depth10@100ms/bbbusdt@depth10@100ms');
    x.todos.forEach(w => w.abrir());
    x.f.assinar(['CCCUSDT', 'AAAUSDT']);
    assert.deepStrictEqual(x.todos[0].enviados.pop().params, ['cccusdt@aggTrade']);
    assert.deepStrictEqual(x.todos[1].enviados.pop().params, ['cccusdt@depth10@100ms']);
    x.f.desassinar(['BBBUSDT']);
    const un = x.todos[0].enviados.pop();
    assert.strictEqual(un.method, 'UNSUBSCRIBE'); assert.deepStrictEqual(un.params, ['bbbusdt@aggTrade']);
    assert.deepStrictEqual(x.f.simbolos().sort(), ['AAAUSDT', 'CCCUSDT']);
    assert.strictEqual(x.f.snapshot('BBBUSDT'), null);
    const muitas = Array.from({ length: 160 }, (_, i) => `M${i}USDT`);
    const y = montarFeed(muitas);
    y.f.iniciar();
    const mk = y.todos.filter(w => w.url.includes('/market/'));
    assert.strictEqual(mk.length, 2); // 150 + 10
    assert.strictEqual(mk[0].url.split('streams=')[1].split('/').length, 150);
    assert.strictEqual(y.mf.MAX_STREAMS_CONEXAO, 150);
    y.f.parar();
  } finally { x.f.parar(); }
});

test('W2 heartbeat: mudo > 5 s reconecta sozinho; backoff exponencial com teto 30 s; loga há quanto tempo está mudo', async () => {
  const x = montarFeed(['AAAUSDT']);
  x.f.iniciar();
  try {
    x.todos.forEach(w => { w.abrir(); w.msg({ data: { s: 'AAAUSDT', E: x.agora(), T: x.agora(), a: 1, p: '1', q: '1', m: false, b: [], } }); });
    x.avancar(5000); x.f._vigiar();
    assert.strictEqual(x.timers.length, 0); // 5 s exatos: ainda vivo
    x.avancar(1);
    const avisos = await capturar('warn', () => x.f._vigiar());
    assert(avisos.some(l => l.includes('market#1 mudo há 5.0s')), avisos.join('|'));
    assert.deepStrictEqual(x.timers.map(t => t.ms), [1000, 1000]);
    const esperas = [];
    for (let i = 0; i < 6; i++) { // reconecta e segue mudo: 2, 4, 8, 16, 30, 30 s
      x.timers.filter(t => !t.feito).forEach(t => { t.feito = true; t.fn(); });
      x.avancar(5001);
      await capturar('warn', () => x.f._vigiar());
      esperas.push(x.timers.filter(t => !t.feito).map(t => t.ms)[0]);
    }
    assert.deepStrictEqual(esperas, [2000, 4000, 8000, 16000, 30000, 30000]);
    // 1ª mensagem após reconectar zera o backoff
    x.timers.filter(t => !t.feito).forEach(t => { t.feito = true; t.fn(); });
    const ws = x.todos[x.todos.length - 2];
    ws.abrir(); ws.msg({ data: { s: 'AAAUSDT', E: x.agora(), T: x.agora(), a: 2, p: '1', q: '1', m: false } });
    x.avancar(5001); await capturar('warn', () => x.f._vigiar());
    assert(x.timers.filter(t => !t.feito).some(t => t.ms === 1000));
  } finally { x.f.parar(); }
});

test('W3 WS caído: fallback REST (aggTrades 60 s + depth 10) preenche taker/cvd/book; snapshot nunca devolve fluxo nulo', async () => {
  const chamadas = [];
  const rest = {
    aggTrades: async (sym, p) => { chamadas.push(['agg', sym, p]); return [{ a: 10, T: AGORA - 30000, p: '100', q: '3', m: false }, { a: 11, T: AGORA - 1000, p: '100.1', q: '1', m: true }]; },
    depth: async (sym, lim) => { chamadas.push(['depth', sym, lim]); return { bids: [['100', '6']], asks: [['100.01', '4']] }; }
  };
  const x = montarFeed(['AAAUSDT'], { rest });
  x.f.iniciar();
  try {
    x.todos.forEach(w => w.terminate()); // WS caiu (nunca abriu)
    assert.strictEqual(x.f.snapshot('AAAUSDT').bufferCompleto, false);
    const snap = await x.f.garantir('AAAUSDT');
    assert.deepStrictEqual(chamadas.map(c => c[0]).sort(), ['agg', 'depth']);
    assert.strictEqual(snap.bufferCompleto, true); assert.strictEqual(snap.trades.length, 2);
    assert.strictEqual(snap.tsTrade, AGORA); assert.strictEqual(snap.tsBook, AGORA);
    const { dados } = s.montarDados('AAAUSDT', { k1m: [], k5m: [], k15m: [], snap, agora: AGORA });
    quase(dados.taker_buy_ratio_60s, 0.75); quase(dados.cvd_delta_60s, 2); quase(dados.book_imbalance_10, 0.2);
    // dentro de 2 s não repete o REST; dado > 3 s com WS caído: busca de novo
    x.avancar(1000); await x.f.garantir('AAAUSDT');
    assert.strictEqual(chamadas.length, 2);
    x.avancar(3000); await x.f.garantir('AAAUSDT');
    assert.strictEqual(chamadas.length, 4);
    // REST com erro: tolera e não inventa dado
    const y = montarFeed(['BBBUSDT'], { rest: { aggTrades: async () => { throw new Error('429'); }, depth: async () => { throw new Error('429'); } } });
    y.f.iniciar();
    const w = await capturar('warn', async () => { const sn = await y.f.garantir('BBBUSDT'); assert.strictEqual(sn.bufferCompleto, false); });
    assert(w.some(l => l.includes('BBBUSDT: aggTrades REST falhou')));
    y.f.parar();
    // teto de peso REST: sem saldo, não chama a API (rate limit) e avisa
    const n0 = chamadas.length;
    const z = montarFeed(Array.from({ length: 60 }, (_, i) => `P${i}USDT`), { rest });
    z.f.iniciar();
    const wz = await capturar('warn', async () => { for (const sym of z.f.simbolos()) await z.f.aquecer(sym); });
    const aggs = chamadas.slice(n0).filter(c => c[0] === 'agg').length;
    assert(aggs * 20 <= z.mf.PESO_MAX_MIN && aggs < 60, String(aggs));
    assert(wz.some(l => l.includes('teto de peso REST')));
    z.f.parar();
  } finally { x.f.parar(); }
});

test('W4 warmup no boot/moeda nova: REST preenche o buffer na hora (sem esperar 60 s de WS) e o WS continua sem duplicar', async () => {
  const rest = {
    aggTrades: async () => [{ a: 5, T: AGORA - 50000, p: '10', q: '2', m: false }, { a: 6, T: AGORA - 200, p: '10', q: '1', m: true }],
    depth: async () => ({ bids: [['9.99', '1']], asks: [['10', '1']] })
  };
  const x = montarFeed([], { rest });
  x.f.iniciar();
  try {
    x.f.assinar(['NOVAUSDT']);
    const [mk, pb] = x.todos;
    mk.abrir(); pb.abrir();
    mk.msg({ data: { s: 'NOVAUSDT', E: AGORA - 100, T: AGORA - 100, a: 6, p: '10', q: '1', m: true } }); // mesmo trade do REST
    assert.strictEqual(x.f.snapshot('NOVAUSDT').bufferCompleto, false); // WS sozinho: < 60 s
    assert.strictEqual(await x.f.aquecer('NOVAUSDT'), true);
    const sn = x.f.snapshot('NOVAUSDT');
    assert.strictEqual(sn.bufferCompleto, true);
    assert.deepStrictEqual(sn.trades.map(t => t.a), [5, 6]); // sem duplicata
    mk.msg({ data: { s: 'NOVAUSDT', E: AGORA + 10, T: AGORA + 10, a: 6, p: '10', q: '1', m: true } }); // repetido: ignorado
    mk.msg({ data: { s: 'NOVAUSDT', E: AGORA + 20, T: AGORA + 20, a: 7, p: '10.1', q: '4', m: false } });
    assert.deepStrictEqual(x.f.snapshot('NOVAUSDT').trades.map(t => t.a), [5, 6, 7]);
    assert.strictEqual(x.f.snapshot('NOVAUSDT').bufferCompleto, true);
    // WS de trades cai: buffer zera (sem buraco escondido) até o próximo REST
    mk.terminate();
    assert.strictEqual(x.f.snapshot('NOVAUSDT').bufferCompleto, false);
  } finally { x.f.parar(); }
});

test.skip('D1 1 moeda inválida e as outras válidas: pula só ela; motivo com campo, moeda e WS mudo; log no máx 1/moeda/30 s', async () => {
  const t = turnoMulti({ ETHUSDT: [9, 1], SOLUSDT: [8, 2], BNBUSDT: [7, 3] }); // XRP sem feed
  t.m._estado.enabled = true;
  const avisos = await capturar('warn', () => t.m.tick());
  const dec = decisoes(t);
  assert.strictEqual(dec.XRPUSDT.acao, 'BLOQUEADA'); assert.strictEqual(dec.XRPUSDT.bloqueio_duro, 'CAMPO_INVALIDO');
  assert(dec.XRPUSDT.campos_invalidos.includes('taker_buy_ratio_60s') && dec.XRPUSDT.campos_invalidos.includes('book_imbalance_10'));
  assert(/^CAMPO_INVALIDO: .*taker_buy_ratio_60s.* \| WS mudo /.test(dec.XRPUSDT.bloqueio_detalhe));
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU');
  assert.strictEqual(avisos.filter(l => l.startsWith('[SCALP-DADOS] XRPUSDT')).length, 1);
  t.avancar(10000); const a2 = await capturar('warn', () => t.m._analisar());
  assert.strictEqual(a2.filter(l => l.startsWith('[SCALP-DADOS] XRPUSDT')).length, 0); // < 30 s: sem flood
  t.avancar(20000); const a3 = await capturar('warn', () => t.m._analisar());
  assert.strictEqual(a3.filter(l => l.startsWith('[SCALP-DADOS] XRPUSDT')).length, 1);
  assert(t.m.status().ranking.find(r => r.simbolo === 'XRPUSDT').bloqueio_detalhe.includes('taker_buy_ratio_60s'));
});

// Moedas "fortes" (>= 3/5) e "fracas" (2/5, dado válido) com klines e fluxo por símbolo.
function turnoCondicoes(perfis, over = {}) {
  const t0 = AGORA - (AGORA % 300000) + 2000;
  let cur = t0;
  const ks1 = (vUlt) => { const a = []; for (let i = 0; i < 40; i++) a.push(k(t0 - (40 - i) * 60000 - 2000, 100, 101, 99, 100, i === 39 ? vUlt : 10)); return a; };
  const ks5 = (sobe) => { const a = []; for (let i = 0; i < 30; i++) a.push(k(t0 - (30 - i) * 300000 - 2000, 100, 100, 100, sobe ? 90 + i : 120 - i, 1)); return a; };
  const feed = { iniciar: () => {}, parar: () => {}, ativo: () => true, snapshot: (sym) => {
    const p = perfis[sym]; if (!p) return null;
    const trades = p === 'forte'
      ? [{ T: cur - 300, p: 110, q: 11, m: false }, { T: cur - 100, p: 110, q: 9, m: true }] // taker 0,55, cvd > 0
      : [{ T: cur - 100, p: 110, q: 3, m: false }];
    const book = p === 'forte' ? { bids: [['109.99', '6']], asks: [['110', '4']] } : { bids: [['109.99', String(5.9 - (p.n || 0) * 0.1)]], asks: [['110', String(4.1 + (p.n || 0) * 0.1)]] };
    return { trades, book, tsTrade: cur - 100, tsBook: cur - 50, bufferCompleto: true };
  } };
  const rest = { klines: async (sym, tf) => (perfis[sym] === 'forte' ? (tf === '1m' ? ks1(20) : ks5(true)) : (tf === '1m' ? ks1(10) : ks5(false))) };
  const postGemini = async (url, body) => ({ data: { choices: [{ message: { content: JSON.stringify({ entrar: true, direcao: 'LONG' }) } }] } });
  const t = montarMotor({ agora: t0, feed, rest, postGemini, universoInicial: Object.keys(perfis), ...over });
  const avancar = t.avancar; t.avancar = (ms) => { avancar(ms); cur += ms; };
  return t;
}

test.skip('D2 só 1 moeda >= 3/5: entra nela (mesmo com score menor) e completa com a de melhor score; sempre 2 entradas', async () => {
  const t = turnoCondicoes({ F1USDT: { n: 0 }, F2USDT: { n: 1 }, FORTEUSDT: 'forte', F3USDT: { n: 2 } });
  t.m._estado.enabled = true;
  await capturar('warn', () => t.m.tick());
  const dec = decisoes(t);
  assert(dec.FORTEUSDT.condicoes_ok >= 3); assert(dec.F1USDT.condicoes_ok < 3 && dec.F1USDT.bloqueio_duro === null);
  assert(dec.F1USDT.score.total > dec.FORTEUSDT.score.total); // a forte tem score menor
  assert.strictEqual(dec.FORTEUSDT.acao, 'ENTROU'); assert.strictEqual(dec.F1USDT.acao, 'ENTROU');
  assert.strictEqual(dec.F2USDT.acao, 'NAO_ESCOLHIDA'); assert.strictEqual(dec.F3USDT.acao, 'NAO_ESCOLHIDA');
  assert.strictEqual(t.m._estado.slots[3].symbol, 'FORTEUSDT'); assert.strictEqual(t.m._estado.slots[4].symbol, 'F1USDT');
  const tr = t.localAlvos.F1USDT;
  assert(tr && tr.modo === 'scalp_1m');
  // nenhuma >= 3/5: entra mesmo assim nas 2 de melhor score (dado válido)
  const u = turnoCondicoes({ F1USDT: { n: 0 }, F2USDT: { n: 1 }, F3USDT: { n: 2 } });
  u.m._estado.enabled = true;
  await capturar('warn', () => u.m.tick());
  assert.strictEqual(u.m._estado.slots[3].symbol, 'F1USDT'); assert.strictEqual(u.m._estado.slots[4].symbol, 'F2USDT');
});

test.skip('D3 turno VAZIO só se nenhuma moeda tiver dado válido (alerta); moeda do turno anterior com lucro não é pulada', async () => {
  const t = turnoMulti({}); // nenhuma com feed
  t.m._estado.enabled = true;
  const avisos = await capturar('warn', () => t.m.tick());
  const tu = lerJsonl(t).find(l => l.tipo === 'TURNO');
  assert.strictEqual(tu.status, 'VAZIO'); assert.strictEqual(tu.motivo, 'SEM_CANDIDATA_VALIDA');
  assert(avisos.some(l => l.startsWith('[SCALP-ALERTA] nenhuma das 4 moedas com dados válidos')));
  assert.strictEqual(lerJsonl(t).filter(l => l.tipo === 'DECISAO').every(l => l.acao === 'BLOQUEADA'), true);
});

test.skip('B1 duração 2 min: SCALP_DURACAO_MS 120000, limite aos 1:40, fases 2:00/4:30; sem geladeira nem env SCALP_GELADEIRA_MS', () => {
  assert.strictEqual(s.SCALP_DURACAO_MS, 120000); assert.strictEqual(s.HOLD_MS, s.SCALP_DURACAO_MS);
  assert.strictEqual(s.SAIDA_LIMITE_MS, 100000); assert.strictEqual(s.FASE_ANALISE_INI_MS, 120000); assert.strictEqual(s.FASE_CONFIRMACAO_INI_MS, 270000);
  const t = montarMotor();
  const cfg = t.m.status().config;
  assert.strictEqual(cfg.holdMs, 120000); assert.strictEqual(cfg.duracaoMs, 120000); assert.strictEqual(cfg.saidaLimiteMs, 100000);
  assert.strictEqual(cfg.faseAnaliseIniMs, 120000); assert.strictEqual(cfg.rotacaoCiclos, 6);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scalp1m.js'), 'utf8');
  assert(!/SCALP_GELADEIRA_MS|lerGeladeiraMs/.test(src));
});

test.skip('F1 numeração de turno continua após restart (último numero do JSONL); nunca volta a #1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scalp1m-'));
  const ontem = AGORA - 86400000;
  fs.writeFileSync(path.join(dir, 'log.jsonl'), [
    { tipo: 'TURNO', ts: ontem, numero: 287, status: 'VAZIO', motivo: 'X' },
    { tipo: 'TURNO', ts: ontem + 1000, numero: 288, status: 'FECHADO', soma_liquida_testnet: 0.1 },
    { tipo: 'DECISAO', ts: ontem + 2000, numero: 999 } // só linha TURNO conta
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const t = turnoMulti(BOOKS4, { dir });
  t.m._estado.enabled = true;
  await t.m.tick();
  assert.strictEqual(t.m.status().turnoAtual.numero, 289);
  // restart: turno vazio grava 289; novo restart no mesmo log continua em 290
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'scalp1m-'));
  fs.writeFileSync(path.join(dir2, 'log.jsonl'), JSON.stringify({ tipo: 'TURNO', ts: ontem, numero: 288, status: 'VAZIO' }) + '\n');
  const u = turnoMulti({}, { dir: dir2 });
  u.m._estado.enabled = true;
  await capturar('warn', () => u.m.tick());
  const v = turnoMulti({}, { dir: dir2, agora: AGORA - (AGORA % 300000) + 302000 });
  assert.strictEqual(v.m._estado.ultimoNumero, 289); // derivado do JSONL no boot
  v.m._estado.enabled = true;
  await capturar('warn', () => v.m.tick());
  assert.deepStrictEqual(lerJsonl(v).filter(l => l.tipo === 'TURNO').map(l => l.numero), [288, 289, 290]);
});

// ── RODADA 7: boot, auth, peso REST, ranking, stop proporcional, reprecificação, recheca de direção, % maker ──
test('N1 /api/auto-status exige Basic auth (sem exceção no middleware)', () => {
  const src = SRC_PAINEL();
  assert(!src.includes("req.path === '/api/auto-status'"));
  const ini = src.indexOf('// Autenticação HTTP Basic\napp.use(');
  const corpo = src.slice(src.indexOf('(req, res, next) =>', ini), src.indexOf('\n});\n', ini) + 2);
  const mw = new Function('SENHA', 'return ' + corpo)('segredo-teste');
  const rodar = (headers) => {
    let status = null, prox = false;
    const res = { setHeader: () => {}, status: (c) => { status = c; return { send: () => {} }; } };
    mw({ path: '/api/auto-status', headers }, res, () => { prox = true; });
    return { status, prox };
  };
  assert.deepStrictEqual(rodar({}), { status: 401, prox: false });
  assert.deepStrictEqual(rodar({ authorization: 'Basic ' + Buffer.from('x:errada').toString('base64') }), { status: 401, prox: false });
  assert.deepStrictEqual(rodar({ authorization: 'Basic ' + Buffer.from('x:segredo-teste').toString('base64') }), { status: null, prox: true });
});

test('N2 controle de peso: fila espaça as chamadas; recua >= 70% (header ou estimativa local); log sem flood', async () => {
  let rel = 1_800_000_010_000; // 10 s dentro do minuto
  const log = [];
  let header = null;
  const cp = s.criarControlePeso({ agora: () => rel, dormir: async (ms) => { rel += ms; }, intervaloMs: 50, limite: 1000, lerHeader: () => header, log: (m) => log.push(m) });
  const ts = [];
  await Promise.all([1, 1, 1].map(w => cp.executar(w, async () => ts.push(rel))));
  assert.deepStrictEqual(ts.map(x => x - ts[0]), [0, 50, 100]); // espaçamento da fila
  // header X-MBX-USED-WEIGHT-1M em 700/1000 (70%): pausa até virar o minuto
  header = { peso: 700, ts: rel };
  const antes = rel;
  await cp.executar(1, async () => ts.push(rel));
  assert(rel >= Math.floor(antes / 60000) * 60000 + 60000, 'pausou até o minuto seguinte');
  assert.strictEqual(log.length, 1); assert(log[0].includes('[SCALP-PESO]') && log[0].includes('700/1000'));
  // estimativa local (sem header): 690 gastos + 20 >= 700 -> pausa até o gasto mais antigo sair da janela
  header = null;
  const cp2 = s.criarControlePeso({ agora: () => rel, dormir: async (ms) => { rel += ms; }, intervaloMs: 0, limite: 1000, log: (m) => log.push(m) });
  const t0 = rel;
  await cp2.executar(690, async () => {});
  await cp2.executar(20, async () => {});
  assert(rel - t0 >= 60000);
  assert.strictEqual(cp2.status().pausas, 1);
  // sem flood: várias pausas em < 30 s = 1 log
  const log3 = [];
  let r3 = 1_800_000_000_000;
  const cp3 = s.criarControlePeso({ agora: () => r3, dormir: async (ms) => { r3 += Math.min(ms, 1000); }, intervaloMs: 0, limite: 100, lerHeader: () => ({ peso: 90, ts: r3 }), log: (m) => log3.push(m) });
  await cp3.executar(1, async () => {});
  assert(cp3.status().pausas >= 5); assert.strictEqual(log3.length, 1);
  assert.deepStrictEqual([s.pesoKlines(40), s.pesoKlines(100), s.pesoKlines(500), s.pesoKlines(1500)], [1, 2, 5, 10]);
  assert.strictEqual(s.PESO_LIMITE_1M, 2400); assert.strictEqual(s.PESO_RECUO_FRACAO, 0.70);
  // motor: klines e ranking passam pelo controle de peso
  const pesos = [];
  const spy = { executar: (w, fn) => { pesos.push(w); return fn(); }, status: () => ({}) };
  const mk = mercadoMock({ AAAUSDT: 0.3, BBBUSDT: 0.4 });
  const t = montarMotor({ rest: mk.rest, feed: feedMock(), universoInicial: null, controlePeso: spy, futSimbolos: () => ['AAAUSDT'], filtroTestnet: () => FILTRO_OK });
  await capturar('log', () => t.m._atualizarUniverso());
  assert.deepStrictEqual(pesos.slice(0, 3).sort((a, b) => a - b), [1, 5, 40]); // exchangeInfo, bookTicker, ticker24h
  assert.strictEqual(pesos.length, 3 + mk.chamadas.klines); // toda kline do ranking pela fila
  const fsrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mainnetFeed.js'), 'utf8');
  assert(fsrc.includes("r?.headers?.['x-mbx-used-weight-1m']") && fsrc.includes('pesoUsado:'));
});

test('N3 universo: volume >= 50 M, listagem < 30 dias fora, onboardDate ausente fora (fail-closed), símbolo não ASCII fora; cortes no log', async () => {
  const D = 86400000;
  const info = { symbols: [
    symInfo('OKUSDT'), symInfo('NOVAUSDT', { onboardDate: AGORA - 29 * D }), symInfo('LIM30USDT', { onboardDate: AGORA - 30 * D }),
    symInfo('SEMDATAUSDT', { onboardDate: undefined }), symInfo('LIXOUSDT', { onboardDate: 'abc' }), symInfo('牛来USDT'), symInfo('abcUSDT'),
    symInfo('V49USDT'), symInfo('V50USDT')
  ] };
  const vol = { V49USDT: 49_999_999, V50USDT: 50_000_000 };
  const tickers = info.symbols.map(x => ({ symbol: x.symbol, quoteVolume: String(vol[x.symbol] ?? 6e7) }));
  const books = info.symbols.map(x => ({ symbol: x.symbol, bidPrice: '9.9995', askPrice: '10.0005' }));
  const r = s.filtrarUniverso({ info, tickers, books, filtroTestnet: () => FILTRO_OK, agora: AGORA });
  assert.deepStrictEqual(r.lista.map(c => c.simbolo).sort(), ['LIM30USDT', 'OKUSDT', 'V50USDT']);
  assert.deepStrictEqual(r.descartes, { LISTAGEM_RECENTE: 1, IDADE_DESCONHECIDA: 2, SIMBOLO_NAO_ASCII: 2, VOLUME: 1 });
  assert.strictEqual(s.VOLUME_MIN_USDT, 50_000_000); assert.strictEqual(s.IDADE_MIN_LISTAGEM_MS, 30 * D);
  // motor: log [SCALP-RANKING] com os cortes por motivo (inclui ATR fora da faixa)
  const mk = mercadoMock({ OKAUSDT: 0.3, ALTAUSDT: 0.9, BAIXAUSDT: 0.1 });
  const ex = mk.rest.exchangeInfo;
  mk.rest.exchangeInfo = async () => { const i = await ex(); i.symbols.push(symInfo('牛来USDT')); return i; };
  const t = montarMotor({ rest: mk.rest, feed: feedMock(), universoInicial: null, futSimbolos: () => ['OKAUSDT'], filtroTestnet: () => FILTRO_OK });
  const linhas = await capturar('log', () => t.m._atualizarUniverso());
  const l = linhas.find(x => x.startsWith('[SCALP-RANKING]'));
  assert(l && l.includes('cortes:') && l.includes('SIMBOLO_NAO_ASCII=1') && l.includes('ATR_ALTO=1') && l.includes('ATR_BAIXO=1'), l);
  assert.deepStrictEqual(t.m.status().simbolos, ['OKAUSDT', 'BAIXAUSDT', 'ALTAUSDT']); // lista sempre completa: fora da faixa só como ATR_PROXIMO
});

test.skip('N4 stop proporcional: clamp(1,5 x ATR, 0,30, 0,90); ATR ausente = 0,30; stop_pct/stop_preco no alvo e no TRADE', async () => {
  assert.strictEqual(s.stopPctDeAtr(0.1), 0.30); quase(s.stopPctDeAtr(0.4), 0.60); assert.strictEqual(s.stopPctDeAtr(1), 0.90);
  quase(s.stopPctDeAtr(0.2), 0.30); quase(s.stopPctDeAtr(0.6), 0.90);
  assert.strictEqual(s.stopPctDeAtr(null), 0.30); assert.strictEqual(s.stopPctDeAtr(NaN), 0.30); assert.strictEqual(s.stopPctDeAtr(-1), 0.30);
  let posAtual = null;
  const t = cicloAprovado({ posicao: async () => posAtual });
  t.m._estado.enabled = true;
  await t.m.tick();
  const a = t.localAlvos.ETHUSDT;
  assert.strictEqual(a.stop_pct, 0.90); quase(a.stop_preco, 100 * 0.991); quase(a.slPrice, a.stop_preco); // ATR do teste = 2%
  assert(t.chamadas.includes('sl LONG 99.1000'));
  posAtual = { lado: 'LONG', quantidade: 0.5, precoMarca: 100.2 };
  t.avancar(HOLD + 1000); await t.m.monitorarTodas();
  const tr = lerJsonl(t).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.stop_pct, 0.90); quase(tr.stop_preco, 99.1); assert.strictEqual(tr.entrada_tentativas, 1);
});

test.skip('N5 entrada GTX reprecificada no melhor bid atual a cada 3 s; fill na 2ª tentativa; tentativas no TRADE', async () => {
  let n = 0, t;
  const bids = ['100', '100.05', '100.08'];
  t = cicloAprovado({
    livroOfertas: async () => ({ bids: [[bids[Math.min(n++, 2)], '10']], asks: [['100.1', '10']] }),
    consultarOrdem: async (sym, id) => (id === 2
      ? { orderId: id, status: 'FILLED', executedQty: '0.5', avgPrice: '100.05' }
      : { orderId: id, status: t.chamadas.includes(`cancelOrd ${id}`) ? 'CANCELED' : 'NEW', executedQty: '0', avgPrice: '0' })
  });
  t.m._estado.enabled = true;
  const ini = t.agora();
  await t.m.tick();
  assert.deepStrictEqual(t.chamadas.slice(0, 4), ['alav', 'limite BUY 0.5 100 GTX', 'cancelOrd 1', 'limite BUY 0.5 100.05 GTX']);
  assert(!t.chamadas.some(c => c.startsWith('market')));
  assert.strictEqual(t.agora() - ini, 3500); // 3 s na 1ª + 1 consulta na 2ª
  const a = t.localAlvos.ETHUSDT;
  assert.strictEqual(a.entradaTipo, 'LIMITE'); assert.strictEqual(a.entradaTentativas, 2); quase(a.entryPrice, 100.05);
  const ev = lerJsonl(t).find(l => l.evento === 'SCALP_ENTRADA_LIMITE');
  assert.strictEqual(ev.resultado, 'PREENCHIDA'); assert.strictEqual(ev.tentativas, 2); assert.deepStrictEqual(ev.order_ids, [1, 2]);
  assert(SRC_LIB().includes("if (!travaOk(sym, 'ENTRADA_GTX')) throw new Error(MSG_NAO_TESTNET);\n        tentativasEntrada++;"));
});

test.skip('N6 4:57 recheca com dados atuais: dado inválido pula a moeda; direção inverteu = decide a direção atual (Jev segue o código)', async () => {
  const mk = (modo) => {
    let t;
    const inv = new Set();
    const feed = { iniciar: () => {}, parar: () => {}, ativo: () => true, snapshot: (sym) => {
      if (!BOOKS4[sym]) return null;
      const cur = t.agora();
      if (inv.has(sym) && modo === 'inverter') return { trades: [{ T: cur - 100, p: 90, q: 3, m: true }], book: { bids: [['89.99', '1']], asks: [['90', '9']] }, tsTrade: cur - 100, tsBook: cur - 50, bufferCompleto: true };
      if (inv.has(sym) && modo === 'invalido') return { trades: [{ T: cur - 100, p: 110, q: 3, m: false }], book: { bids: [['109.99', '9']], asks: [['110', '1']] }, tsTrade: cur - 100, tsBook: cur - 50, bufferCompleto: false };
      return { trades: [{ T: cur - 100, p: 110, q: 3, m: false }], book: { bids: [['109.99', String(BOOKS4[sym][0])]], asks: [['110', String(BOOKS4[sym][1])]] }, tsTrade: cur - 100, tsBook: cur - 50, bufferCompleto: true };
    } };
    t = turnoMulti(BOOKS4, { feed });
    t.inv = inv;
    return t;
  };
  for (const modo of ['invalido', 'inverter']) {
    const t = mk(modo);
    t.m._estado.enabled = true;
    t.avancar(270000); await t.m.tick(); // 4:32: plano (ETH, SOL, BNB, XRP todas LONG)
    assert.deepStrictEqual(t.m.status().proximas.map(p => p.simbolo), ['ETHUSDT', 'SOLUSDT']);
    t.inv.add('ETHUSDT');
    t.avancar(25000); await t.m.tick(); // 4:57: dados frescos + Jev
    t.avancar(4000); await t.m.tick(); // 5:01: entrada
    const dec = decisoes(t);
    if (modo === 'invalido') {
      assert.strictEqual(dec.ETHUSDT.acao, 'DADO_INVALIDO_RECHECA');
      assert.strictEqual(t.m._estado.slots[3].symbol, 'SOLUSDT'); assert.strictEqual(t.m._estado.slots[4].symbol, 'BNBUSDT');
      assert(!t.jevChamadas.includes('ETHUSDT')); // sem dados válidos o Jev nem é consultado
    } else {
      assert.strictEqual(dec.ETHUSDT.acao, 'ENTROU'); assert.strictEqual(dec.ETHUSDT.recheca.direcao, 'SHORT');
      assert.strictEqual(dec.ETHUSDT.direcao_codigo, 'SHORT'); assert.strictEqual(dec.ETHUSDT.direcao_jev, 'SHORT');
      assert.strictEqual(t.localAlvos.ETHUSDT.side, 'SHORT'); assert.strictEqual(t.localAlvos.SOLUSDT.side, 'LONG');
    }
  }
});

test.skip('N7 (8a) entrada falhou na 1ª e o Jev diverge na 3ª: segue pelo ranking (3ª entra SHORT) até 2 posições; sem laço infinito', async () => {
  const t = turnoMulti(BOOKS4, { divergir: ['BNBUSDT'], posicao: async (sym) => (sym === 'ETHUSDT' ? { lado: 'LONG', quantidade: 1 } : null) });
  t.m._estado.enabled = true;
  await capturar('warn', () => t.m.tick());
  const dec = decisoes(t);
  assert.strictEqual(dec.ETHUSDT.acao, 'ENTRADA_FALHOU'); assert.strictEqual(dec.SOLUSDT.acao, 'ENTROU');
  assert.strictEqual(dec.BNBUSDT.acao, 'ENTROU'); assert.strictEqual(dec.BNBUSDT.direcao_jev, 'SHORT'); assert.strictEqual(dec.XRPUSDT.acao, 'NAO_ESCOLHIDA');
  assert.deepStrictEqual(new Set([t.m._estado.slots[3].symbol, t.m._estado.slots[4].symbol]), new Set(['SOLUSDT', 'BNBUSDT']));
  assert.deepStrictEqual([...t.jevChamadas].sort(), ['BNBUSDT', 'ETHUSDT', 'SOLUSDT']); // Jev só nas que tentam entrar
  // todas falham: cada moeda tentada 1 vez, fim da lista encerra (turno vazio)
  let n = 0;
  const t2 = turnoMulti(BOOKS4, { posicao: async () => { n++; return { lado: 'LONG', quantidade: 1 }; } });
  t2.m._estado.enabled = true;
  await capturar('warn', () => t2.m.tick());
  assert.strictEqual(n, 4);
  assert(Object.values(decisoes(t2)).every(d => d.acao === 'ENTRADA_FALHOU'));
  assert.strictEqual(lerJsonl(t2).find(l => l.tipo === 'TURNO').status, 'VAZIO');
});

test('N8 % maker de entrada e de saída do dia no status() e no painel (escHtml)', () => {
  const t = montarMotor();
  const alvo = (tipo) => ({ ...ALVO_ETH(), entradaTipo: tipo, taxaEntradaPct: tipo === 'LIMITE' ? 0.02 : 0.05 });
  t.m._registrarTrade('ETHUSDT', alvo('LIMITE'), 'SCALP_TEMPO_LIMITE', 100.3, 100.2, 0, { tipo: 'LIMITE', taxaPct: 0.02 });
  t.m._registrarTrade('SOLUSDT', alvo('MISTA'), 'SCALP_TEMPO_60S', 100.3, 100.2, 0, { tipo: 'MARKET', taxaPct: 0.05 });
  t.m._registrarTrade('BNBUSDT', alvo('MARKET'), 'SCALP_TEMPO_60S', 100.3, 100.2, 0, { tipo: 'MARKET', taxaPct: 0.05 });
  t.m._registrarTrade('XRPUSDT', alvo('LIMITE'), 'SCALP_TEMPO_60S', 100.3, 100.2, 0, { tipo: 'MARKET', taxaPct: 0.05 });
  const st = t.m.status();
  quase(st.maker_entrada_pct, 50); quase(st.maker_saida_pct, 25);
  quase(st.hoje.pctEntradaMaker, 50); quase(st.hoje.pctSaidaMaker, 25);
  assert.strictEqual(montarMotor().m.status().maker_entrada_pct, null); // sem trades: null (painel mostra --)
  const src = SRC_PAINEL();
  assert(src.includes("kpi('Maker ent./saí.', escHtml(scalpPct(d.maker_entrada_pct))") && src.includes('escHtml(scalpPct(d.maker_saida_pct))'));
});
