/* Análisis derivados (sin DOM): rentabilidad, mensual, hipotecas, calendario, proyección y concentración.
   Funciona en el navegador (window.Analytics) y en Node (para las pruebas). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calc.js'));
  else root.Analytics = factory(root.Calc);
})(typeof self !== 'undefined' ? self : this, function (Calc) {
  'use strict';

  const UNIT_CATS = ['fondo', 'accion', 'plan_pensiones'];
  const INVEST_CATS = UNIT_CATS;
  const LIQUID_CATS = ['efectivo', 'fondo', 'accion'];
  const active = (m) => m.assets.filter((a) => a.active);

  // ---------- fechas ----------
  function monthLen(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m = 1..12
  function dateIn(y, m, day) { return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, monthLen(y, m))).padStart(2, '0')}`; }
  function addMonths(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const t = (y * 12 + (m - 1)) + n;
    return dateIn(Math.floor(t / 12), (t % 12) + 1, d);
  }
  /** Primera fecha >= from que cae en `day` del mes (si el mes es corto, el último día). */
  function nextOccurrence(day, from) {
    const [y, m] = from.split('-').map(Number);
    const d0 = dateIn(y, m, day);
    if (d0 >= from) return d0;
    const nx = addMonths(dateIn(y, m, 1), 1).split('-').map(Number);
    return dateIn(nx[0], nx[1], day);
  }

  // ---------- aportado y rentabilidad ----------
  function flowPrice(prices, date) {
    if (!prices || !prices.length) return null;
    const p = Calc.at(prices, date);
    if (p) return Number(p.price);
    const first = prices[0];
    return Calc.daysBetween(date, first.date) <= 31 ? Number(first.price) : null;
  }
  /** Movimientos de dinero de un producto: cada cambio de participaciones × precio de ese día × tu parte. */
  function flows(asset, idx) {
    const hs = idx.holdings.get(asset.id) || [], ps = idx.prices.get(asset.id) || [];
    const sh = Calc.shareOf(asset), out = [];
    let prev = 0;
    for (const h of hs) {
      const u = Number(h.units), delta = u - prev;
      prev = u;
      if (Math.abs(delta) < 1e-9) continue;
      const p = flowPrice(ps, h.date);
      if (p != null) out.push({ date: h.date, amount: delta * p * sh });
    }
    return out;
  }
  function returns(model, today) {
    const rows = [];
    for (const a of active(model)) {
      if (!UNIT_CATS.includes(a.category)) continue;
      const info = Calc.latestInfo(a, model.idx, today);
      if (info.value == null) continue;
      const fl = flows(a, model.idx);
      const invested = fl.reduce((s, f) => s + f.amount, 0);
      const hs = model.idx.holdings.get(a.id) || [];
      rows.push({ asset: a, value: info.value, invested, gain: info.value - invested,
        pct: invested > 0.5 ? info.value / invested - 1 : null, since: hs.length ? hs[0].date : null, info });
    }
    const value = rows.reduce((s, r) => s + r.value, 0), invested = rows.reduce((s, r) => s + r.invested, 0);
    return { rows, value, invested, gain: value - invested, pct: invested > 0.5 ? value / invested - 1 : null };
  }
  /** Capital aportado acumulado a cada fecha del modelo (solo productos con participaciones). */
  function investedSeries(model) {
    const all = [];
    for (const a of active(model)) if (UNIT_CATS.includes(a.category)) all.push(...flows(a, model.idx));
    all.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    let i = 0, run = 0;
    return model.dates.map((d) => { while (i < all.length && all[i].date <= d) run += all[i++].amount; return run; });
  }
  const investValueSeries = (model) => model.dates.map((_, i) => INVEST_CATS.reduce((s, c) => s + model.byCat[c][i], 0));

  // ---------- evolución mensual y en el año ----------
  function monthly(model) {
    const out = [];
    model.dates.forEach((d, i) => {
      const k = d.slice(0, 7);
      if (out.length && out[out.length - 1].month === k) { out[out.length - 1].date = d; out[out.length - 1].i = i; }
      else out.push({ month: k, date: d, i });
    });
    return out.map((r, k) => {
      const prev = k > 0 ? model.net[out[k - 1].i] : null, net = model.net[r.i];
      return { month: r.month, date: r.date, net, delta: prev != null ? net - prev : null, pct: prev > 0 ? net / prev - 1 : null,
        gross: model.gross[r.i], debt: model.byCat.deuda[r.i] };
    });
  }
  /** Estadísticas entre dos fechas: patrimonio generado, media mensual y deuda reducida. */
  function periodStats(model, from, to) {
    const n = model.dates.length;
    if (n < 2) return null;
    let i0 = 0, i1 = -1;
    for (let k = 0; k < n; k++) { if (model.dates[k] <= from) i0 = k; if (model.dates[k] <= to) i1 = k; }
    if (i1 <= i0) return null;
    const d0 = model.dates[i0], d1 = model.dates[i1];
    const start = model.net[i0], end = model.net[i1], months = Calc.daysBetween(d0, d1) / 30.4375;
    const generated = end - start;
    return { fromDate: d0, toDate: d1, months, start, end, generated, genPct: start > 0 ? end / start - 1 : null,
      avgMonthly: generated / months, avgPct: start > 0 && end > 0 && months > 0 ? Math.pow(end / start, 1 / months) - 1 : null,
      debtStart: model.byCat.deuda[i0], debtEnd: model.byCat.deuda[i1], debtReduction: model.byCat.deuda[i0] - model.byCat.deuda[i1], i0, i1 };
  }
  function ytd(model, today) {
    const n = model.dates.length;
    if (n < 2) return null;
    const jan = today.slice(0, 4) + '-01-01';
    let i = -1;
    for (let k = 0; k < n; k++) if (model.dates[k] < jan) i = k; else break;
    const partial = i < 0;
    if (partial) i = 0;
    const from = model.net[i], to = model.net[n - 1];
    return { abs: to - from, pct: from > 0 ? to / from - 1 : null, fromDate: model.dates[i], partial };
  }

  // ---------- hipotecas y calendario ----------
  function loanInfo(asset, model, today) {
    const L = asset.loan;
    if (!L || !(Number(L.payment) > 0)) return null;
    const info = Calc.latestInfo(asset, model.idx, today);
    if (info.missingValue) return null;
    const payment = Number(L.payment), rate = Number(L.rate) || 0, day = parseInt(L.day, 10) || 1;
    let bal = info.total, n = 0, interest = 0;
    while (bal > 0.005 && n < 1200) {
      const i = bal * rate / 1200;
      if (payment <= i) return { asset, balance: info.total, payment, rate, day, share: info.share, months: null, payoff: null, interestLeft: null, never: true };
      interest += i; bal -= Math.min(bal, payment - i); n++;
    }
    const first = nextOccurrence(day, today);
    return { asset, balance: info.total, payment, rate, day, share: info.share, months: n, payoff: n ? addMonths(first, n - 1) : null,
      interestLeft: interest, next: first };
  }
  function loans(model, today) { return active(model).filter((a) => a.category === 'deuda').map((a) => loanInfo(a, model, today)).filter(Boolean); }

  function upcoming(model, today, days) {
    const end = Calc.addDays(today, days || 45), out = [];
    for (const a of active(model)) {
      const sh = Calc.shareOf(a);
      if (a.plan && Number(a.plan.amount) > 0) {
        const day = parseInt(a.plan.day, 10);
        for (let d = nextOccurrence(day, today); d <= end; d = nextOccurrence(day, Calc.addDays(d, 1))) out.push({ date: d, kind: 'aportacion', label: a.name, amount: Number(a.plan.amount) });
      }
      if (a.loan && Number(a.loan.payment) > 0) {
        const day = parseInt(a.loan.day, 10);
        for (let d = nextOccurrence(day, today); d <= end; d = nextOccurrence(day, Calc.addDays(d, 1))) out.push({ date: d, kind: 'cuota', label: a.name, amount: Number(a.loan.payment) * sh });
      }
    }
    return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  }
  function monthlyContributions(model) {
    return active(model).reduce((s, a) => s + (a.plan && Number(a.plan.amount) > 0 ? Number(a.plan.amount) * Calc.shareOf(a) : 0), 0);
  }

  // ---------- proyección ilustrativa ----------
  function project(model, today, opt) {
    const months = opt.months || 120, r = (opt.returnPct || 0) / 1200, g = (opt.realEstatePct || 0) / 1200;
    const n = model.dates.length;
    if (!n) return null;
    const cur = (c) => model.byCat[c][n - 1];
    let invest = INVEST_CATS.reduce((s, c) => s + cur(c), 0), cash = cur('efectivo'), re = cur('inmobiliario');
    const contrib = monthlyContributions(model);
    const ln = loans(model, today).map((l) => ({ bal: l.balance, rate: l.rate, payment: l.payment, share: l.share }));
    const loanIds = new Set(loans(model, today).map((l) => l.asset.id));
    let otherDebt = 0;
    for (const a of active(model)) if (a.category === 'deuda' && !loanIds.has(a.id)) { const i = Calc.latestInfo(a, model.idx, today); otherDebt += i.value || 0; }
    const dates = [today], net = [], inv = [], debt = [];
    const push = () => {
      const d = ln.reduce((s, l) => s + l.bal * l.share, 0) + otherDebt;
      net.push(cash + invest + re - d); inv.push(invest); debt.push(d);
    };
    push();
    for (let k = 1; k <= months; k++) {
      invest = invest * (1 + r) + contrib; re *= 1 + g;
      for (const l of ln) if (l.bal > 0.005) { const i = l.bal * l.rate / 1200; l.bal = Math.max(0, l.bal - Math.max(0, Math.min(l.bal, l.payment - i))); }
      dates.push(addMonths(today, k)); push();
    }
    return { dates, net, invest: inv, debt, contrib };
  }

  // ---------- reparto y concentración ----------
  function positions(model, today) {
    return active(model).filter((a) => a.category !== 'deuda').map((a) => ({ asset: a, value: Calc.latestInfo(a, model.idx, today).value || 0 }))
      .filter((p) => p.value > 0.005).sort((x, y) => y.value - x.value);
  }
  function byEntity(model, today) {
    const m = new Map();
    for (const p of positions(model, today)) { const k = p.asset.entity || 'Sin entidad'; m.set(k, (m.get(k) || 0) + p.value); }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((x, y) => y.value - x.value);
  }
  function concentration(model, today) {
    const pos = positions(model, today), n = model.dates.length;
    const gross = pos.reduce((s, p) => s + p.value, 0);
    if (!gross) return null;
    const debt = n ? model.byCat.deuda[n - 1] : 0;
    const liquid = LIQUID_CATS.reduce((s, c) => s + (n ? model.byCat[c][n - 1] : 0), 0);
    return { gross, count: pos.length, top: pos[0], topPct: pos[0].value / gross, top3Pct: pos.slice(0, 3).reduce((s, p) => s + p.value, 0) / gross,
      liquid, liquidPct: liquid / gross, debt, debtPct: debt / gross };
  }
  function movers(model, days) {
    return active(model).filter((a) => UNIT_CATS.includes(a.category))
      .map((a) => ({ asset: a, pct: Calc.priceChange(a, model.idx, days) })).filter((x) => x.pct != null).sort((x, y) => y.pct - x.pct);
  }

  /** Meses hasta el objetivo al ritmo medio de los últimos 90 días (null si no avanza). */
  function goalETA(model, goal) {
    const n = model.dates.length;
    if (n < 2 || !(goal > 0)) return null;
    const cur = model.net[n - 1];
    if (cur >= goal) return { reached: true };
    const last = model.dates[n - 1], target = Calc.addDays(last, -90);
    let i = 0;
    for (let k = 0; k < n; k++) if (model.dates[k] <= target) i = k; else break;
    const days = Calc.daysBetween(model.dates[i], last);
    if (days < 20) return null;
    const perMonth = (cur - model.net[i]) / days * 30.44;
    if (perMonth <= 0) return null;
    const months = Math.ceil((goal - cur) / perMonth);
    return { reached: false, perMonth, months, date: addMonths(last, months) };
  }

  function evolutionCSV(model) {
    const cats = ['efectivo', 'fondo', 'accion', 'plan_pensiones', 'inmobiliario', 'deuda'];
    const head = ['fecha', ...cats, 'activos', 'patrimonio_neto'];
    const rows = model.dates.map((d, i) => [d, ...cats.map((c) => model.byCat[c][i].toFixed(2)), model.gross[i].toFixed(2), model.net[i].toFixed(2)].join(';'));
    return [head.join(';'), ...rows].join('\n');
  }

  return { UNIT_CATS, INVEST_CATS, LIQUID_CATS, addMonths, nextOccurrence, flows, returns, investedSeries, investValueSeries, monthly, periodStats, ytd,
    loanInfo, loans, upcoming, monthlyContributions, project, positions, byEntity, concentration, movers, goalETA, evolutionCSV };
});
