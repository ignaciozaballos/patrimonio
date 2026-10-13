/* Patrimonio · interfaz. Todo lo que se escribe pasa por Supabase (con tu sesión); nada se guarda en el navegador salvo la sesión. */
(function () {
  'use strict';
  const Calc = window.Calc, Charts = window.Charts;
  const CFG = window.PATRIMONIO_CONFIG || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const app = $('#app'), dlg = $('#dlg'), toastEl = $('#toast');

  // ---------- plantillas con escape automático ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  class Raw { constructor(s) { this.s = s; } }
  const raw = (s) => new Raw(s);
  const part = (v) => (Array.isArray(v) ? v.map(part).join('') : v instanceof Raw ? v.s : esc(v));
  function html(strings, ...vals) {
    let out = '';
    strings.forEach((s, i) => { out += s; if (i < vals.length) out += part(vals[i]); });
    return new Raw(out);
  }

  const pctPlain = new Intl.NumberFormat('es-ES', { style: 'percent', maximumFractionDigits: 0 });
  const TABS = [['resumen', 'Resumen'], ['inversiones', 'Inversiones'], ['cuentas', 'Cuentas'], ['actualizar', 'Actualizar'], ['ajustes', 'Ajustes']];
  const CAT_OPTIONS = [['efectivo', 'Efectivo (cuenta bancaria)'], ['fondo', 'Fondo de inversión'], ['accion', 'Acción'],
    ['plan_pensiones', 'Plan de pensiones'], ['inmobiliario', 'Inmobiliario'], ['deuda', 'Deuda (hipoteca, préstamo)']];
  const UNIT_CATS = ['fondo', 'accion', 'plan_pensiones'];
  const SOURCE_TYPES = ['yahoo', 'ft', 'quefondos', 'finect', 'url_regex'];

  const state = { sb: null, user: null, data: null, model: null, tab: 'resumen', range: 'todo', revealed: false, dlg: null };

  // ---------- avisos ----------
  let toastTimer;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (isErr ? ' err' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, isErr ? 7000 : 3200);
  }
  function handleError(e) {
    const msg = e && e.message ? e.message : String(e);
    if (/jwt|expired|not authenticated/i.test(msg) || (e && (e.status === 401 || e.code === 'PGRST301'))) {
      toast('La sesión ha caducado. Vuelve a entrar.', true);
      state.sb.auth.signOut();
      return;
    }
    toast('No se ha podido completar: ' + msg, true);
  }
  async function run(btn, fn, okMsg) {
    if (btn) btn.disabled = true;
    try { await fn(); if (okMsg) toast(okMsg); }
    catch (e) { handleError(e); }
    finally { if (btn) btn.disabled = false; }
  }
  const must = ({ data, error }) => { if (error) throw error; return data; };

  // ---------- arranque ----------
  async function boot() {
    const url = CFG.SUPABASE_URL || '', key = CFG.SUPABASE_KEY || '';
    if (!url || !key || /TU-PROYECTO|TU_CLAVE/.test(url + key)) return showSetup();
    if (!window.supabase) {
      app.innerHTML = html`<div class="setup"><h1>Patrimonio</h1><p class="msg err">No se ha podido cargar la librería de Supabase (cdn.jsdelivr.net). Comprueba tu conexión o si algún bloqueador la impide.</p></div>`.s;
      return;
    }
    state.sb = window.supabase.createClient(url, key);
    state.sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { state.user = null; showLogin(); } });
    const { data } = await state.sb.auth.getSession();
    if (data && data.session) { state.user = data.session.user; await enterApp(); } else showLogin();
  }

  function showSetup() {
    app.innerHTML = html`<div class="setup"><h1>Patrimonio</h1>
      <p>Falta conectar la web con tu proyecto de Supabase. Abre <b>config.js</b>, pega la dirección del proyecto y la clave publicable, y vuelve a subirlo a GitHub.</p>
      <p class="muted small">Los pasos están en la guía de puesta en marcha.</p></div>`.s;
  }

  // ---------- acceso por código ----------
  function showLogin(step, email, message, isErr) {
    step = step || 'email'; email = email || '';
    dlg.open && dlg.close();
    app.innerHTML = html`<main class="login">
      <h1>Patrimonio</h1>
      <p class="lead">Tus cuentas, inversiones y planes en un solo sitio. Entra con el enlace (o el código) que te llega por correo.</p>
      ${step === 'email' ? html`
        <form data-form="login-email" novalidate>
          <label for="em">Correo electrónico</label>
          <input id="em" name="email" type="email" inputmode="email" autocomplete="email" required value="${email}">
          <div class="actions"><button class="btn" type="submit">Enviar enlace de acceso</button></div>
        </form>` : html`
        <form data-form="login-code" novalidate>
          <input type="hidden" name="email" value="${email}">
          <label for="cd">Código recibido en ${email} (solo si el correo trae un código; si trae un enlace, pulsa el enlace)</label>
          <input id="cd" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required>
          <div class="actions">
            <button class="btn" type="submit">Entrar</button>
            <button class="btn link" type="button" data-action="login-back">Usar otro correo</button>
          </div>
        </form>`}
      <p class="msg${isErr ? ' err' : ' muted'}" role="status">${message || ''}</p>
    </main>`.s;
    const first = $('#em') || $('#cd');
    if (first) first.focus();
  }

  function loginMessage(error) {
    const m = (error && error.message) || '';
    if ((error && error.status === 429) || /rate limit|too many|seconds/i.test(m)) return 'Has pedido demasiados códigos seguidos. Espera un rato y vuelve a intentarlo (el correo gratuito de Supabase permite muy pocos envíos por hora).';
    if (/not authorized/i.test(m)) return 'Supabase solo envía correos a las personas de tu organización. Usa el email de tu cuenta de Supabase o configura un SMTP propio.';
    if (/signups? not allowed|not allowed for otp|user not found/i.test(m)) return 'Ese correo no tiene acceso. Tiene que ser el mismo con el que creaste tu usuario en Supabase.';
    return 'No se ha podido enviar el código: ' + (m || 'error desconocido');
  }

  // ---------- datos ----------
  async function fetchAll(table, orderCols) {
    const out = [], size = 1000;
    for (let from = 0; ; from += size) {
      let q = state.sb.from(table).select('*');
      orderCols.forEach((c) => { q = q.order(c, { ascending: true }); });
      const rows = must(await q.range(from, from + size - 1));
      out.push(...rows);
      if (rows.length < size) break;
    }
    return out;
  }
  async function loadData() {
    const [assets, holdings, prices, manual] = await Promise.all([
      fetchAll('assets', ['sort', 'name', 'id']),
      fetchAll('holdings', ['date', 'id']),
      fetchAll('prices', ['date', 'id']),
      fetchAll('manual_values', ['date', 'id']),
    ]);
    state.data = { assets, holdings, prices, manual };
    state.model = Calc.buildModel(state.data);
  }
  async function refresh() {
    await loadData();
    renderView();
    if (state.dlg && dlg.open) reopenDialog();
  }

  async function enterApp() {
    app.innerHTML = html`<header class="wrap top"><span class="brand">Patrimonio</span>
      <nav class="nav" aria-label="Secciones">${TABS.map(([id, label]) => html`<button type="button" data-action="tab" data-tab="${id}"${state.tab === id ? raw(' aria-current="page"') : ''}>${label}</button>`)}</nav></header>
      <main class="wrap view" id="view" tabindex="-1"><p class="muted">Cargando…</p></main>`.s;
    try { await loadData(); renderView(); }
    catch (e) { $('#view').innerHTML = html`<p class="msg err">No se han podido cargar los datos: ${e.message || e}. ¿Has ejecutado el archivo schema.sql en Supabase?</p>`.s; }
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.nav button').forEach((b) => {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    renderView();
    window.scrollTo(0, 0);
  }

  // ---------- vistas ----------
  function renderView() {
    const view = $('#view');
    if (!view || !state.model) return;
    document.querySelectorAll('.chart').forEach((c) => Charts.destroy(c));
    const fn = { resumen: renderResumen, inversiones: renderInversiones, cuentas: renderCuentas, actualizar: renderActualizar, ajustes: renderAjustes }[state.tab];
    view.innerHTML = fn().s;
    if (state.tab === 'resumen') drawMain();
  }

  const emptyState = (title, text, buttons) => html`<section class="empty"><h2>${title}</h2><p>${text}</p>
    <div class="actions">${(buttons || []).map(([tab, label], i) => html`<button class="btn${i ? ' ghost' : ''}" type="button" data-action="tab" data-tab="${tab}">${label}</button>`)}</div></section>`;

  function renderResumen() {
    const m = state.model, n = m.dates.length, today = Calc.todayStr();
    if (!state.data.assets.length) return emptyState('Todavía no hay productos', 'Añade tus cuentas, fondos y planes en Ajustes.', [['ajustes', 'Ir a Ajustes']]);
    const notes = Calc.alerts(m, today);
    const notesHtml = notes.length ? html`<section><h2>Avisos</h2><ul class="notes">${notes.map((a) => html`<li class="${a.level}"><button type="button" data-action="alert-go" data-tab="${a.tab}" data-asset="${a.asset || ''}">${a.text}</button></li>`)}</ul></section>` : '';
    if (n === 0) {
      return html`${emptyState('Aún no hay precios ni saldos', 'Los fondos y acciones se rellenan solos cuando se ejecuta «Actualizar precios» en GitHub; también puedes escribir un precio a mano en Inversiones. Los saldos de las cuentas se anotan en Actualizar.', [['inversiones', 'Ir a Inversiones'], ['actualizar', 'Ir a Actualizar']])}${notesHtml}`;
    }
    const net = m.net[n - 1];
    const debt = m.byCat.deuda[n - 1];
    const ch = Calc.change(m, 30);
    const delta = ch
      ? html`<span class="${ch.abs >= 0 ? 'pos' : 'neg'}">${Calc.fmtSigned(ch.abs)}${ch.pct != null ? html` (${Calc.fmtPct(ch.pct)})` : ''}</span> en 30 días`
      : html`<span class="muted">La variación a 30 días aparecerá cuando haya un mes de historial.</span>`;
    const cats = Calc.LIST_ORDER.map((c) => ({ c, v: m.byCat[c][n - 1] })).filter((x) => x.v > 0.005);
    const gross = cats.reduce((s, x) => s + x.v, 0);

    return html`
      <section class="hero">
        <div class="label">${debt > 0.005 ? 'Patrimonio neto' : 'Patrimonio'}</div>
        <div class="figure num">${Calc.fmtEUR(net)}</div>
        <div class="delta num">${delta}</div>
        <div class="foot">Datos a ${Calc.fmtDate(m.dates[n - 1])}. Las variaciones incluyen aportaciones y retiradas.</div>
        ${n >= 2 ? html`<div class="chart-wrap"><div id="chart-main" class="chart"></div></div>
          <div class="ranges" role="group" aria-label="Periodo del gráfico">
            ${[['3m', '3 meses'], ['1a', '1 año'], ['todo', 'Todo']].map(([k, l]) => html`<button type="button" data-action="range" data-range="${k}" aria-pressed="${state.range === k}">${l}</button>`)}
          </div>` : html`<p class="chart-empty">La gráfica de evolución aparece cuando hay datos de dos fechas distintas.</p>`}
      </section>
      <section><h2>Reparto</h2>
        <div class="share" role="img" aria-label="Reparto por categorías">${cats.map((x) => html`<span style="width:${(x.v / gross * 100).toFixed(2)}%;background:var(--c-${x.c})"></span>`)}</div>
        <ul class="rows closed">${cats.map((x) => html`<li><div class="row">
            <span class="title"><span class="sw" style="background:var(--c-${x.c})"></span><span class="name">${Calc.CATEGORIES[x.c].label}</span></span>
            <span class="val num">${Calc.fmtEUR(x.v)}</span>
            <span class="sub">${pctPlain.format(x.v / gross)} del total</span></div></li>`)}
          ${debt > 0.005 ? html`<li><div class="row"><span class="title"><span class="sw" style="background:var(--c-deuda)"></span><span class="name">Deudas</span></span><span class="val num">−${Calc.fmtEUR(debt)}</span></div></li>
          <li><div class="row total"><span class="title"><span class="name">Patrimonio neto</span></span><span class="val num">${Calc.fmtEUR(net)}</span></div></li>` : ''}
        </ul>
      </section>
      ${notesHtml}`;
  }

  function drawMain() {
    const host = $('#chart-main');
    if (!host) return;
    const m = state.model, n = m.dates.length;
    let i0 = 0;
    if (state.range !== 'todo') {
      const cut = Calc.addDays(m.dates[n - 1], state.range === '3m' ? -90 : -365);
      i0 = m.dates.findIndex((d) => d >= cut);
      if (i0 < 0 || n - i0 < 2) i0 = 0;
    }
    const dates = m.dates.slice(i0);
    const series = Calc.STACK_ORDER.map((c) => ({ key: c, label: Calc.CATEGORIES[c].label, color: `var(--c-${c})`, values: m.byCat[c].slice(i0) }))
      .filter((s) => s.values.some((v) => v > 0.005));
    const debt = m.byCat.deuda.slice(i0), gross = m.gross.slice(i0), net = m.net.slice(i0);
    const hasDebt = debt.some((v) => v > 0.005);
    Charts.draw(host, {
      dates, series, stacked: true, yMode: 'zero', fmt: Calc.fmtEUR,
      ariaLabel: `Evolución del patrimonio entre ${Calc.fmtDate(dates[0])} y ${Calc.fmtDate(dates[dates.length - 1])}. Patrimonio actual: ${Calc.fmtEUR(net[net.length - 1])}.`,
      showTotal: !hasDebt, totalLabel: 'Total',
      extraRows: hasDebt ? (i) => [{ label: 'Activos', value: gross[i] }, { label: 'Deudas', value: -debt[i], color: 'var(--c-deuda)' }, { label: 'Patrimonio neto', value: net[i], total: true }] : null,
    });
    if (!state.revealed) {
      host.classList.add('reveal');
      host.addEventListener('animationend', () => host.classList.remove('reveal'), { once: true });
      state.revealed = true;
    }
  }

  function renderInversiones() {
    const m = state.model, today = Calc.todayStr();
    const list = m.assets.filter((a) => a.active && a.valuation === 'units');
    if (!list.length) return emptyState('No hay fondos, acciones ni planes', 'Añádelos en Ajustes con su ISIN y sus participaciones.', [['ajustes', 'Ir a Ajustes']]);
    let total = 0, any = false;
    const groups = UNIT_CATS.map((c) => {
      const items = list.filter((a) => a.category === c);
      if (!items.length) return '';
      return html`<h2 class="group-title">${Calc.CATEGORIES[c].label}</h2><ul class="rows closed">${items.map((a) => {
        const info = Calc.latestInfo(a, m.idx, today);
        if (info.value != null) { total += info.value; any = true; }
        const pc = Calc.priceChange(a, m.idx, 30);
        const sub = info.missingPrice ? html`<span class="flag">Sin precio todavía</span>`
          : html`${[a.entity, `${Calc.fmtNum(info.units)} part. × ${Calc.fmtEUR(info.price, 2)}`].filter(Boolean).join(' · ')}`;
        const side = info.missingPrice ? '' : html`${pc != null ? html`<span class="${pc >= 0 ? 'pos' : 'neg'}">${Calc.fmtPct(pc)}</span> · ` : ''}${info.stale ? html`<span class="flag">precio del ${Calc.fmtDate(info.priceDate, false)}</span>` : `VL ${Calc.fmtDate(info.priceDate, false)}`}`;
        return html`<li><button type="button" class="row" data-action="open-asset" data-id="${a.id}">
          <span class="title"><span class="sw" style="background:var(--c-${a.category})"></span><span class="name">${a.name}</span></span>
          <span class="val num">${Calc.fmtEUR(info.value)}</span>
          <span class="sub">${sub}</span><span class="val2 num">${side}</span></button></li>`;
      })}</ul>`;
    });
    return html`<section><h2>Inversiones</h2>
      <p class="muted small">Toca un producto para ver su gráfica, corregir un precio o cambiar tus participaciones.</p>
      ${groups}
      ${any ? html`<ul class="rows closed" style="margin-top:22px"><li><div class="row total"><span class="title">Total inversiones</span><span class="val num">${Calc.fmtEUR(total)}</span></div></li></ul>` : ''}
    </section>`;
  }

  function renderCuentas() {
    const m = state.model, today = Calc.todayStr();
    const order = ['efectivo', 'inmobiliario', 'deuda'];
    const list = m.assets.filter((a) => a.active && a.valuation === 'manual');
    if (!list.length) return emptyState('No hay cuentas ni inmuebles', 'Añade tus cuentas bancarias, inmuebles y deudas en Ajustes.', [['ajustes', 'Ir a Ajustes']]);
    return html`<section><h2>Cuentas e inmuebles</h2>
      <p class="muted small">Estos valores los anotas tú. La pestaña Actualizar te deja ponerlos todos de una vez.</p>
      ${order.map((c) => {
        const items = list.filter((a) => a.category === c);
        if (!items.length) return '';
        return html`<h2 class="group-title">${Calc.CATEGORIES[c].label}</h2><ul class="rows closed">${items.map((a) => {
          const info = Calc.latestInfo(a, m.idx, today);
          const rows = m.idx.manual.get(a.id) || [];
          const prev = rows.length > 1 ? Number(rows[rows.length - 2].value) : null;
          const d = prev != null && info.total != null ? (info.total - prev) * info.share : null;
          return html`<li><button type="button" class="row" data-action="open-manual" data-id="${a.id}">
            <span class="title"><span class="sw" style="background:var(--c-${a.category})"></span><span class="name">${a.name}${info.share < 1 ? ' (' + Math.round(info.share * 100) + ' %)' : ''}</span></span>
            <span class="val num">${info.missingValue ? '—' : (c === 'deuda' ? '−' : '') + Calc.fmtEUR(info.value)}</span>
            <span class="sub">${info.missingValue ? html`<span class="flag">Sin valor todavía</span>` : info.stale ? html`<span class="flag">Sin actualizar desde el ${Calc.fmtDate(info.date)}</span>` : `Actualizado el ${Calc.fmtDate(info.date)}`}${a.loan ? ' · se calcula sola cada mes' : ''}</span>
            <span class="val2 num">${d != null && Math.abs(d) >= 0.005 ? html`<span class="${(c === 'deuda' ? -d : d) >= 0 ? 'pos' : 'neg'}">${Calc.fmtSigned(d)}</span> desde el anterior` : ''}</span></button></li>`;
        })}</ul>`;
      })}
    </section>`;
  }

  function renderActualizar() {
    const m = state.model, today = Calc.todayStr();
    const list = m.assets.filter((a) => a.active && a.valuation === 'manual');
    if (!list.length) return emptyState('No hay nada que actualizar', 'Añade tus cuentas bancarias, inmuebles y deudas en Ajustes.', [['ajustes', 'Ir a Ajustes']]);
    return html`<section><h2>Actualizar el mes</h2>
      <p class="muted">Anota el saldo de cada cuenta y, si ha cambiado, el valor de inmuebles y deudas. Lo que dejes en blanco no se toca.</p>
      <form data-form="update-month" novalidate>
        <label for="um-date">Fecha de los datos</label>
        <input id="um-date" name="date" type="date" value="${today}" required style="max-width:220px">
        <div style="margin-top:18px">${list.map((a) => {
          const info = Calc.latestInfo(a, m.idx, today);
          const last = info.missingValue ? 'sin valor todavía' : `último: ${Calc.fmtEUR(info.total, 2)} (${Calc.fmtDate(info.date, false)})`;
          const shareNote = info.share < 1 ? ` · escribe el total de la cuenta; contará tu ${Math.round(info.share * 100)} %` : '';
          return html`<div class="update-row"><label for="v-${a.id}">${a.name}<span class="hint">${Calc.CATEGORIES[a.category].label} · ${last}${a.category === 'deuda' ? ' · escribe la deuda pendiente en positivo' : ''}${shareNote}${a.loan ? ' · se calcula sola; anota aquí solo si quieres corregirla con el dato del banco' : ''}</span></label>
            <input id="v-${a.id}" name="v_${a.id}" inputmode="decimal" autocomplete="off" data-amount="2" placeholder="0,00"></div>`;
        })}</div>
        <div class="actions"><button class="btn" type="submit">Guardar</button></div>
      </form></section>
      <section><h2>Fondos, acciones y planes</h2>
        <p>Sus precios se actualizan solos desde GitHub. Si compras o vendes participaciones, cámbialas en Inversiones.</p>
        <div class="actions"><button class="btn ghost" type="button" data-action="tab" data-tab="inversiones">Ir a Inversiones</button></div></section>`;
  }

  function renderAjustes() {
    const m = state.model;
    const all = m.assets.slice().sort((a, b) => (b.active - a.active) || (a.sort - b.sort) || a.name.localeCompare(b.name, 'es'));
    return html`<section><div class="head-line"><h2>Productos</h2><button class="btn" type="button" data-action="new-asset">Añadir producto</button></div>
        ${all.length ? html`<ul class="rows closed">${all.map((a) => html`<li><button type="button" class="row${a.active ? '' : ' dim'}" data-action="edit-asset" data-id="${a.id}">
          <span class="title"><span class="sw" style="background:var(--c-${a.category})"></span><span class="name">${a.name}</span></span>
          <span class="val2">${a.active ? Calc.CATEGORIES[a.category].label : 'Dado de baja'}</span>
          <span class="sub">${[a.entity, a.isin].filter(Boolean).join(' · ')}</span></button></li>`)}</ul>` : html`<p class="muted">Todavía no hay productos.</p>`}
      </section>
      <section><h2>Copia de seguridad</h2>
        <p>Descarga todos tus datos en un archivo. Hazlo de vez en cuando para que no dependan solo de Supabase, y guárdalo en un sitio privado, nunca en GitHub.</p>
        <div class="actions"><button class="btn ghost" type="button" data-action="backup">Descargar copia</button></div></section>
      <section><h2>Sesión</h2>
        <p class="muted">Has entrado como ${(state.user && state.user.email) || 'tu usuario'}.</p>
        <div class="actions"><button class="btn ghost" type="button" data-action="logout">Cerrar sesión</button></div></section>`;
  }

  // ---------- diálogos ----------
  function showDialog(content, after) {
    dlg.innerHTML = content.s;
    if (!dlg.open) dlg.showModal();
    if (after) after();
  }
  function closeDialog() { if (dlg.open) dlg.close(); }
  dlg.addEventListener('close', () => {
    document.querySelectorAll('#dlg .chart').forEach((c) => Charts.destroy(c));
    state.dlg = null;
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); });
  function reopenDialog() {
    const d = state.dlg;
    if (!d) return;
    if (!state.model.assets.find((a) => a.id === d.id)) return closeDialog();
    ({ asset: openAsset, manual: openManual, edit: openEdit }[d.type])(d.id);
  }

  const dlgHeader = (title, subtitle) => html`<header><div><h3 id="dlg-title">${title}</h3>${subtitle ? html`<div class="muted small">${subtitle}</div>` : ''}</div>
    <button class="close" type="button" data-action="close" aria-label="Cerrar">×</button></header>`;

  function drawAssetChart(a, label) {
    const host = $('#dlg-chart');
    if (!host) return;
    const m = state.model;
    const vals = m.perAsset.get(a.id) || [];
    const start = vals.findIndex((v) => v != null);
    if (start < 0 || m.dates.length - start < 2) { host.outerHTML = '<p class="muted small">La gráfica aparece cuando hay datos de dos fechas.</p>'; return; }
    const dates = m.dates.slice(start), values = vals.slice(start);
    Charts.draw(host, { dates, series: [{ label, color: `var(--c-${a.category})`, values }], stacked: false, yMode: 'fit', fmt: Calc.fmtEUR,
      ariaLabel: `Evolución de ${a.name} entre ${Calc.fmtDate(dates[0])} y ${Calc.fmtDate(dates[dates.length - 1])}.` });
  }

  function openAsset(id) {
    const m = state.model, a = m.assets.find((x) => x.id === id);
    if (!a) return;
    state.dlg = { type: 'asset', id };
    const today = Calc.todayStr(), info = Calc.latestInfo(a, m.idx, today);
    const holdings = (m.idx.holdings.get(id) || []).slice().reverse().slice(0, 10);
    const prices = (m.idx.prices.get(id) || []).slice().reverse().slice(0, 8);
    showDialog(html`<div class="dlg">${dlgHeader(a.name, [a.entity, a.isin].filter(Boolean).join(' · '))}
      <dl class="facts">
        <div><dt>Valor</dt><dd class="num">${Calc.fmtEUR(info.value)}</dd></div>
        <div><dt>Participaciones</dt><dd class="num">${Calc.fmtNum(info.units)}</dd></div>
        <div><dt>Precio</dt><dd class="num">${info.price != null ? Calc.fmtEUR(info.price, 2) : '—'}</dd></div>
        <div><dt>Fecha del precio</dt><dd class="num">${info.priceDate ? Calc.fmtDate(info.priceDate) : '—'}${info.stale ? html` <span class="flag small">antiguo</span>` : ''}</dd></div>
      </dl>
      ${info.source ? html`<p class="muted small">Fuente del último precio: ${info.source === 'manual' ? 'escrito a mano' : info.source}.</p>` : ''}
      <div class="chart-wrap"><div id="dlg-chart" class="chart"></div></div>

      <h4>Escribir un precio a mano</h4>
      <p class="muted small">Útil para planes sin fuente automática o para corregir un dato. Si hay uno manual hoy, el flujo de GitHub no lo pisa.</p>
      <form data-form="set-price" data-id="${id}" novalidate><div class="grid2">
        <div><label for="sp-d">Fecha</label><input id="sp-d" name="date" type="date" value="${today}" required></div>
        <div><label for="sp-p">Precio (€)</label><input id="sp-p" name="price" inputmode="decimal" data-amount="4" required></div></div>
        <div class="actions"><button class="btn" type="submit">Guardar precio</button></div></form>

      <h4>Cambiar mis participaciones</h4>
      <p class="muted small">Tras una compra, venta o traspaso, escribe cuántas tienes ahora y desde qué día.</p>
      <form data-form="set-units" data-id="${id}" novalidate><div class="grid2">
        <div><label for="su-d">Desde</label><input id="su-d" name="date" type="date" value="${today}" required></div>
        <div><label for="su-u">Participaciones</label><input id="su-u" name="units" inputmode="decimal" data-amount="4" required></div></div>
        <div class="actions"><button class="btn" type="submit">Guardar participaciones</button></div></form>

      <h4>Historial de participaciones</h4>
      <ul class="hist">${holdings.map((h) => html`<li><span class="num">${Calc.fmtDate(h.date)} · ${Calc.fmtNum(h.units)}</span><button class="x" type="button" data-action="del-row" data-table="holdings" data-id="${h.id}">Borrar</button></li>`)}</ul>
      <h4>Últimos precios</h4>
      ${prices.length ? html`<ul class="hist">${prices.map((p) => html`<li><span class="num">${Calc.fmtDate(p.date)} · ${Calc.fmtEUR(p.price, 2)}<span class="muted"> · ${p.source || '—'}${p.nav_date && p.nav_date !== p.date ? ` · VL ${Calc.fmtDate(p.nav_date, false)}` : ''}</span></span><button class="x" type="button" data-action="del-row" data-table="prices" data-id="${p.id}">Borrar</button></li>`)}</ul>` : html`<p class="muted small">Todavía no hay precios.</p>`}
      <div class="actions"><button class="btn ghost" type="button" data-action="edit-asset" data-id="${id}">Editar producto</button></div>
    </div>`, () => drawAssetChart(a, 'Valor'));
  }

  function openManual(id) {
    const m = state.model, a = m.assets.find((x) => x.id === id);
    if (!a) return;
    state.dlg = { type: 'manual', id };
    const today = Calc.todayStr(), info = Calc.latestInfo(a, m.idx, today);
    const rows = (m.idx.manual.get(id) || []).slice().reverse().slice(0, 12);
    showDialog(html`<div class="dlg">${dlgHeader(a.name, [Calc.CATEGORIES[a.category].label, a.entity].filter(Boolean).join(' · '))}
      <dl class="facts"><div><dt>${info.share < 1 ? 'Tu parte (' + Math.round(info.share * 100) + ' %)' : 'Valor actual'}</dt><dd class="num">${info.missingValue ? '—' : Calc.fmtEUR(info.value, 2)}</dd></div>
        ${info.share < 1 ? html`<div><dt>Total de la cuenta</dt><dd class="num">${info.missingValue ? '—' : Calc.fmtEUR(info.total, 2)}</dd></div>` : ''}
        <div><dt>Anotado el</dt><dd class="num">${info.date ? Calc.fmtDate(info.date) : '—'}</dd></div></dl>
      <div class="chart-wrap"><div id="dlg-chart" class="chart"></div></div>
      <h4>Anotar un valor</h4>
      <form data-form="set-manual" data-id="${id}" novalidate><div class="grid2">
        <div><label for="sm-d">Fecha</label><input id="sm-d" name="date" type="date" value="${today}" required></div>
        <div><label for="sm-v">Valor (€)</label><input id="sm-v" name="value" inputmode="decimal" data-amount="2" required></div></div>
        <div class="actions"><button class="btn" type="submit">Guardar valor</button></div></form>
      <h4>Historial</h4>
      ${rows.length ? html`<ul class="hist">${rows.map((r) => html`<li><span class="num">${Calc.fmtDate(r.date)} · ${Calc.fmtEUR(r.value, 2)}</span><button class="x" type="button" data-action="del-row" data-table="manual_values" data-id="${r.id}">Borrar</button></li>`)}</ul>` : html`<p class="muted small">Todavía no hay valores.</p>`}
      <div class="actions"><button class="btn ghost" type="button" data-action="edit-asset" data-id="${id}">Editar producto</button></div>
    </div>`, () => drawAssetChart(a, a.category === 'deuda' ? 'Deuda' : 'Valor'));
  }

  const EXAMPLE_SOURCES = '[{"type":"yahoo","isin":"IE00BFPM9N11"},\n {"type":"ft","id":"IE00BFPM9N11:EUR"}]';

  function openEdit(id) {
    const m = state.model, a = id ? m.assets.find((x) => x.id === id) : null;
    state.dlg = id ? { type: 'edit', id } : null;
    const cat = a ? a.category : 'fondo';
    const isUnits = UNIT_CATS.includes(cat);
    showDialog(html`<div class="dlg">${dlgHeader(a ? 'Editar producto' : 'Añadir producto')}
      <form data-form="save-asset" data-id="${a ? a.id : ''}" novalidate>
        <label for="ea-n">Nombre</label><input id="ea-n" name="name" required value="${a ? a.name : ''}">
        <label for="ea-e">Entidad (banco, gestora, bróker)</label><input id="ea-e" name="entity" value="${a ? a.entity || '' : ''}">
        <label for="ea-c">Tipo</label>
        <select id="ea-c" name="category" data-change="category">${CAT_OPTIONS.map(([v, l]) => html`<option value="${v}"${v === cat ? raw(' selected') : ''}>${l}</option>`)}</select>
        <div data-units-only${isUnits ? '' : raw(' hidden')}>
          <label for="ea-i">ISIN o código DGS (opcional)</label><input id="ea-i" name="isin" value="${a ? a.isin || '' : ''}" autocapitalize="characters" spellcheck="false">
          <label for="ea-s">Fuentes del precio</label>
          <textarea id="ea-s" name="sources" spellcheck="false" placeholder='${EXAMPLE_SOURCES}'>${a && a.sources && a.sources.length ? JSON.stringify(a.sources, null, 1) : ''}</textarea>
          <p class="field-hint">Lista en formato JSON, de la preferida a la de reserva. Tipos: yahoo, ft, quefondos, finect, url_regex. Déjalo vacío si pondrás el precio a mano.</p>
        </div>
        <div data-units-only${isUnits ? '' : raw(' hidden')}>
          <h4>Aportación mensual automática (opcional)</h4>
          <p class="field-hint">Si suscribes un importe fijo cada mes, la web suma sola las participaciones comprando a ese precio, sin que las anotes a mano. Déjalo vacío si no aportas de forma periódica.</p>
          <div class="grid2">
            <div><label for="ea-pa">Importe mensual (€)</label><input id="ea-pa" name="plan_amount" inputmode="decimal" data-amount="2" value="${a && a.plan && a.plan.amount != null ? Calc.fmtNum(Number(a.plan.amount), 2) : ''}"></div>
            <div><label for="ea-pd">Día del mes</label><input id="ea-pd" name="plan_day" inputmode="numeric" value="${a && a.plan && a.plan.day ? a.plan.day : ''}"></div></div>
        </div>
        <div data-loan-only${cat === 'deuda' ? '' : raw(' hidden')}>
          <h4>Amortización automática (opcional)</h4>
          <p class="field-hint">Si pagas una cuota fija cada mes, la web calcula sola cómo baja el capital pendiente, sin que lo anotes a mano. Anota una vez el capital pendiente que te da el banco (en Actualizar) y rellena esto. Cuando el banco te dé un dato nuevo, anótalo y se recalcula desde ahí. Déjalo vacío si no quieres automatizarla.</p>
          <div class="grid2">
            <div><label for="ea-lp">Cuota mensual (€)</label><input id="ea-lp" name="loan_payment" inputmode="decimal" data-amount="2" value="${a && a.loan && a.loan.payment != null ? Calc.fmtNum(Number(a.loan.payment), 2) : ''}"></div>
            <div><label for="ea-lr">Tipo de interés anual (%)</label><input id="ea-lr" name="loan_rate" inputmode="decimal" value="${a && a.loan && a.loan.rate != null ? String(a.loan.rate).replace('.', ',') : ''}"></div></div>
          <label for="ea-ld">Día del mes en que se cobra</label><input id="ea-ld" name="loan_day" inputmode="numeric" value="${a && a.loan && a.loan.day ? a.loan.day : ''}" style="max-width:140px">
        </div>
        <label for="ea-p">Mi parte (%)</label><input id="ea-p" name="share" inputmode="decimal" value="${a ? String(Math.round((Number(a.share) > 0 ? Number(a.share) : 1) * 10000) / 100).replace('.', ',') : '100'}" style="max-width:140px">
        <p class="field-hint">100 si es solo tuyo. Si compartes la cuenta o el inmueble, pon tu porcentaje (por ejemplo 50) y escribe siempre el total: la web aplicará tu parte.</p>
        <label for="ea-o">Orden en las listas</label><input id="ea-o" name="sort" inputmode="numeric" value="${a ? a.sort : 100}" style="max-width:140px">
        ${a ? '' : html`<div data-units-only${isUnits ? '' : raw(' hidden')}><div class="grid2">
            <div><label for="ea-u">Participaciones iniciales</label><input id="ea-u" name="units" inputmode="decimal" data-amount="4"></div>
            <div><label for="ea-ud">Desde</label><input id="ea-ud" name="units_date" type="date" value="${Calc.todayStr()}"></div></div></div>
          <div data-manual-only${isUnits ? raw(' hidden') : ''}><div class="grid2">
            <div><label for="ea-v">Valor inicial (€)</label><input id="ea-v" name="value" inputmode="decimal" data-amount="2"></div>
            <div><label for="ea-vd">Fecha</label><input id="ea-vd" name="value_date" type="date" value="${Calc.todayStr()}"></div></div></div>`}
        <div class="actions"><button class="btn" type="submit">Guardar</button>
          ${a ? (a.active ? html`<button class="btn danger" type="button" data-action="retire-asset" data-id="${a.id}">Dar de baja</button>` : html`<button class="btn ghost" type="button" data-action="reactivate-asset" data-id="${a.id}">Reactivar</button>`) : ''}
        </div>
      </form></div>`);
  }

  // ---------- acciones ----------
  const num = (v) => Calc.parseAmount(v);
  const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

  async function saveAsset(form, btn) {
    const fd = new FormData(form), id = form.dataset.id;
    const name = (fd.get('name') || '').trim();
    if (!name) return toast('Escribe un nombre.', true);
    const category = fd.get('category'), valuation = UNIT_CATS.includes(category) ? 'units' : 'manual';
    let sources = [];
    const rawSources = (fd.get('sources') || '').trim();
    if (valuation === 'units' && rawSources) {
      try { sources = JSON.parse(rawSources); } catch (e) { return toast('Las fuentes no son un JSON válido: ' + e.message, true); }
      if (!Array.isArray(sources) || sources.some((s) => !s || typeof s !== 'object' || !SOURCE_TYPES.includes(s.type))) {
        return toast('Las fuentes deben ser una lista de objetos con "type": ' + SOURCE_TYPES.join(', ') + '.', true);
      }
    }
    const sort = parseInt(fd.get('sort'), 10);
    const pct = num(fd.get('share') || '100');
    if (pct == null || !(pct > 0 && pct <= 100)) return toast('Tu parte debe estar entre 1 y 100 %.', true);
    let loan = null;
    if (category === 'deuda' && ((fd.get('loan_payment') || '').trim() || (fd.get('loan_day') || '').trim())) {
      const payment = num(fd.get('loan_payment')), rate = num(fd.get('loan_rate') || '0'), day = parseInt(fd.get('loan_day'), 10);
      if (payment == null || !(payment > 0)) return toast('Escribe la cuota mensual del préstamo.', true);
      if (rate == null || rate < 0 || rate > 30) return toast('El tipo de interés debe estar entre 0 y 30 %.', true);
      if (!(day >= 1 && day <= 31)) return toast('El día de cobro debe estar entre 1 y 31.', true);
      loan = { payment, rate, day };
    }
    let plan = null;
    if (valuation === 'units' && ((fd.get('plan_amount') || '').trim() || (fd.get('plan_day') || '').trim())) {
      const amount = num(fd.get('plan_amount')), day = parseInt(fd.get('plan_day'), 10);
      if (amount == null || !(amount > 0)) return toast('Escribe el importe de la aportación mensual.', true);
      if (!(day >= 1 && day <= 31)) return toast('El día de la aportación debe estar entre 1 y 31.', true);
      plan = { amount, day };
    }
    const row = { name, share: Math.round(pct * 100) / 10000, loan, plan, entity: (fd.get('entity') || '').trim() || null, category, valuation,
      isin: valuation === 'units' ? ((fd.get('isin') || '').trim().toUpperCase() || null) : null,
      sources, sort: Number.isFinite(sort) ? sort : 100 };
    await run(btn, async () => {
      if (id) must(await state.sb.from('assets').update(row).eq('id', id));
      else {
        const created = must(await state.sb.from('assets').insert(row).select().single());
        if (valuation === 'units' && (fd.get('units') || '').trim()) {
          const u = num(fd.get('units')); if (u == null || u < 0) throw new Error('Participaciones no válidas.');
          must(await state.sb.from('holdings').insert({ asset_id: created.id, date: fd.get('units_date') || Calc.todayStr(), units: u }));
        }
        if (valuation === 'manual' && (fd.get('value') || '').trim()) {
          const v = num(fd.get('value')); if (v == null) throw new Error('Valor no válido.');
          must(await state.sb.from('manual_values').insert({ asset_id: created.id, date: fd.get('value_date') || Calc.todayStr(), value: v, auto: false }));
        }
      }
      closeDialog();
      await refresh();
    }, id ? 'Producto actualizado' : 'Producto añadido');
  }

  const handlers = {
    tab: (t) => { closeDialog(); setTab(t.dataset.tab); },
    close: () => closeDialog(),
    range: (t) => { state.range = t.dataset.range; document.querySelectorAll('.ranges button').forEach((b) => b.setAttribute('aria-pressed', String(b === t))); drawMain(); },
    'alert-go': (t) => { setTab(t.dataset.tab); if (t.dataset.asset) openAsset(t.dataset.asset); },
    'open-asset': (t) => openAsset(t.dataset.id),
    'open-manual': (t) => openManual(t.dataset.id),
    'new-asset': () => openEdit(null),
    'edit-asset': (t) => openEdit(t.dataset.id),
    'login-back': () => showLogin('email'),
    logout: () => { state.sb.auth.signOut(); },
    backup: () => {
      const d = state.data;
      const payload = { exportado: new Date().toISOString(), version: 1, assets: d.assets, holdings: d.holdings, prices: d.prices, manual_values: d.manual };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' }));
      a.download = `patrimonio-copia-${Calc.todayStr()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast('Copia descargada');
    },
    'del-row': (t) => {
      if (!window.confirm('¿Borrar este dato? No se puede deshacer.')) return;
      run(t, async () => { must(await state.sb.from(t.dataset.table).delete().eq('id', t.dataset.id)); await refresh(); }, 'Borrado');
    },
    'retire-asset': (t) => {
      const a = state.model.assets.find((x) => x.id === t.dataset.id);
      if (!window.confirm(`¿Dar de baja «${a.name}»? Su valor pasará a 0 desde hoy y dejará de aparecer en las listas. El histórico se conserva.`)) return;
      run(t, async () => {
        const today = Calc.todayStr();
        if (a.valuation === 'units') must(await state.sb.from('holdings').upsert({ asset_id: a.id, date: today, units: 0 }, { onConflict: 'asset_id,date' }));
        else must(await state.sb.from('manual_values').upsert({ asset_id: a.id, date: today, value: 0, auto: false }, { onConflict: 'asset_id,date' }));
        must(await state.sb.from('assets').update({ active: false }).eq('id', a.id));
        closeDialog(); await refresh();
      }, 'Producto dado de baja');
    },
    'reactivate-asset': (t) => run(t, async () => {
      must(await state.sb.from('assets').update({ active: true }).eq('id', t.dataset.id));
      closeDialog(); await refresh();
    }, 'Producto reactivado. Anota de nuevo su valor o sus participaciones.'),
  };

  const forms = {
    'login-email': async (form, btn) => {
      const email = (new FormData(form).get('email') || '').trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return showLogin('email', email, 'Escribe un correo válido.', true);
      btn.disabled = true;
      const { error } = await state.sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
      if (error) showLogin('email', email, loginMessage(error), true);
      else showLogin('code', email, 'Te hemos enviado un correo. Pulsa el enlace que trae (en este mismo dispositivo) o, si trae un código, escríbelo aquí. Puede tardar un minuto.');
    },
    'login-code': async (form, btn) => {
      const fd = new FormData(form), email = fd.get('email'), token = (fd.get('code') || '').replace(/\s/g, '');
      if (!token) return showLogin('code', email, 'Escribe el código del correo.', true);
      btn.disabled = true;
      const { data, error } = await state.sb.auth.verifyOtp({ email, token, type: 'email' });
      if (error) return showLogin('code', email, 'El código no es correcto o ha caducado. Pide uno nuevo con «Usar otro correo».', true);
      state.user = (data && (data.user || (data.session && data.session.user))) || null;
      await enterApp();
    },
    'update-month': (form, btn) => {
      const fd = new FormData(form), date = fd.get('date');
      if (!validDate(date)) return toast('Elige una fecha.', true);
      const rows = [];
      for (const a of state.model.assets.filter((x) => x.active && x.valuation === 'manual')) {
        const rawV = (fd.get('v_' + a.id) || '').trim();
        if (!rawV) continue;
        const v = num(rawV);
        if (v == null) return toast(`«${a.name}»: no entiendo el importe «${rawV}».`, true);
        rows.push({ asset_id: a.id, date, value: v, auto: false });
      }
      if (!rows.length) return toast('No has escrito ningún importe.', true);
      return run(btn, async () => {
        must(await state.sb.from('manual_values').upsert(rows, { onConflict: 'asset_id,date' }));
        await loadData(); setTab('resumen');
      }, `Guardado: ${rows.length} ${rows.length === 1 ? 'valor' : 'valores'}`);
    },
    'set-price': (form, btn) => {
      const fd = new FormData(form), date = fd.get('date'), price = num(fd.get('price'));
      if (!validDate(date)) return toast('Elige una fecha.', true);
      if (price == null || price <= 0) return toast('Escribe un precio mayor que 0.', true);
      return run(btn, async () => {
        must(await state.sb.from('prices').upsert({ asset_id: form.dataset.id, date, nav_date: date, price, source: 'manual' }, { onConflict: 'asset_id,date' }));
        await refresh();
      }, 'Precio guardado');
    },
    'set-units': (form, btn) => {
      const fd = new FormData(form), date = fd.get('date'), units = num(fd.get('units'));
      if (!validDate(date)) return toast('Elige una fecha.', true);
      if (units == null || units < 0) return toast('Escribe un número de participaciones (0 o más).', true);
      return run(btn, async () => {
        must(await state.sb.from('holdings').upsert({ asset_id: form.dataset.id, date, units }, { onConflict: 'asset_id,date' }));
        await refresh();
      }, 'Participaciones guardadas');
    },
    'set-manual': (form, btn) => {
      const fd = new FormData(form), date = fd.get('date'), value = num(fd.get('value'));
      if (!validDate(date)) return toast('Elige una fecha.', true);
      if (value == null) return toast('Escribe un importe.', true);
      return run(btn, async () => {
        must(await state.sb.from('manual_values').upsert({ asset_id: form.dataset.id, date, value, auto: false }, { onConflict: 'asset_id,date' }));
        await refresh();
      }, 'Valor guardado');
    },
    'save-asset': (form, btn) => saveAsset(form, btn),
  };

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || !handlers[t.dataset.action]) return;
    e.preventDefault();
    handlers[t.dataset.action](t, e);
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-form]');
    if (!f || !forms[f.dataset.form]) return;
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    Promise.resolve(forms[f.dataset.form](f, btn)).catch(handleError);
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches && t.matches('input[data-amount]')) {
      const v = num(t.value);
      if (v != null) t.value = Calc.fmtNum(v, parseInt(t.dataset.amount, 10) || 2);
    }
    if (t.matches && t.matches('select[data-change="category"]')) {
      const isUnits = UNIT_CATS.includes(t.value), f = t.closest('form');
      f.querySelectorAll('[data-units-only]').forEach((x) => { x.hidden = !isUnits; });
      f.querySelectorAll('[data-manual-only]').forEach((x) => { x.hidden = isUnits; });
      f.querySelectorAll('[data-loan-only]').forEach((x) => { x.hidden = t.value !== 'deuda'; });
    }
  });

  boot().catch((e) => {
    app.innerHTML = html`<div class="setup"><h1>Patrimonio</h1><p class="msg err">Error al iniciar: ${e.message || e}</p></div>`.s;
  });
})();
