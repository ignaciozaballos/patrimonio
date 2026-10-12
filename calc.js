/* Lógica de cálculo (sin DOM): series temporales, variaciones, formatos y avisos.
   Funciona en el navegador (window.Calc) y en Node (para las pruebas). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CATEGORIES = {
    efectivo: { label: 'Efectivo' },
    fondo: { label: 'Fondos' },
    accion: { label: 'Acciones' },
    plan_pensiones: { label: 'Planes de pensiones' },
    inmobiliario: { label: 'Inmobiliario' },
    deuda: { label: 'Deudas' },
  };
  const LIST_ORDER = ['efectivo', 'fondo', 'accion', 'plan_pensiones', 'inmobiliario'];
  const STACK_ORDER = ['inmobiliario', 'plan_pensiones', 'fondo', 'accion', 'efectivo']; // de abajo arriba
  const STALE_DAYS = { fondo: 10, accion: 7, plan_pensiones: 21, efectivo: 40, deuda: 40, inmobiliario: 400 };

  // ---------- fechas ('YYYY-MM-DD') ----------
  const toTs = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fromTs = (t) => new Date(t).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((toTs(b) - toTs(a)) / 86400000);
  const addDays = (s, n) => fromTs(toTs(s) + n * 86400000);
  function todayStr(now) {
    const d = now || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ---------- formatos (es-ES) ----------
  const nf = (opts) => new Intl.NumberFormat('es-ES', Object.assign({ useGrouping: 'always' }, opts));
  const eur0 = nf({ style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const eur2 = nf({ style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });
  const fmtEUR = (n, decimals) => (n == null || Number.isNaN(n)) ? '—' : (decimals ? eur2 : eur0).format(n);
  const fmtSigned = (n, decimals) => (n == null) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + fmtEUR(Math.abs(n), decimals);
  const fmtNum = (n, max = 4) => (n == null) ? '—' : nf({ maximumFractionDigits: max }).format(n);
  const fmtPct = (x) => {
    if (x == null || !Number.isFinite(x)) return '—';
    const s = nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(x * 100));
    return (x > 0.0004 ? '+' : x < -0.0004 ? '−' : '') + s + ' %';
  };
  const fmtCompactEUR = (n) => compact.format(n) + ' €';
  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function fmtDate(s, withYear = true) {
    if (!s) return '—';
    const [y, m, d] = s.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}` + (withYear ? ` ${y}` : '');
  }

  /** Lee un importe escrito a mano: "1.234,56", "1234.56", "1 234,5 €", "-300". */
  function parseAmount(input) {
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    let s = String(input == null ? '' : input).trim().replace(/[€\s ]/g, '');
    if (!s) return null;
    let neg = false;
    if (s[0] === '-' || s[0] === '−') { neg = true; s = s.slice(1); } else if (s[0] === '+') s = s.slice(1);
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
    const hasC = s.includes(','), hasD = s.includes('.');
    let dec;
    if (hasC && hasD) dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    else if (hasC) dec = ',';
    else if (hasD) {
      const parts = s.split('.');
      const thousands = parts.length > 2 || (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3 && parts[0] !== '0');
      dec = thousands ? null : '.';
    } else dec = null;
    if (dec === ',') s = s.replace(/\./g, '').replace(',', '.');
    else if (dec === '.') s = s.replace(/,/g, '');
    else s = s.replace(/[.,]/g, '');
    if ((s.match(/\./g) || []).length > 1) return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? (neg ? -n : n) : null;
  }

  // ---------- acceso a filas ordenadas por fecha ----------
  function groupBy(rows) {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.asset_id)) m.set(r.asset_id, []);
      m.get(r.asset_id).push(r);
    }
    for (const v of m.values()) v.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return m;
  }
  /** Última fila con fecha <= date (rows ordenadas ascendentemente). */
  function at(rows, date) {
    if (!rows || !rows.length) return null;
    let lo = 0, hi = rows.length - 1, res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].date <= date) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return res < 0 ? null : rows[res];
  }
  const last = (rows) => (rows && rows.length ? rows[rows.length - 1] : null);

  /** Parte propia del producto (1 = 100 %; 0,5 = cuenta al 50 % con otra persona). */
  const shareOf = (asset) => {
    const s = Number(asset && asset.share);
    return s > 0 && s <= 1 ? s : 1;
  };

  function valueAt(asset, idx, date) {
    const sh = shareOf(asset);
    if (asset.valuation === 'units') {
      const h = at(idx.holdings.get(asset.id), date);
      const p = at(idx.prices.get(asset.id), date);
      return h && p ? Number(h.units) * Number(p.price) * sh : null;
    }
    const m = at(idx.manual.get(asset.id), date);
    return m ? Number(m.value) * sh : null;
  }

  function thinDates(dates, today) {
    if (dates.length <= 600) return dates;
    const ref = today || dates[dates.length - 1];
    const cutoff = addDays(ref, -400);
    const out = [];
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      if (d >= cutoff || i === dates.length - 1) { out.push(d); continue; }
      if (dates[i + 1].slice(0, 7) !== d.slice(0, 7)) out.push(d); // último de cada mes
    }
    return out;
  }

  // ---------- modelo completo ----------
  function buildModel(data) {
    const assets = data.assets.slice().sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name, 'es'));
    const idx = { holdings: groupBy(data.holdings), prices: groupBy(data.prices), manual: groupBy(data.manual) };
    const set = new Set();
    for (const r of data.prices) set.add(r.date);
    for (const r of data.manual) set.add(r.date);
    for (const r of data.holdings) set.add(r.date);
    let dates = thinDates([...set].sort());

    const perAsset = new Map();
    for (const a of assets) perAsset.set(a.id, dates.map((d) => valueAt(a, idx, d)));

    // quitar fechas iniciales en las que todavía no hay ningún valor
    let start = 0;
    while (start < dates.length && assets.every((a) => perAsset.get(a.id)[start] == null)) start++;
    if (start > 0) {
      dates = dates.slice(start);
      for (const [k, v] of perAsset) perAsset.set(k, v.slice(start));
    }

    const byCat = {};
    for (const c of Object.keys(CATEGORIES)) byCat[c] = dates.map(() => 0);
    for (const a of assets) {
      const vals = perAsset.get(a.id);
      for (let i = 0; i < dates.length; i++) if (vals[i] != null) byCat[a.category][i] += vals[i];
    }
    const gross = dates.map((_, i) => LIST_ORDER.reduce((s, c) => s + byCat[c][i], 0));
    const net = gross.map((g, i) => g - byCat.deuda[i]);
    return { assets, idx, dates, perAsset, byCat, gross, net };
  }

  /** Datos del último momento de cada producto. */
  function latestInfo(asset, idx, today) {
    const limit = STALE_DAYS[asset.category] || 30;
    if (asset.valuation === 'units') {
      const h = last(idx.holdings.get(asset.id));
      const p = last(idx.prices.get(asset.id));
      const refDate = p ? (p.nav_date || p.date) : null;
      const age = refDate ? daysBetween(refDate, today) : null;
      return {
        units: h ? Number(h.units) : null,
        price: p ? Number(p.price) : null,
        priceDate: refDate, observed: p ? p.date : null, source: p ? p.source : null,
        value: h && p ? Number(h.units) * Number(p.price) * shareOf(asset) : null,
        age, stale: age != null && age > limit, missingPrice: !p, missingUnits: !h,
      };
    }
    const m = last(idx.manual.get(asset.id));
    const age = m ? daysBetween(m.date, today) : null;
    const sh = shareOf(asset);
    return { value: m ? Number(m.value) * sh : null, total: m ? Number(m.value) : null, share: sh, date: m ? m.date : null, age,
             stale: m ? age > limit : false, missingValue: !m };
  }

  /** Variación del patrimonio neto frente a hace `days` días. null si no hay historial tan antiguo. */
  function change(model, days) {
    const n = model.dates.length;
    if (n < 2) return null;
    const lastDate = model.dates[n - 1];
    const target = addDays(lastDate, -days);
    if (model.dates[0] > target) return null;
    let i = 0;
    for (let k = 0; k < n; k++) if (model.dates[k] <= target) i = k; else break;
    const from = model.net[i], to = model.net[n - 1];
    return { abs: to - from, pct: from > 0 ? to / from - 1 : null, fromDate: model.dates[i], toDate: lastDate };
  }

  /** Variación del precio unitario frente a hace `days` días (sin contar aportaciones). */
  function priceChange(asset, idx, days) {
    const rows = idx.prices.get(asset.id);
    const now = last(rows);
    if (!now) return null;
    const then = at(rows, addDays(now.date, -days));
    if (!then || then.date === now.date || Number(then.price) <= 0) return null;
    return Number(now.price) / Number(then.price) - 1;
  }

  /** Avisos para mostrar en el resumen. */
  function alerts(model, today) {
    const out = [];
    for (const a of model.assets) {
      if (!a.active) continue;
      const info = latestInfo(a, model.idx, today);
      if (a.valuation === 'units') {
        if (info.missingUnits) out.push({ level: 'warn', text: `${a.name}: faltan las participaciones.`, tab: 'inversiones', asset: a.id });
        else if (info.missingPrice) out.push({ level: 'warn', text: `${a.name}: todavía no tiene precio. Espera al flujo de GitHub o introdúcelo a mano.`, tab: 'inversiones', asset: a.id });
        else if (info.stale) out.push({ level: 'warn', text: `${a.name}: el último precio es del ${fmtDate(info.priceDate)} (hace ${info.age} días).`, tab: 'inversiones', asset: a.id });
      } else if (info.missingValue) {
        out.push({ level: 'info', text: `${a.name}: sin valor todavía. Añádelo en Actualizar.`, tab: 'actualizar' });
      } else if (info.stale) {
        out.push({ level: 'info', text: `${a.name}: sin actualizar desde el ${fmtDate(info.date)}.`, tab: 'actualizar' });
      }
    }
    return out;
  }

  return {
    CATEGORIES, LIST_ORDER, STACK_ORDER, STALE_DAYS,
    toTs, fromTs, daysBetween, addDays, todayStr,
    fmtEUR, fmtSigned, fmtNum, fmtPct, fmtCompactEUR, fmtDate, parseAmount,
    groupBy, at, last, shareOf, valueAt, thinDates, buildModel, latestInfo, change, priceChange, alerts,
  };
});
