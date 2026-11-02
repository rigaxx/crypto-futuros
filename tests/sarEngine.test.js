const assert = require('assert');
const sar = require('../lib/sarEngine');
function k(i, o, h, l, c) { return [60000 * i, String(o), String(h), String(l), String(c), '100']; }
// 60 velas de queda, depois 3 de alta forte -> SAR deve virar para ABAIXO com poucas bolinhas
const ks = []; let p = 100;
for (let i = 0; i < 60; i++) { const o = p; p -= 0.3; ks.push(k(i, o, o + 0.05, p - 0.05, p)); }
for (let i = 60; i < 63; i++) { const o = p; p += 1.2; ks.push(k(i, o, p + 0.05, o - 0.05, p)); }
const e = sar.construirEsqueleto(1, 'TESTUSDT', ks);
assert(e, 'esqueleto nulo');
assert.strictEqual(e.sar1m.posicaoAtual, 'ABAIXO');
assert.strictEqual(e.sar1m.posicaoAnterior, 'ACIMA');
assert(e.sar1m.bolinhasConsecutivas <= 3, 'bolinhas=' + e.sar1m.bolinhasConsecutivas);
assert.strictEqual(sar.direcaoDoSar(e), 'LONG');
assert.strictEqual(e.linhasConfirmacao1m.rsi14_inclinacao, 'SUBINDO');
assert.strictEqual(e.linhasConfirmacao1m.ema9_inclinacao, 'SUBINDO');
// virouAgora é verdadeiro exatamente na 2ª bolinha (1ª e 3ª não)
const f = n => sar.construirEsqueleto(1, 'T', ks.slice(0, n)).sar1m;
assert.strictEqual(f(61).bolinhasConsecutivas, 1);
assert.strictEqual(f(61).virouAgora, false);
assert.strictEqual(f(62).bolinhasConsecutivas, 2);
assert.strictEqual(f(62).virouAgora, true);
assert.strictEqual(f(63).virouAgora, false);
// dados inválidos
assert.strictEqual(sar.construirEsqueleto(1, 'X', ks.map(r => r.slice().fill('abc', 2, 3))), null);
assert.strictEqual(sar.construirEsqueleto(1, 'X', ks.slice(0, 10)), null);
assert.strictEqual(sar.direcaoDoSar(null), null);

