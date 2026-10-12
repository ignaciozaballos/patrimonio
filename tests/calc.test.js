// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calc.js');

const A = (id, extra) => Object.assign({ id, name: id, category: 'fondo', valuation: 'units', active: true, sort: 0 }, extra);
const H = (asset_id, date, units) => ({ asset_id, date, units });
const P = (asset_id, date, price, nav_date, source) => ({ asset_id, date, price, nav_date: nav_date || null, source: source || 'yahoo' });
const M = (asset_id, date, value) => ({ asset_id, date, value });

test('parseAmount entiende formatos españoles y ingleses', () => {
  const cases = [['1.234,56', 1234.56], ['1234.56', 1234.56], ['1 234,5 €', 1234.5], ['-300', -300],
    ['−300,5', -300.5], ['0,5', 0.5], ['13.88', 13.88], ['999.2598', 999.2598], ['1.234', 1234],
    ['1.234.567', 1234567], ['12.345', 12345], ['0.123', 0.123], ['1,234.56', 1234.56], ['5', 5], [' 7,00 ', 7]];
  for (const [input, expected] of cases) assert.equal(C.parseAmount(input), expected, input);
  for (const bad of ['', '   ', 'abc', '1,2,3x', '--5', null, undefined, '.', ',']) assert.equal(C.parseAmount(bad), null, String(bad));
  assert.equal(C.parseAmount(12.5), 12.5);
  assert.equal(C.parseAmount(NaN), null);
});

test('formatos', () => {
  assert.equal(C.fmtEUR(1234.5).replace(/\s/g, ' '), '1.235 €');
  assert.equal(C.fmtEUR(1234.5, 2).replace(/\s/g, ' '), '1.234,50 €');
  assert.equal(C.fmtEUR(null), '—');
  assert.equal(C.fmtPct(0.0213), '+2,1 %');
  assert.equal(C.fmtPct(-0.05), '−5,0 %');
  assert.equal(C.fmtPct(0), '0,0 %');
  assert.equal(C.fmtSigned(-12).replace(/\s/g, ' '), '−12 €');
  assert.equal(C.fmtDate('2026-10-09'), '9 oct 2026');
  assert.equal(C.fmtDate('2026-10-09', false), '9 oct');
  assert.equal(C.fmtNum(13.88), '13,88');
  assert.equal(C.fmtNum(1260.4912), '1.260,4912');
});

test('fechas', () => {
  assert.equal(C.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(C.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(C.daysBetween('2026-09-01', '2026-10-01'), 30);
  assert.equal(C.todayStr(new Date(2026, 9, 5)), '2026-10-05');
});

const data = () => ({
  assets: [
    A('f1', { sort: 1 }),
    A('f2', { sort: 2, category: 'plan_pensiones' }),
    A('c1', { sort: 3, category: 'efectivo', valuation: 'manual' }),
    A('h1', { sort: 4, category: 'deuda', valuation: 'manual' }),
  ],
  holdings: [H('f1', '2026-10-01', 10), H('f1', '2026-10-20', 20), H('f2', '2026-10-01', 100)],
  prices: [P('f1', '2026-10-02', 100), P('f1', '2026-10-10', 110), P('f1', '2026-10-25', 120),
           P('f2', '2026-10-02', 2), P('f2', '2026-10-25', 3)],
  manual: [M('c1', '2026-10-05', 1000), M('c1', '2026-10-30', 1500), M('h1', '2026-10-05', 400)],
});

test('serie: relleno hacia delante, participaciones por fecha y neto con deuda', () => {
  const m = C.buildModel(data());
  assert.deepEqual(m.dates, ['2026-10-02', '2026-10-05', '2026-10-10', '2026-10-20', '2026-10-25', '2026-10-30']);
  // f1: 10 x 100, 10 x 100, 10 x 110, 20 x 110, 20 x 120, 20 x 120
  assert.deepEqual(m.perAsset.get('f1'), [1000, 1000, 1100, 2200, 2400, 2400]);
  assert.deepEqual(m.byCat.plan_pensiones, [200, 200, 200, 200, 300, 300]);
  assert.deepEqual(m.byCat.efectivo, [0, 1000, 1000, 1000, 1000, 1500]);
  assert.deepEqual(m.byCat.deuda, [0, 400, 400, 400, 400, 400]);
  assert.deepEqual(m.gross, [1200, 2200, 2300, 3400, 3700, 4200]);
  assert.deepEqual(m.net, [1200, 1800, 1900, 3000, 3300, 3800]);
});

test('se recortan las fechas iniciales sin ningún valor', () => {
  const d = { assets: [A('f1')], holdings: [H('f1', '2026-10-01', 10)], prices: [P('f1', '2026-10-05', 100)], manual: [] };
  const m = C.buildModel(d);
  assert.deepEqual(m.dates, ['2026-10-05']);
  assert.deepEqual(m.net, [1000]);
});

test('sin datos: modelo vacío sin errores', () => {
  const m = C.buildModel({ assets: [A('f1')], holdings: [H('f1', '2026-10-01', 10)], prices: [], manual: [] });
  assert.equal(m.dates.length, 0);
  assert.equal(C.change(m, 30), null);
});

test('un producto dado de baja (participaciones 0) deja de contar', () => {
  const d = data();
  d.holdings.push(H('f2', '2026-10-26', 0));
  const m = C.buildModel(d);
  // la baja añade la fecha 2026-10-26 a la línea de tiempo
  assert.deepEqual(m.dates.slice(-3), ['2026-10-25', '2026-10-26', '2026-10-30']);
  assert.deepEqual(m.byCat.plan_pensiones, [200, 200, 200, 200, 300, 0, 0]);
});

test('variación a N días', () => {
  const m = C.buildModel(data());
  assert.equal(C.change(m, 30), null); // el historial solo cubre 28 días
  const c = C.change(m, 20); // objetivo 2026-10-10 -> neto 1900 ; ahora 3800
  assert.equal(c.fromDate, '2026-10-10');
  assert.equal(c.abs, 1900);
  assert.equal(c.pct, 1);
  const c2 = C.change(m, 25);
  assert.equal(c2.fromDate, '2026-10-05');
});

test('variación de precio unitario', () => {
  const m = C.buildModel(data());
  const f1 = m.assets.find((a) => a.id === 'f1');
  assert.ok(Math.abs(C.priceChange(f1, m.idx, 15) - (120 / 110 - 1)) < 1e-12);
  assert.equal(C.priceChange(f1, m.idx, 60), null);
});

test('latestInfo: obsolescencia por categoría', () => {
  const d = data();
  d.prices.push(P('f1', '2026-10-26', 130, '2026-10-20'));
  const m = C.buildModel(d);
  const f1 = m.assets.find((a) => a.id === 'f1');
  const info = C.latestInfo(f1, m.idx, '2026-11-02');
  assert.equal(info.units, 20);
  assert.equal(info.price, 130);
  assert.equal(info.value, 2600);
  assert.equal(info.priceDate, '2026-10-20'); // manda la fecha del VL, no la de captura
  assert.equal(info.age, 13);
  assert.equal(info.stale, true);
  const f2 = m.assets.find((a) => a.id === 'f2');
  assert.equal(C.latestInfo(f2, m.idx, '2026-11-02').stale, false); // plan: 21 días de margen
  const c1 = m.assets.find((a) => a.id === 'c1');
  assert.equal(C.latestInfo(c1, m.idx, '2026-11-02').stale, false);
  assert.equal(C.latestInfo(c1, m.idx, '2026-12-30').stale, true);
});

test('avisos', () => {
  const d = data();
  d.assets.push(A('f3', { sort: 9 }), A('c2', { sort: 10, category: 'efectivo', valuation: 'manual' }));
  d.holdings.push(H('f3', '2026-10-01', 5));
  const m = C.buildModel(d);
  const al = C.alerts(m, '2026-10-31');
  const texts = al.map((a) => a.text).join('|');
  assert.match(texts, /f3: todavía no tiene precio/);
  assert.match(texts, /c2: sin valor todavía/);
  assert.doesNotMatch(texts, /f1/);
  d.assets.find((a) => a.id === 'f3').active = false;
  assert.doesNotMatch(C.alerts(C.buildModel(d), '2026-10-31').map((a) => a.text).join('|'), /f3/);
});

test('thinDates conserva lo reciente y reduce lo antiguo a un punto por mes', () => {
  const dates = [];
  for (let t = Date.UTC(2023, 0, 1); t <= Date.UTC(2026, 9, 1); t += 86400000) dates.push(C.fromTs(t));
  const thin = C.thinDates(dates, '2026-10-01');
  assert.ok(thin.length < dates.length / 2);
  assert.equal(thin[thin.length - 1], '2026-10-01');
  assert.ok(thin.includes('2023-01-31'));
  assert.ok(thin.includes('2026-09-15')); // reciente: completo
  assert.deepEqual(C.thinDates(['2026-01-01', '2026-01-02']), ['2026-01-01', '2026-01-02']);
});
