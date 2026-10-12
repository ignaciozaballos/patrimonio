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
    const H = W < 520 ? 230 : 290;
    const padT = 8, padB = 24, padL = 0, padR = 0;
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
    let ymin = 0, ymax = Math.max(...allUpper, 1);
    if (spec.yMode === 'fit') {
      const vals = spec.series[0].values.filter((v) => v != null);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.05 || 1;
      ymin = Math.max(0, lo - pad); ymax = hi + pad;
    } else ymax *= 1.06;
    const y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * (H - padT - padB);

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
      'aria-label': spec.ariaLabel || 'Gráfico de evolución' }, host);
    svg.classList.add('chart-svg');

    // rejilla (detrás de las capas)
    const ticks = niceTicks(ymin, ymax, W < 520 ? 3 : 4).filter((v) => v > ymin || spec.yMode !== 'zero');
    const grid = el('g', {}, svg);
    ticks.forEach((v) => el('line', { x1: 0, x2: W, y1: y(v), y2: y(v), class: 'grid' }, grid));

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

    // etiquetas del eje Y (con halo para leerlas sobre las capas)
    ticks.forEach((v) => {
      const t = el('text', { x: 10, y: y(v) - 4, class: 'ylabel' }, svg);
      t.textContent = Calc.fmtCompactEUR(v);
    });
    // etiquetas del eje X
    const longSpan = (t1 - t0) / 86400000 > 330;
    const xt = [0, 1 / 3, 2 / 3, 1].map((f) => t0 + f * (t1 - t0));
    xt.forEach((t, k) => {
      const d = Calc.fromTs(Math.round(t / 86400000) * 86400000);
      const fx = (t - t0) / (t1 - t0 || 1);
      const tx = el('text', { x: Math.min(W - 10, Math.max(10, padL + fx * (W - padL - padR))), y: H - 7,
        class: 'xlabel', 'text-anchor': k === 0 ? 'start' : k === xt.length - 1 ? 'end' : 'middle' }, svg);
      tx.textContent = Calc.fmtDate(d, longSpan);
    });

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
        rows.push({ label: spec.series[0].label, value: spec.series[0].values[best], color: spec.series[0].color, total: true });
      }
      rows.forEach((row) => {
        const line = document.createElement('div');
        line.className = 'tip-row' + (row.total ? ' tip-total' : '');
        if (row.color) { const sw = document.createElement('i'); sw.style.background = row.color; line.appendChild(sw); }
        const a = document.createElement('span'); a.textContent = row.label;
        const b = document.createElement('b'); b.textContent = (spec.fmt || String)(row.value);
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

  root.Charts = { draw, destroy, niceTicks };
})(typeof self !== 'undefined' ? self : this);
