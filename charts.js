/* Gráfico de áreas en SVG propio (sin librerías): capas apiladas, rejilla, fechas y lectura al pasar el dedo/ratón. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const C = () => root.Calc;

  function el(name, attrs, parent) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceTicks(lo, hi, count) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
    return out;
  }

  /**
   * spec = {
   *   dates: ['2026-10-01', ...],
   *   series: [{ label, color, values: [n|null, ...] }, ...]   // de abajo arriba
   *   stacked: true,           // apila las series (resumen) o dibuja una sola (detalle)
   *   yMode: 'zero' | 'fit',   // eje desde cero o ajustado al rango
   *   fmt: n => '1.234 €', ariaLabel: '...', showTotal: true, totalLabel: 'Patrimonio',
   *   extraRows: (i) => [{label, value}]   // filas extra en la etiqueta (p. ej. deudas)
   * }
   */
  function draw(host, spec) {
    host.__spec = spec;
    host.classList.add('chart');
    if (!host.__ro && typeof ResizeObserver !== 'undefined') {
      let lastW = 0;
      host.__ro = new ResizeObserver(() => {
        const w = Math.round(host.clientWidth);
        if (w && w !== lastW) { lastW = w; paint(host); }
      });
      host.__ro.observe(host);
    }
    paint(host);
  }

  function destroy(host) {
    if (host.__ro) { host.__ro.disconnect(); host.__ro = null; }
    host.__spec = null;
    host.textContent = '';
  }

  function paint(host) {
    const spec = host.__spec;
    if (!spec) return;
    const Calc = C();
    const n = spec.dates.length;
    host.textContent = '';
    if (n < 2) return;

    const W = Math.max(280, Math.round(host.clientWidth || 600));
    const H = W < 520 ? 240 : (spec.tall ? 360 : 290);
    const padT = 10, padB = 26, padL = W < 520 ? 44 : 54, padR = 8;
    const t0 = Calc.toTs(spec.dates[0]), t1 = Calc.toTs(spec.dates[n - 1]);
    const xs = spec.dates.map((d) => padL + ((Calc.toTs(d) - t0) / (t1 - t0 || 1)) * (W - padL - padR));

    // acumulados
    const cum = [];
    let run = new Array(n).fill(0);
    spec.series.forEach((s) => {
      const lower = run.slice();
      run = run.map((v, i) => v + (s.values[i] == null ? 0 : (spec.stacked ? s.values[i] : 0)));
      if (!spec.stacked) run = s.values.map((v) => (v == null ? 0 : v));
      cum.push({ lower: spec.stacked ? lower : run.map(() => 0), upper: run.slice() });
    });
    const tops = cum.length ? cum[cum.length - 1].upper : [];
    const allUpper = tops.filter((v) => v != null);
    const extra = (spec.lines || []).flatMap((l) => l.values.filter((v) => v != null));
    let ymin = 0, ymax = Math.max(...allUpper, ...extra, 1);
    if (spec.yMode === 'fit') {
      const vals = spec.series[0].values.filter((v) => v != null).concat(extra);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.05 || 1;
      ymin = Math.max(0, lo - pad); ymax = hi + pad;
    } else ymax *= 1.06;
    const y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * (H - padT - padB);

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
      'aria-label': spec.ariaLabel || 'Gráfico de evolución' }, host);
    svg.classList.add('chart-svg');

    // rejilla (detrás de las capas)
    const ticks = niceTicks(ymin, ymax, W < 520 ? 4 : 5).filter((v) => v >= ymin && v <= ymax);
    const grid = el('g', {}, svg);
    ticks.forEach((v) => el('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: 'grid' }, grid));
    el('line', { x1: padL, x2: W - padR, y1: H - padB, y2: H - padB, class: 'axis' }, grid);

    // capas
    const layers = el('g', { class: 'layers' }, svg);
    spec.series.forEach((s, k) => {
      const up = cum[k].upper, lo = spec.stacked ? cum[k].lower : null;
      let d = 'M' + xs[0].toFixed(1) + ' ' + y(up[0]).toFixed(1);
      for (let i = 1; i < n; i++) d += 'L' + xs[i].toFixed(1) + ' ' + y(up[i]).toFixed(1);
      if (lo) for (let i = n - 1; i >= 0; i--) d += 'L' + xs[i].toFixed(1) + ' ' + y(lo[i]).toFixed(1);
      else d += 'L' + xs[n - 1].toFixed(1) + ' ' + y(ymin).toFixed(1) + 'L' + xs[0].toFixed(1) + ' ' + y(ymin).toFixed(1);
      const p = el('path', { d: d + 'Z', class: spec.stacked ? 'layer' : 'layer single' }, layers);
      p.style.fill = s.color;
      if (!spec.stacked) {
        let dl = 'M' + xs[0].toFixed(1) + ' ' + y(up[0]).toFixed(1);
        for (let i = 1; i < n; i++) dl += 'L' + xs[i].toFixed(1) + ' ' + y(up[i]).toFixed(1);
        const line = el('path', { d: dl, class: 'topline' }, layers);
        line.style.stroke = s.color;
      }
    });

    // líneas de referencia (p. ej. capital aportado)
    (spec.lines || []).forEach((l) => {
      let d = '', started = false;
      for (let i = 0; i < n; i++) {
        if (l.values[i] == null) continue;
        d += (started ? 'L' : 'M') + xs[i].toFixed(1) + ' ' + y(l.values[i]).toFixed(1); started = true;
      }
      const p = el('path', { d, class: 'refline' + (l.dashed === false ? '' : ' dashed') }, svg);
      p.style.stroke = l.color || 'var(--muted)';
    });

    // eje Y (valores a la izquierda)
    ticks.forEach((v) => {
      const t = el('text', { x: padL - 7, y: y(v) + 4, class: 'ylabel', 'text-anchor': 'end' }, svg);
      t.textContent = Calc.fmtCompactEUR(v);
    });
    // eje X (fechas repartidas por el periodo)
    const spanDays = (t1 - t0) / 86400000, longSpan = spanDays > 330;
    const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const nx = W < 520 ? 4 : W < 800 ? 6 : 8;
    for (let k = 0; k < nx; k++) {
      const f = k / (nx - 1), t = t0 + f * (t1 - t0);
      const d = Calc.fromTs(Math.round(t / 86400000) * 86400000);
      const label = spanDays > 200 ? MES[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(2, 4) : Calc.fmtDate(d, false);
      const x = padL + f * (W - padL - padR);
      el('line', { x1: x, x2: x, y1: H - padB, y2: H - padB + 4, class: 'axis' }, svg);
      const tx = el('text', { x, y: H - 7, class: 'xlabel', 'text-anchor': k === 0 ? 'start' : k === nx - 1 ? 'end' : 'middle' }, svg);
      tx.textContent = label;
    }
    void longSpan;

    // lectura al pasar el ratón / dedo
    const cursor = el('line', { class: 'cursor', y1: padT, y2: H - padB, x1: 0, x2: 0, visibility: 'hidden' }, svg);
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    host.appendChild(tip);

    function show(clientX) {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / (r.width || 1)) * W;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const dd = Math.abs(xs[i] - px); if (dd < bd) { bd = dd; best = i; } }
      cursor.setAttribute('x1', xs[best]); cursor.setAttribute('x2', xs[best]);
      cursor.setAttribute('visibility', 'visible');
      tip.textContent = '';
      const head = document.createElement('div');
      head.className = 'tip-date';
      head.textContent = Calc.fmtDate(spec.dates[best]);
      tip.appendChild(head);
      const rows = [];
      if (spec.stacked) {
        for (let k = spec.series.length - 1; k >= 0; k--) {
          const v = spec.series[k].values[best];
          if (v) rows.push({ label: spec.series[k].label, value: v, color: spec.series[k].color });
        }
        (spec.extraRows ? spec.extraRows(best) : []).forEach((x) => rows.push(x));
        if (spec.showTotal) rows.push({ label: spec.totalLabel || 'Total', value: spec.totalValues ? spec.totalValues[best] : tops[best], total: true });
      } else {
        rows.push({ label: spec.series[0].label, value: spec.series[0].values[best], color: spec.series[0].color, total: !(spec.lines || []).length });
      }
      (spec.lines || []).forEach((l) => { if (l.values[best] != null) rows.push({ label: l.label, value: l.values[best], color: l.color || 'var(--muted)' }); });
      if (spec.diffRow && spec.lines && spec.lines[0] && spec.lines[0].values[best] != null) {
        const dv = spec.series[0].values[best] - spec.lines[0].values[best];
        rows.push({ label: spec.diffRow, value: dv, total: true, signed: true });
      }
      rows.forEach((row) => {
        const line = document.createElement('div');
        line.className = 'tip-row' + (row.total ? ' tip-total' : '');
        if (row.color) { const sw = document.createElement('i'); sw.style.background = row.color; line.appendChild(sw); }
        const a = document.createElement('span'); a.textContent = row.label;
        const b = document.createElement('b'); b.textContent = row.signed && spec.fmtSigned ? spec.fmtSigned(row.value) : (spec.fmt || String)(row.value);
        line.appendChild(a); line.appendChild(b); tip.appendChild(line);
      });
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const left = xs[best] + 12 + tw > W ? xs[best] - 12 - tw : xs[best] + 12;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = '6px';
    }
    function hide() { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    svg.addEventListener('pointermove', (e) => show(e.clientX));
    svg.addEventListener('pointerdown', (e) => show(e.clientX));
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointercancel', hide);
  }

  /** Rosco: items = [{label, value, color}]. Devuelve el SVG (el texto del centro se pone con HTML). */
  function donut(host, items, opts) {
    host.textContent = '';
    const total = items.reduce((s, x) => s + x.value, 0);
    const S = 220, R = 92, r = 62, cx = S / 2, cy = S / 2;
    const svg = el('svg', { viewBox: `0 0 ${S} ${S}`, role: 'img', 'aria-label': (opts && opts.ariaLabel) || 'Reparto', class: 'donut-svg' }, host);
    if (!(total > 0)) return;
    let a0 = -Math.PI / 2;
    items.forEach((it, k) => {
      const frac = it.value / total, a1 = a0 + frac * Math.PI * 2 - (items.length > 1 ? 0.012 : 0);
      if (frac <= 0) return;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, a) => [(cx + rad * Math.cos(a)).toFixed(2), (cy + rad * Math.sin(a)).toFixed(2)];
      const [x0, y0] = p(R, a0), [x1, y1] = p(R, a1), [x2, y2] = p(r, a1), [x3, y3] = p(r, a0);
      const path = el('path', { d: `M${x0} ${y0}A${R} ${R} 0 ${big} 1 ${x1} ${y1}L${x2} ${y2}A${r} ${r} 0 ${big} 0 ${x3} ${y3}Z`, class: 'slice', 'data-i': k }, svg);
      path.style.fill = it.color;
      const t = el('title', {}, path); t.textContent = `${it.label}: ${(opts && opts.fmt ? opts.fmt(it.value) : it.value)} (${Math.round(frac * 100)} %)`;
      a0 += frac * Math.PI * 2;
    });
  }

  /** Barras verticales con valores +/-: items = [{label, value}]. */
  function bars(host, items, opts) {
    host.textContent = '';
    const Calc = C(), n = items.length;
    if (!n) return;
    const W = Math.max(280, Math.round(host.clientWidth || 600)), H = 190, padT = 12, padB = 26;
    const maxAbs = Math.max(...items.map((x) => Math.abs(x.value)), 1);
    const hasNeg = items.some((x) => x.value < 0);
    const zero = hasNeg ? padT + (H - padT - padB) * 0.5 : H - padB;
    const scale = (hasNeg ? (H - padT - padB) / 2 : (H - padT - padB)) / (maxAbs * 1.1);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': (opts && opts.ariaLabel) || 'Barras', class: 'chart-svg' }, host);
    el('line', { x1: 0, x2: W, y1: zero, y2: zero, class: 'grid' }, svg);
    const slot = W / n, bw = Math.min(64, slot * 0.62);
    items.forEach((it, k) => {
      const h = Math.abs(it.value) * scale, x = k * slot + (slot - bw) / 2;
      const rect = el('rect', { x: x.toFixed(1), width: bw.toFixed(1), y: (it.value >= 0 ? zero - h : zero).toFixed(1), height: Math.max(1, h).toFixed(1), rx: 4, class: 'bar ' + (it.value >= 0 ? 'up' : 'down') }, svg);
      const t = el('title', {}, rect); t.textContent = `${it.label}: ${opts && opts.fmtSigned ? opts.fmtSigned(it.value) : it.value}`;
      const lx = el('text', { x: (x + bw / 2).toFixed(1), y: H - 8, class: 'xlabel', 'text-anchor': 'middle' }, svg); lx.textContent = it.label;
      if (n <= 14) {
        const vy = it.value >= 0 ? zero - h - 4 : zero + h + 11;
        const vt = el('text', { x: (x + bw / 2).toFixed(1), y: vy.toFixed(1), class: 'barval', 'text-anchor': 'middle' }, svg);
        vt.textContent = Calc.fmtCompactEUR(it.value);
      }
    });
  }

  root.Charts = { draw, destroy, niceTicks, donut, bars };
})(typeof self !== 'undefined' ? self : this);
