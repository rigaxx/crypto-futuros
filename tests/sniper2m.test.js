// Sniper 2 min: Supertrend, score de confluência, TP/BE/SL curto/fim de turno no monitor, aborto de entrada por fuga.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../lib/scalp1m');

const T0 = 1_800_000_000_000 - (1_800_000_000_000 % s.TURNO_MS); // fronteira de 2 min
const k = (t, o, h, l, c, v = 10) => [t, String(o), String(h), String(l), String(c), String(v), t + 59999];
const serie = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return k(T0 - (n - i) * 60000, c, c + 0.2, c - 0.2, c); });

function dados(over = {}) {
  return { simbolo: 'SOLUSDT', preco: 101, vwap: 100, ema9_5m: 102, ema21_5m: 100, ema9_1m: 100.95, st1m_dir: 1, atr_1m_pct: 0.20,
    taker_buy_ratio_60s: 0.60, book_imbalance_10: 0.30, rvol: 2, ...over };
}
const curto = (o = {}) => dados({ preco: 99, ema9_5m: 98, ema21_5m: 100, ema9_1m: 99.05, st1m_dir: -1, taker_buy_ratio_60s: 0.40, book_imbalance_10: -0.30, ...o });

test('constantes Sniper: 120 s, 2 slots de 10 USDT a 5x, TP +2,40% ROI, SL curto -2,20% ROI', () => {
  assert.strictEqual(s.TURNO_MS, 120000); assert.strictEqual(s.SCALP_DURACAO_MS, 120000);
  assert.strictEqual(s.ALAV, 5); assert.strictEqual(s.MARGEM, 10); assert.deepStrictEqual(s.SLOTS, [3, 4]);
  assert.strictEqual(s.TP_PRICE_PCT * s.ALAV, 2.4); assert.ok(Math.abs(s.SL_CURTO_PCT - 0.44) < 1e-12);
  assert.strictEqual(s.BE_GATILHO_ROI, 1.30); assert.strictEqual(s.BE_PISO_ROI, 0.70);
  assert.strictEqual(s.ENTRADA_LIMITE_MS, 8000); assert.strictEqual(s.ATR_MIN_PCT, 0.05); assert.strictEqual(s.VOLUME_MIN_USDT, 20_000_000); assert.strictEqual(s.SPREAD_TESTNET_MAX_PCT, 0.6); assert.strictEqual(s.TAKER_RATIO_LONG ?? 1.05, 1.05);
  assert.strictEqual(s.SNIPER_SCORE_MIN, 45); assert.strictEqual(s.ENTRADA_FUGA_ABORTA_PCT, 0.15);
  const f = s.faseCiclo(T0 + 5000); assert.strictEqual(f.fase, 'ABERTO'); assert.strictEqual(f.cicloRestanteMs, 115000);
  assert.strictEqual(s.faseCiclo(T0 + 50000).fase, 'ANALISE'); assert.strictEqual(s.faseCiclo(T0 + 110000).fase, 'CONFIRMACAO');
});

test('supertrend(10,3): tendência de alta = 1, de baixa = -1, poucos candles = null', () => {
  assert.strictEqual(s.supertrend(serie(60, i => 100 + i * 0.5)).dir, 1);
  assert.strictEqual(s.supertrend(serie(60, i => 130 - i * 0.5)).dir, -1);
  assert.strictEqual(s.supertrend(serie(5, i => 100 + i)), null);
  // virada: alta forte e queda forte depois
  const virou = serie(80, i => (i < 40 ? 100 + i : 140 - (i - 40) * 3));
  assert.strictEqual(s.supertrend(virou).dir, -1);
});

test('avaliarSniper LONG: direção (ST verde + EMA 5m + VWAP) e score = 20 + 30 + 25 + 25', () => {
  const r = s.avaliarSniper(dados());
  assert.strictEqual(r.direcao, 'LONG'); assert.strictEqual(r.score, 100); assert.strictEqual(r.ok, true);
  assert.strictEqual(s.avaliarSniper(dados({ rvol: 1.5 })).score, 75);               // sem RVol: ainda aprova
  assert.strictEqual(s.avaliarSniper(dados({ book_imbalance_10: 0.05 })).score, 75); // book 1.1 < 1.15: sem o peso 2
  const fraco = s.avaliarSniper(dados({ taker_buy_ratio_60s: 0.50 }));               // ratio 1.0 < 1.05: sem fluxo a favor = não entra
  assert.strictEqual(fraco.score, 70); assert.strictEqual(fraco.ok, false); assert.strictEqual(fraco.bloqueio, 'SEM_FLUXO');
  const minimo = s.avaliarSniper(dados({ book_imbalance_10: 0.05, rvol: 1 }));        // só direção + fluxo = 50: já aprova
  assert.strictEqual(minimo.score, 50); assert.strictEqual(minimo.ok, true);
});

test('avaliarSniper SHORT: maioria baixista; limiar de fluxo 0,95', () => {
  const r = s.avaliarSniper(curto());
  assert.strictEqual(r.direcao, 'SHORT'); assert.strictEqual(r.ok, true);
  assert.strictEqual(s.avaliarSniper(curto({ taker_buy_ratio_60s: 0.49 })).comp.fluxo, false); // 0.49/0.51 = 0.96 > 0.95
  assert.strictEqual(s.avaliarSniper(curto({ taker_buy_ratio_60s: 0.48 })).comp.fluxo, true);  // 0.923
});

test('avaliarSniper: direção por maioria simples (2 de 3: Supertrend 1m, EMA 5m, VWAP); empate = SEM_DIRECAO', () => {
  assert.strictEqual(s.avaliarSniper(dados({ st1m_dir: -1 })).direcao, 'LONG');                 // EMA + VWAP a favor
  assert.strictEqual(s.avaliarSniper(dados({ ema9_5m: 99 })).direcao, 'LONG');                  // ST + VWAP a favor
  assert.strictEqual(s.avaliarSniper(dados({ st1m_dir: -1, ema9_5m: 99, taker_buy_ratio_60s: 0.40, book_imbalance_10: -0.3 })).direcao, 'SHORT'); // ST + EMA caindo
  const empate = s.avaliarSniper(dados({ st1m_dir: -1, preco: 100 }));                          // preço = VWAP: 2 x 2
  assert.strictEqual(empate.ok, false); assert.strictEqual(empate.direcao, 'NONE'); assert.strictEqual(empate.bloqueio, 'SEM_DIRECAO');
  assert.strictEqual(s.avaliarSniper(dados({ st1m_dir: null })).bloqueio, 'SEM_DADOS_SNIPER');
});

test('avaliarSniper: ATR 1m < 0,05% bloqueia; trava anti-topo (> 1,2 x ATR da EMA 9 1m) bloqueia', () => {
  assert.strictEqual(s.avaliarSniper(dados({ atr_1m_pct: 0.049 })).bloqueio, 'ATR_BAIXO');
  assert.strictEqual(s.avaliarSniper(dados({ atr_1m_pct: 0.05 })).ok, true);
  // ATR 0,20% de 101 = 0,202; 1,2 x = 0,2424 -> EMA9 em 100,75 (distância 0,25) bloqueia; 100,77 (0,23) passa
  assert.strictEqual(s.avaliarSniper(dados({ ema9_1m: 100.75 })).bloqueio, 'TOPO_ESTICADO');
  assert.strictEqual(s.avaliarSniper(dados({ ema9_1m: 100.77 })).ok, true);
  assert.strictEqual(s.avaliarSniper(curto({ ema9_1m: 99.25 })).bloqueio, 'TOPO_ESTICADO'); // fundo esticado no SHORT
});

test('avaliarCandidata: direção vem do Sniper; sem fluxo ou sem direção = bloqueio (não entra)', () => {
  const agora = 1_800_000_000_000;
  const full = (o) => ({ ...dados(o), timestamp_dados_ms: agora - 500, timestamp_agora_ms: agora, ema9_15m: 101, ema21_15m: 99, cvd_delta_60s: 5, spread_pct: 0.01 });
  const ok = s.avaliarCandidata('SOLUSDT', full({}));
  assert.strictEqual(ok.direcao, 'LONG'); assert.strictEqual(ok.bloqueio, null); assert.strictEqual(ok.sniper.score, 100);
  assert.strictEqual(s.avaliarCandidata('SOLUSDT', full({ taker_buy_ratio_60s: 0.50 })).bloqueio, 'SEM_FLUXO');
  assert.strictEqual(s.avaliarCandidata('SOLUSDT', full({ st1m_dir: -1, preco: 100 })).bloqueio, 'SEM_DIRECAO');
  // ranking pelo score Sniper
  const r = s.rankearCandidatas([ok, s.avaliarCandidata('A', full({ rvol: 1 }))]);
  assert.deepStrictEqual(r.map(x => x.score), [100, 75]);
});

// ── monitor: TP na pedra, BE rápido, SL curto, fim de turno ──
function montar(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper2m-'));
  const chamadas = []; const localAlvos = {}; const desfechos = []; const ordens = {};
  let relogio = over.agora || T0 + 3000, nOrd = 0, preco = over.preco ?? 100;
  let posQty = 0.5;
  const fut = {
    posicao: async () => (posQty > 0 ? { lado: over.lado || 'LONG', quantidade: posQty, precoMarca: preco } : null),
    livroOfertas: async () => ({ bids: [[String(preco), '10']], asks: [[String(preco + 0.01), '10']] }),
    colocarLimite: async (sym, lado, qty, p, opts = {}) => { const id = ++nOrd; ordens[id] = { sym, lado, qty, p, opts, status: 'NEW' }; chamadas.push(`limite ${lado} ${qty} ${p.toFixed(4)}${opts.reduceOnly ? ' RO' : ''} ${opts.timeInForce || 'GTC'}`); return { orderId: id, status: 'NEW', executedQty: '0' }; },
    consultarOrdem: async (sym, id) => { const o = ordens[id]; return { orderId: id, status: o.status, executedQty: o.status === 'FILLED' ? String(o.qty) : '0', avgPrice: String(o.p) }; },
    cancelarOrdem: async (sym, id) => { chamadas.push(`cancelOrd ${id}`); if (ordens[id].status === 'NEW') ordens[id].status = 'CANCELED'; },
    cancelarTodasOrdens: async () => { chamadas.push('cancelar'); return true; },
    fecharMercado: async (sym, lado, q) => { chamadas.push(`fechar ${lado}`); posQty = 0; return { avgPrice: String(preco) }; },
    tickerPreco: async () => ({ price: String(preco) }),
    filtrosDe: () => ({ minQty: 0.001 })
  };
  const feed = { iniciar() {}, parar() {}, ativo: () => false, snapshot: () => null };
  const m = s.criarMotor({
    fut, feed, rest: { klines: async () => over.klines || serie(60, i => 100 + i * 0.01) }, localAlvos, salvarAlvos() {}, closingInProgress: new Set(),
    simboloOcupadoPsar: () => false, registrarDesfechoTrade: (...a) => desfechos.push(a), rag: null,
    configFile: path.join(dir, 'cfg.json'), logFile: path.join(dir, 'log.jsonl'), agora: () => relogio, dormir: async (ms) => { relogio += ms; },
    baseOrdens: 'https://testnet.binancefuture.com', universoInicial: ['SOLUSDT'], controlePeso: null
  });
  const lado = over.lado || 'LONG';
  const alvo = localAlvos.SOLUSDT = { modo: 'scalp_1m', side: lado, entryPrice: 100, slPrice: lado === 'LONG' ? 99.4 : 100.6, slCurtoPrice: lado === 'LONG' ? 99.56 : 100.44,
    quantidade: 0.5, openTime: T0 + 2000, candle: T0, entradaTipo: 'LIMITE', taxaEntradaPct: 0.02, slNaCorretora: true, stDirEntrada: lado === 'LONG' ? 1 : -1, entrada: { precoMainnet: 100, slipMainnetPct: 0 }, maxRoiReached: 0, minRoiReached: 0 };
  m._estado.slots[3] = { symbol: 'SOLUSDT', side: lado, status: 'x', openTime: T0 + 2000 };
  return { m, chamadas, alvo, localAlvos, desfechos, ordens, dir, set: (p) => { preco = p; }, avancar: (ms) => { relogio += ms; }, agora: () => relogio, zerar: () => { posQty = 0; } };
}
const linhas = (t) => fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('TP_SNIPER_2M: 1º tick coloca limite reduceOnly GTC em +0,48% (+2,40% ROI); fill = saída maker', async () => {
  const t = montar();
  await t.m.monitorarPosicao('SOLUSDT', t.alvo);
  assert.deepStrictEqual(t.chamadas, ['limite SELL 0.5 100.4800 RO GTC']);
  assert.strictEqual(t.alvo.tp.orderId, 1);
  t.ordens[1].status = 'FILLED'; t.zerar(); t.set(100.48);
  await t.m.monitorarPosicao('SOLUSDT', t.alvo);
  assert.strictEqual(t.localAlvos.SOLUSDT, undefined);
  const tr = linhas(t).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.saida_motivo, 'SCALP_TP_SNIPER_2M'); assert.strictEqual(tr.saida_tipo, 'LIMITE');
  assert.strictEqual(tr.taxas.saida_pct, s.TAXA_MAKER_PCT);
  assert.ok(tr.pnl_testnet.liquido > 0);
});

test('TP no SHORT fica em -0,48% de preço', async () => {
  const t = montar({ lado: 'SHORT', klines: serie(60, i => 130 - i * 0.5) });
  await t.m.monitorarPosicao('SOLUSDT', t.alvo);
  assert.deepStrictEqual(t.chamadas, ['limite BUY 0.5 99.5200 RO GTC']);
});

test('BE_REAL: bateu +1,30% ROI e recuou a +0,70% = fecha na hora, positivo (nunca devolve no relógio)', async () => {
  const t = montar();
  await t.m.monitorarPosicao('SOLUSDT', t.alvo);                 // TP colocado
  t.set(100.27); await t.m.monitorarPosicao('SOLUSDT', t.alvo);  // ROI +1,35%: arma o piso, sem sair
  assert.ok(t.alvo.maxRoiReached >= 1.30); assert.ok(!t.alvo.saidaMotivo);
  t.set(100.14); t.avancar(1000); await t.m.monitorarPosicao('SOLUSDT', t.alvo); // ROI +0,70%: arma limite
  t.avancar(3500); await t.m.monitorarPosicao('SOLUSDT', t.alvo); // fecha Market
  assert.strictEqual(t.localAlvos.SOLUSDT, undefined);
  assert.ok(t.chamadas.includes('cancelOrd 1')); assert.ok(t.chamadas.includes('fechar LONG'));
  const tr = linhas(t).find(l => l.tipo === 'TRADE');
  assert.strictEqual(tr.saida_motivo, 'SCALP_BE_RAPIDO_2M'); assert.ok(tr.roi_testnet_pct > 0);
});

test('SL_CURTO_2M: -2,20% ROI (-0,44%) tenta limite reduceOnly por 3 s e vai a Market', async () => {
  const t = montar();
  await t.m.monitorarPosicao('SOLUSDT', t.alvo);                  // TP
  t.set(99.55); t.avancar(1000);
  await t.m.monitorarPosicao('SOLUSDT', t.alvo);                  // gatilho: cancela TP e coloca limite de saída
  assert.strictEqual(t.alvo.saidaMotivo, 'SCALP_SL_CURTO_2M');
  assert.ok(t.chamadas.some(c => c.startsWith('limite SELL') && c.endsWith('RO GTX')));
  t.avancar(1000); await t.m.monitorarPosicao('SOLUSDT', t.alvo); // ainda dentro dos 3 s: aguarda
  assert.ok(!t.chamadas.includes('fechar LONG'));
  t.avancar(2500); await t.m.monitorarPosicao('SOLUSDT', t.alvo); // passou 3 s: Market
  assert.ok(t.chamadas.includes('fechar LONG'));
  assert.strictEqual(linhas(t).find(l => l.tipo === 'TRADE').saida_motivo, 'SCALP_SL_CURTO_2M');
  assert.ok(linhas(t).find(l => l.tipo === 'TRADE').pnl_testnet.liquido > -0.30); // perda limitada (~$0,22 + taxas)
});

test('SL_CURTO_2M: virada do Supertrend 1m contra a posição fecha mesmo sem o preço no stop', async () => {
  const t = montar({ klines: serie(80, i => (i < 40 ? 100 + i : 140 - (i - 40) * 3)) }); // ST do 1m em BAIXA com posição LONG
  await t.m.monitorarPosicao('SOLUSDT', t.alvo);
  assert.strictEqual(t.alvo.saidaMotivo, 'SCALP_SL_CURTO_2M');
  t.avancar(3500); await t.m.monitorarPosicao('SOLUSDT', t.alvo);
  assert.ok(t.chamadas.includes('fechar LONG'));
});

test('FIM_TURNO_2M: nos últimos 5 s após 8 min sem andar, fecha a Market', async () => {
  const t = montar({ agora: T0 + 8 * 60 * 1000 - s.FIM_ANTECIPA_MS - s.FIM_LIMITE_MS - 1000 });
  t.alvo.openTime = T0 - 10000; t.alvo.candle = T0 + 8 * 60 * 1000 - s.TURNO_MS;
  await t.m.monitorarPosicao('SOLUSDT', t.alvo);                 // ainda fora da janela: só coloca o TP
  assert.ok(!t.alvo.saidaMotivo);
  t.avancar(1500); await t.m.monitorarPosicao('SOLUSDT', t.alvo);
  assert.strictEqual(t.alvo.saidaMotivo, 'SCALP_FIM_TURNO_2M');
  assert.ok(t.chamadas.some(c => c.startsWith('limite SELL') && c.endsWith('RO GTX')));
  t.avancar(4600); await t.m.monitorarPosicao('SOLUSDT', t.alvo);
  assert.ok(t.chamadas.includes('fechar LONG'));
  assert.strictEqual(linhas(t).find(l => l.tipo === 'TRADE').saida_motivo, 'SCALP_FIM_TURNO_2M');
});

test('RENOVAÇÃO ZONA NEUTRA: aos 120s com ROI neutro e ST a favor renova ciclo; não fecha prematuro', async () => {
  const t = montar({ agora: T0 + s.TURNO_MS - s.FIM_ANTECIPA_MS - s.FIM_LIMITE_MS + 500 });
  t.alvo.openTime = T0;
  await t.m.monitorarPosicao('SOLUSDT', t.alvo);
  assert.ok(!t.alvo.saidaMotivo);
  assert.strictEqual(t.alvo.ciclosRenovados, 1);
});

test('zerarContadores: placar do dia, taxas e histórico recomeçam do zero', () => {
  const t = montar();
  t.m._estado.hoje.ops = 5; t.m._estado.hoje.taxasPagas = 3; t.m._estado.historico.push({ x: 1 });
  t.m.zerarContadores();
  assert.strictEqual(t.m._estado.hoje.ops, 0); assert.strictEqual(t.m._estado.hoje.taxasPagas, 0); assert.deepStrictEqual(t.m._estado.historico, []);
});

// ── entrada maker-first: 8 s, sem perseguir preço ──
function turnoSniper(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper2m-ent-'));
  const t0 = T0 + 2000; let relogio = t0, nOrd = 0, ask = 100.05;
  const chamadas = [], localAlvos = {}, ordens = {};
  const ks1 = Array.from({ length: 60 }, (_, i) => { const c = 100 + i * 0.01; return k(t0 - (60 - i) * 60000 - 2000, c, c + 0.2, c - 0.2, c, i === 59 ? 50 : 10); });
  const ks5 = Array.from({ length: 30 }, (_, i) => k(t0 - (30 - i) * 300000 - 2000, 100, 100, 100, 90 + i, 1));
  const snap = { trades: over.trades || [{ T: t0 - 100, p: 100.5, q: 3, m: false }], book: { bids: [['100.49', '9']], asks: [['100.5', '1']] }, tsTrade: t0 - 100, tsBook: t0 - 50, bufferCompleto: true };
  const fut = {
    posicao: async () => null, garantirAlavancagem: async () => {}, calcularQuantidade: () => ({ ok: true, qty: 0.5 }), filtrosDe: () => ({ minQty: 0.001 }),
    livroOfertas: async () => ({ bids: [['100', '10']], asks: [[String(ask), '10']] }),
    colocarLimite: async (sym, lado, qty, p, opts = {}) => { const id = ++nOrd; ordens[id] = 'NEW'; chamadas.push(`limite ${lado} ${qty} ${p} ${opts.timeInForce || 'GTC'}${opts.reduceOnly ? ' RO' : ''}`); if (over.aoColocar) over.aoColocar(id, (v) => { ask = v; }); return { orderId: id, status: 'NEW', executedQty: '0' }; },
    consultarOrdem: async (sym, id) => ({ orderId: id, status: ordens[id], executedQty: '0', avgPrice: '0' }),
    cancelarOrdem: async (sym, id) => { chamadas.push(`cancelOrd ${id}`); ordens[id] = 'CANCELED'; },
    colocarStopLoss: async (sym, lado, p) => chamadas.push(`sl ${lado} ${p.toFixed(4)}`),
    abrirMercado: async (sym, lado, q) => { chamadas.push(`market ${lado} ${q}`); return { avgPrice: '100.1', executedQty: String(q) }; },
    cancelarTodasOrdens: async () => true, fecharMercado: async () => ({ avgPrice: '100' }), tickerPreco: async () => ({ price: '100.5' })
  };
  const feed = { iniciar() {}, parar() {}, ativo: () => true, snapshot: (sym) => (sym === 'SOLUSDT' ? snap : null) };
  const m = s.criarMotor({
    fut, feed, rest: { klines: async (sym, tf) => (tf === '1m' ? ks1 : ks5) }, localAlvos, salvarAlvos() {}, closingInProgress: new Set(),
    simboloOcupadoPsar: () => false, registrarDesfechoTrade() {}, rag: null,
    configFile: path.join(dir, 'cfg.json'), logFile: path.join(dir, 'log.jsonl'), agora: () => relogio, dormir: async (ms) => { relogio += ms; },
    baseOrdens: 'https://testnet.binancefuture.com', universoInicial: ['SOLUSDT'], controlePeso: null, whitelist: null
  });
  m._estado.enabled = true;
  return { m, chamadas, localAlvos, dir, setAsk: (v) => { ask = v; }, agora: () => relogio, t0 };
}

test('entrada: candidata Sniper aprovada entra com GTX no melhor bid; sem fill em 8 s e preço no nível = Market', async () => {
  const t = turnoSniper();
  await t.m.tick();
  assert.strictEqual(t.chamadas.filter(c => c.startsWith('limite BUY')).length, 3); // 3 tentativas de 3 s dentro de 8 s
  assert.strictEqual(t.agora() - t.t0 >= 8000 && t.agora() - t.t0 < 9500, true);
  assert.ok(t.chamadas.includes('market BUY 0.5'));
  const a = t.localAlvos.SOLUSDT;
  assert.ok(a && a.stop_pct === 0.6 && Math.abs(a.slCurtoPrice - a.entryPrice * (1 - 0.0044)) < 1e-9);
  assert.ok(linhasDe(t).some(l => l.evento === 'SCALP_ENTRADA_MARKET' && l.motivo === 'SEM_FILL_8S'));
});

test('entrada: sem fill em 8 s e preço fugiu (> 0,03%) = ABORTA, nenhuma ordem a Market, slot livre', async () => {
  const t = turnoSniper({ aoColocar: (n, setAsk) => { if (n === 1) setAsk(100.4); } }); // +0,30% logo após a 1ª limite
  const origWarn = console.warn; console.warn = () => {};
  try { await t.m.tick(); } finally { console.warn = origWarn; }
  assert.ok(!t.chamadas.some(c => c.startsWith('market')));
  assert.strictEqual(t.localAlvos.SOLUSDT, undefined);
  assert.strictEqual(t.m._estado.slots[3].symbol, null);
  const ab = linhasDe(t).find(l => l.evento === 'SCALP_ENTRADA_ABORTADA');
  assert.ok(ab && ab.fuga_pct > s.ENTRADA_FUGA_ABORTA_PCT && ab.motivo === 'SEM_FILL_8S');
});

test('sem fluxo a favor: turno VAZIO, nenhuma ordem, sem queimar taxa', async () => {
  const t0 = T0 + 2000;
  const t = turnoSniper({ trades: [{ T: t0 - 200, p: 100.5, q: 3, m: false }, { T: t0 - 100, p: 100.5, q: 3, m: true }] }); // fluxo 1,0
  await t.m.tick();
  assert.deepStrictEqual(t.chamadas, []);
  const l = linhasDe(t);
  assert.ok(l.some(x => x.tipo === 'TURNO' && x.status === 'VAZIO'));
  assert.ok(l.filter(x => x.tipo === 'DECISAO').every(x => x.acao === 'BLOQUEADA' && x.bloqueio_duro === 'SEM_FLUXO'));
});

function linhasDe(t) { return fs.readFileSync(path.join(t.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); }

// ── whitelist, spread testnet, órfãs ──
test('whitelist: filtrarUniverso só aceita as 20 moedas líquidas; WHITELIST tem 20 pares sem as sem-liquidez', () => {
  assert.strictEqual(s.WHITELIST.length, 20);
  for (const ruim of ['IDOLUSDT', 'JCTUSDT', 'AINUSDT', 'ESPORTSUSDT', 'AKEUSDT', 'ICNTUSDT', 'XPLUSDT', 'BMTUSDT']) assert.ok(!s.WHITELIST.includes(ruim), ruim);
  const sym = (symbol) => ({ symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', onboardDate: 1 });
  const r = s.filtrarUniverso({ info: { symbols: [sym('SOLUSDT'), sym('IDOLUSDT')] }, tickers: [{ symbol: 'SOLUSDT', quoteVolume: '9e9' }, { symbol: 'IDOLUSDT', quoteVolume: '9e9' }],
    books: [{ symbol: 'SOLUSDT', bidPrice: '100', askPrice: '100.01' }, { symbol: 'IDOLUSDT', bidPrice: '1', askPrice: '1.0001' }],
    filtroTestnet: () => ({ minQty: 0.001, stepSize: 0.001, minNotional: 5 }), agora: 1e12, whitelist: s.WHITELIST });
  assert.deepStrictEqual(r.lista.map(x => x.simbolo), ['SOLUSDT']);
});

test('spread testnet > 0,60%: entrada proibida antes de qualquer ordem', async () => {
  const t = turnoSniper();
  t.setAsk(100.7); // 0,7% de spread no book da testnet (> 0,60%)
  const w = console.warn; console.warn = () => {};
  try { await t.m.tick(); } finally { console.warn = w; }
  assert.ok(!t.chamadas.some(c => c.startsWith('limite') || c.startsWith('market')));
  assert.strictEqual(t.localAlvos.SOLUSDT, undefined);
});

test('órfã sem posição na corretora: alvo e slot limpos; com posição: Market reduceOnly e slot livre', async () => {
  for (const comPosicao of [false, true]) {
    const t = montar();
    t.alvo.orfa = true; t.alvo.abandonada = true; t.alvo.tentativasSaida = 20;
    t.avancar(200000); // muito além do fim do turno
    if (!comPosicao) t.zerar();
    const w = console.warn; console.warn = () => {};
    try { await t.m.monitorarTodas(); } finally { console.warn = w; }
    assert.strictEqual(t.localAlvos.SOLUSDT, undefined, `comPosicao=${comPosicao}`);
    assert.strictEqual(t.m._estado.slots[3].symbol, null);
    assert.strictEqual(t.chamadas.includes('fechar LONG'), comPosicao);
  }
});

test('frescor: com WS vivo, moeda quieta não é DADOS_ATRASADOS (silêncio do socket, não da moeda)', () => {
  const agora = 1_800_000_000_000;
  const d = s.montarDados('SOLUSDT', { k1m: [], k5m: [], k15m: [], agora, snap: { trades: [], book: { bids: [['100', '1']], asks: [['100.01', '1']] }, tsTrade: agora - 40000, tsBook: agora - 30000, bufferCompleto: true, wsVivo: true, wsMudoMs: 80 } }).dados;
  assert.ok(agora - d.timestamp_dados_ms < 1000);
  const velho = s.montarDados('SOLUSDT', { k1m: [], k5m: [], k15m: [], agora, snap: { trades: [], book: { bids: [['100', '1']], asks: [['100.01', '1']] }, tsTrade: agora - 40000, tsBook: agora - 30000, bufferCompleto: true, wsVivo: false, wsMudoMs: 80 } }).dados;
  assert.ok(agora - velho.timestamp_dados_ms >= 40000);
});
