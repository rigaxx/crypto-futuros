#!/usr/bin/env node
// Expectativa líquida do scalp_1m a partir de logs/scalp_1m_decisoes.jsonl.
// Uso: node scripts/scalp_expectativa.js [arquivo.jsonl]
const fs = require('fs');
const path = require('path');
const { criarResumoDia, acumularResumo, formatarResumo } = require('../lib/scalp1m');

function resumir(linhas) {
  const dec = { total: 0, aprovadasGate: 0, bloqueios: {}, acoes: {} };
  const trades = [];
  const acc = criarResumoDia(null); // turnos, entradas limite, saídas e top 3 bloqueios (mesmo acumulador do painel)
  for (const l of linhas) {
    acumularResumo(acc, l);
    if (l.tipo === 'DECISAO') {
      dec.total++;
      if (l.gate?.ok) dec.aprovadasGate++;
      const b = 'bloqueio_duro' in l // ciclo novo: só bloqueio duro conta; legado: gate antigo
        ? (l.bloqueio_duro || 'SEM_BLOQUEIO_DURO')
        : (l.gate?.bloqueio || (l.gate?.ok ? 'APROVADO' : 'CONDICOES_INCOMPLETAS'));
      dec.bloqueios[b] = (dec.bloqueios[b] || 0) + 1;
      dec.acoes[l.acao] = (dec.acoes[l.acao] || 0) + 1;
    } else if (l.tipo === 'TRADE') trades.push(l);
  }
  const perna = (campo, lista = trades) => {
    const v = lista.map(t => t[campo]?.liquido).filter(x => Number.isFinite(x));
    const soma = v.reduce((a, b) => a + b, 0);
    const wins = v.filter(x => x > 0).length;
    return { n: v.length, soma, expectativa: v.length ? soma / v.length : 0, winRate: v.length ? wins / v.length : 0 };
  };
  const motivos = {};
  for (const t of trades) motivos[t.saida_motivo] = (motivos[t.saida_motivo] || 0) + 1;
  const r = formatarResumo(acc);
  return {
    decisoes: dec, trades: trades.length, motivos, testnet: perna('pnl_testnet'), mainnet: perna('pnl_mainnet'),
    // Expectativa líquida separada: gate antigo 5/5 teria aprovado (true) x entrada forçada (false); sem o campo = legado.
    porGateAntigo: {
      passou: { testnet: perna('pnl_testnet', trades.filter(t => t.passou_gate_antigo === true)), mainnet: perna('pnl_mainnet', trades.filter(t => t.passou_gate_antigo === true)) },
      forcada: { testnet: perna('pnl_testnet', trades.filter(t => t.passou_gate_antigo === false)), mainnet: perna('pnl_mainnet', trades.filter(t => t.passou_gate_antigo === false)) },
      semCampo: perna('pnl_testnet', trades.filter(t => typeof t.passou_gate_antigo !== 'boolean')).n
    },
    porJev: porJev(trades, perna),
    turnos: { total: r.turnos, vazios: r.turnosVazios, positivos: r.positivos, negativos: r.negativos },
    entradas: { total: r.entradasLimite, pctPreenchidas: r.pctEntradasLimitePreenchidas, pctCanceladas: r.pctEntradasCanceladas, pctGtxRejeitadas: r.pctEntradasGtxRejeitadas },
    saidas: { total: r.saidas, pctMarket: r.pctSaidasMarket },
    top3Bloqueios: r.top3Bloqueios
  };
}

// Win rate e expectativa líquida (testnet) separados por Jev = código x Jev ≠ código; nos que divergiram, quem acertou mais.
// Acertou = a direção virou lucro líquido: a que foi operada (lado do trade) é a do Jev; a contrária (código) ganharia se o trade perdeu.
function porJev(trades, perna) {
  const com = trades.filter(t => t.direcao_jev && t.direcao_codigo);
  const igual = com.filter(t => t.direcao_jev === t.direcao_codigo), diff = com.filter(t => t.direcao_jev !== t.direcao_codigo);
  const liq = (t) => t.pnl_testnet?.liquido;
  const dv = diff.filter(t => Number.isFinite(liq(t)));
  const jevAcertou = dv.filter(t => liq(t) > 0).length; // o trade seguiu o Jev
  const lat = trades.map(t => t.jev_latencia_ms).filter(Number.isFinite);
  return {
    igual: perna('pnl_testnet', igual), diferente: perna('pnl_testnet', diff),
    divergencia: { n: dv.length, jevAcertou, codigoAcertou: dv.length - jevAcertou },
    semOpiniaoJev: trades.length - com.length, timeouts: trades.filter(t => t.jev_timeout === true).length,
    latenciaMediaMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null
  };
}

function lerJsonl(arquivo) {
  if (!fs.existsSync(arquivo)) return [];
  return fs.readFileSync(arquivo, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

if (require.main === module) {
  const arq = process.argv[2] || path.join(__dirname, '..', 'logs', 'scalp_1m_decisoes.jsonl');
  const r = resumir(lerJsonl(arq));
  const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(4);
  const p = (x) => (x === null || x === undefined ? '--' : x.toFixed(1) + '%');
  console.log(`Arquivo: ${arq}`);
  console.log(`Turnos: ${r.turnos.total} | positivos ${r.turnos.positivos} | negativos ${r.turnos.negativos} | vazios ${r.turnos.vazios}`);
  console.log(`Decisões: ${r.decisoes.total} | aprovadas pelo gate: ${r.decisoes.aprovadasGate}`);
  console.log(`Bloqueios: ${JSON.stringify(r.decisoes.bloqueios)}`);
  console.log(`Top 3 bloqueios: ${r.top3Bloqueios.map(b => `${b.motivo} (${b.n})`).join(', ') || '--'}`);
  console.log(`Ações: ${JSON.stringify(r.decisoes.acoes)}`);
  console.log(`Entradas limite: ${r.entradas.total} | preenchidas ${p(r.entradas.pctPreenchidas)} | canceladas ${p(r.entradas.pctCanceladas)} | GTX rejeitadas ${p(r.entradas.pctGtxRejeitadas)}`);
  console.log(`Trades: ${r.trades} | saídas a Market ${p(r.saidas.pctMarket)} | motivos: ${JSON.stringify(r.motivos)}`);
  for (const k of ['mainnet', 'testnet']) {
    const q = r[k];
    console.log(`${k.toUpperCase()} (taxa maker 0,02% limite / taker 0,05% Market${k === 'mainnet' ? ' + slippage do book' : ''}): n=${q.n} | soma ${f(q.soma)} USDT | expectativa ${f(q.expectativa)} USDT/trade | win ${(q.winRate * 100).toFixed(1)}%`);
  }
  for (const [nome, rot] of [['passou', 'GATE ANTIGO 5/5 = true'], ['forcada', 'GATE ANTIGO 5/5 = false (forçada)']]) {
    for (const k of ['testnet', 'mainnet']) {
      const q = r.porGateAntigo[nome][k];
      console.log(`${rot} ${k}: n=${q.n} | soma ${f(q.soma)} USDT | expectativa líquida ${f(q.expectativa)} USDT/trade | win ${(q.winRate * 100).toFixed(1)}%`);
    }
  }
  for (const [nome, rot] of [['igual', 'JEV = CÓDIGO'], ['diferente', 'JEV ≠ CÓDIGO']]) {
    const q = r.porJev[nome];
    console.log(`${rot} testnet: n=${q.n} | win ${(q.winRate * 100).toFixed(1)}% | expectativa líquida ${f(q.expectativa)} USDT/trade | soma ${f(q.soma)} USDT`);
  }
  const dj = r.porJev.divergencia;
  console.log(`Divergiram (n=${dj.n}): Jev acertou ${dj.jevAcertou} | código acertou ${dj.codigoAcertou} | sem opinião do Jev: ${r.porJev.semOpiniaoJev} | jev_timeout: ${r.porJev.timeouts} | latência média ${r.porJev.latenciaMediaMs === null ? '--' : r.porJev.latenciaMediaMs.toFixed(0) + ' ms'}`);
  if (r.porGateAntigo.semCampo) console.log(`Trades sem passou_gate_antigo (legado): ${r.porGateAntigo.semCampo}`);
}

module.exports = { resumir, lerJsonl };
