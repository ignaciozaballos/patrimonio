/* Patrimonio · interfaz. Todo lo que se escribe pasa por Supabase (con tu sesión); nada se guarda en el navegador salvo la sesión. */
(function () {
  'use strict';
  const Calc = window.Calc, Charts = window.Charts, A = window.Analytics;
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
  const TABS = [['resumen', 'Resumen'], ['inversiones', 'Inversiones'], ['cuentas', 'Cuentas'], ['futuro', 'Futuro'], ['actualizar', 'Actualizar'], ['ajustes', 'Ajustes']];
  const CAT_OPTIONS = [['efectivo', 'Efectivo (cuenta bancaria)'], ['fondo', 'Fondo de inversión'], ['accion', 'Acción'],
    ['plan_pensiones', 'Plan de pensiones'], ['inmobiliario', 'Inmobiliario'], ['deuda', 'Deuda (hipoteca, préstamo)']];
  const UNIT_CATS = ['fondo', 'accion', 'plan_pensiones'];
  const SOURCE_TYPES = ['yahoo', 'ft', 'quefondos', 'finect', 'url_regex'];

  const store = {
    get(k) { try { return localStorage.getItem('patrimonio.' + k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem('patrimonio.' + k); else localStorage.setItem('patrimonio.' + k, String(v)); } catch (e) { /* sin almacenamiento */ } },
  };
  const state = { sb: null, user: null, data: null, model: null, tab: 'resumen', range: '1a', revealed: false, dlg: null,
    hide: store.get('hide') === '1', hiddenCats: new Set(), notesOpen: store.get('notes') !== '0', donut: 'cat', invSort: { key: 'value', dir: -1 },
    goal: Number(store.get('goal')) > 0 ? Number(store.get('goal')) : null, proj: { years: 10, ret: 5, re: 2 } };

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
    document.body.classList.toggle('hide-amounts', state.hide);
    app.innerHTML = html`
      <div class="brand-strip"><div class="inner"><span>Panel personal</span>
        <span><span id="dataAsOf">Datos a: –</span> &nbsp;<button id="privBtn" type="button" data-action="privacy" aria-pressed="${state.hide}">Ocultar importes</button></span></div></div>
      <header class="top">
        <div class="title-block">
          <svg class="logo" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="10" fill="#0a2463"/><rect x="8" y="22" width="6" height="10" rx="1.5" fill="#62b8ff"/><rect x="17" y="15" width="6" height="17" rx="1.5" fill="#4a7dff"/><rect x="26" y="8" width="6" height="24" rx="1.5" fill="#fff"/></svg>
          <div class="title-text"><h1>PATRIMONIO</h1><p>${(state.user && state.user.email) || 'Cuentas, inversiones e inmuebles'}</p></div>
        </div>
        <div class="top-meta">
          <div class="meta-item"><div class="v num" id="metaNet">–</div><div class="l">patrimonio neto</div></div>
          <div class="meta-item"><div class="v num" id="metaCount">–</div><div class="l">productos</div></div>
          <div class="meta-item"><div class="v num" id="metaContrib">–</div><div class="l">aportación mensual</div></div>
        </div>
      </header>
      <nav class="tabs" aria-label="Secciones"><div class="tabs-inner">${TABS.map(([id, label]) => html`<button type="button" class="tab" data-action="tab" data-tab="${id}"${state.tab === id ? raw(' aria-current="page"') : ''}>${label}</button>`)}</div></nav>
      <main class="shell view" id="view" tabindex="-1"><p class="muted">Cargando…</p></main>
      <footer class="foot">Valores estimados a partir de los precios publicados; no son asesoramiento financiero.</footer>`.s;
    try { await loadData(); renderView(); }
    catch (e) { $('#view').innerHTML = html`<p class="msg err">No se han podido cargar los datos: ${e.message || e}. ¿Has ejecutado el archivo schema.sql en Supabase?</p>`.s; }
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    renderView();
    window.scrollTo(0, 0);
  }

  function updateHeader() {
    const m = state.model, n = m.dates.length;
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('#metaNet', n ? Calc.fmtEUR(m.net[n - 1]) : '–');
    set('#metaCount', String(m.assets.filter((a) => a.active).length));
    const c = A.monthlyContributions(m);
    set('#metaContrib', c > 0 ? Calc.fmtEUR(c) : '–');
    set('#dataAsOf', n ? 'Datos a: ' + Calc.fmtDate(m.dates[n - 1]) : 'Datos a: –');
  }

  // ---------- vistas ----------
  function renderView() {
    const view = $('#view');
    if (!view || !state.model) return;
    document.querySelectorAll('.chart').forEach((c) => Charts.destroy(c));
    updateHeader();
    const fn = { resumen: renderResumen, inversiones: renderInversiones, cuentas: renderCuentas, futuro: renderFuturo, actualizar: renderActualizar, ajustes: renderAjustes }[state.tab];
    view.innerHTML = fn().s;
    if (state.tab === 'resumen') { drawMain(); drawDonut(); drawMonthly(); }
    if (state.tab === 'inversiones') drawInvest();
    if (state.tab === 'futuro') drawProjection();
  }

  const emptyState = (title, text, buttons) => html`<section class="panel empty"><h2>${title}</h2><p>${text}</p>
    <div class="actions">${(buttons || []).map(([tab, label], i) => html`<button class="btn${i ? ' ghost' : ''}" type="button" data-action="tab" data-tab="${tab}">${label}</button>`)}</div></section>`;

  const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const monthLabel = (k) => MES[Number(k.slice(5)) - 1] + (k.slice(5) === '01' ? ' ' + k.slice(2, 4) : '');
  const ENTITY_COLORS = ['#2563eb', '#f59e0b', '#14b8a6', '#8b5cf6', '#ec4899', '#64748b', '#84cc16', '#06b6d4'];
  const RANGES = [['1m', '1M'], ['3m', '3M'], ['6m', '6M'], ['ytd', 'Año'], ['1a', '1A'], ['todo', 'Todo']];

  const rangeSeg = () => html`<div class="seg" role="group" aria-label="Periodo del gráfico">${RANGES.map(([k, l]) => html`<button type="button" data-action="range" data-range="${k}" aria-pressed="${state.range === k}">${l}</button>`)}</div>`;
  function cutIndex(dates) {
    const n = dates.length;
    if (state.range === 'todo' || !n) return 0;
    const last = dates[n - 1];
    const cut = state.range === 'ytd' ? last.slice(0, 4) + '-01-01'
      : Calc.addDays(last, { '1m': -31, '3m': -92, '6m': -183, '1a': -365 }[state.range]);
    const i = dates.findIndex((d) => d >= cut);
    return i < 0 || n - i < 2 ? 0 : i;
  }
  const changeClass = (v) => (v >= 0 ? 'pos' : 'neg');

  function renderResumen() {
    const m = state.model, n = m.dates.length, today = Calc.todayStr();
    if (!state.data.assets.length) return emptyState('Todavía no hay productos', 'Añade tus cuentas, fondos y planes en Ajustes.', [['ajustes', 'Ir a Ajustes']]);
    const notes = Calc.alerts(m, today);
    if (n === 0) {
      return html`${emptyState('Aún no hay precios ni saldos', 'Los fondos y acciones se rellenan solos cuando se ejecuta «Actualizar precios» en GitHub; también puedes escribir un precio a mano en Inversiones. Los saldos de las cuentas se anotan en Actualizar.', [['inversiones', 'Ir a Inversiones'], ['actualizar', 'Ir a Actualizar']])}`;
    }
    const net = m.net[n - 1], debt = m.byCat.deuda[n - 1], gross = m.gross[n - 1];
    const ch = Calc.change(m, 30), yt = A.ytd(m, today), ret = A.returns(m, today), conc = A.concentration(m, today);
    const loans = A.loans(m, today), quotas = loans.reduce((s, l) => s + l.payment * l.share, 0);
    const kd30 = ch ? html`<span class="${changeClass(ch.abs)}">${Calc.fmtSigned(ch.abs)}${ch.pct != null ? html` (${Calc.fmtPct(ch.pct)})` : ''}</span> en 30 días` : 'Variación a 30 días cuando haya un mes de historial';
    const notesHtml = notes.length ? html`<details class="panel notes-panel" id="notes-panel"${state.notesOpen ? raw(' open') : ''}><summary class="panel-head"><div><h2>Avisos <span class="count">${notes.length}</span></h2><div class="sub">Datos que conviene revisar</div></div><span class="chev" aria-hidden="true"></span></summary>
      <ul class="notes">${notes.map((a) => html`<li class="${a.level}"><button type="button" data-action="alert-go" data-tab="${a.tab}" data-asset="${a.asset || ''}">${a.text}</button></li>`)}</ul></details>` : '';

    const goal = state.goal, eta = goal ? A.goalETA(m, goal) : null;
    const goalHtml = goal ? html`<div class="goal-line"><b class="num">${Calc.fmtEUR(net)}</b><span class="muted">de ${Calc.fmtEUR(goal)}</span></div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.max(0, Math.min(1, net / goal)) * 100)}"><i style="width:${(Math.max(0, Math.min(1, net / goal)) * 100).toFixed(1)}%"></i></div>
        <p class="small muted" style="margin-top:10px">${net >= goal ? '¡Objetivo conseguido!' : html`Te faltan <b class="num">${Calc.fmtEUR(goal - net)}</b>${eta ? html`. Al ritmo de los últimos 90 días (<span class="num">${Calc.fmtSigned(eta.perMonth)}</span> al mes) llegarías en torno a <b>${Calc.fmtDate(eta.date).replace(/^\d+ /, '')}</b>.` : '. Aún no hay ritmo positivo con el que estimar la fecha.'}`}</p>
        <div class="actions"><button class="btn ghost sm" type="button" data-action="goal-edit">Cambiar objetivo</button><button class="btn link" type="button" data-action="goal-clear">Quitar</button></div>`
      : html`<p class="muted">Fija una cifra de patrimonio neto y verás cuánto te falta y cuándo llegarías.</p>
        <form data-form="set-goal" novalidate class="grid2" style="align-items:end"><div><label for="goal-v">Objetivo (€)</label><input id="goal-v" name="goal" inputmode="decimal" data-amount="0" placeholder="100.000"></div>
        <div><button class="btn" type="submit">Guardar objetivo</button></div></form>`;

    const up = A.upcoming(m, today, 45);
    const upHtml = up.length ? html`${up.slice(0, 7).map((e) => html`<div class="event"><div class="d"><b>${Number(e.date.slice(8))}</b><span>${MES[Number(e.date.slice(5, 7)) - 1]}</span></div>
        <div class="t">${e.label}<small>${e.kind === 'cuota' ? 'Cuota de la deuda (tu parte)' : 'Aportación automática'}</small></div><div class="a num">${e.kind === 'cuota' ? '−' : ''}${Calc.fmtEUR(e.amount, 2)}</div></div>`)}`
      : html`<p class="empty-line muted" style="padding:6px 18px 16px">Sin cuotas ni aportaciones previstas en los próximos 45 días. Configúralas en Ajustes (aportación mensual o amortización).</p>`;

    const mv = A.movers(m, 30);
    const mvHtml = mv.length ? html`<ul class="rows">${mv.map((x) => html`<li><button type="button" class="row" data-action="open-asset" data-id="${x.asset.id}"><span class="title"><span class="sw" style="background:var(--c-${x.asset.category})"></span><span class="name">${x.asset.name}</span></span>
        <span class="val num ${changeClass(x.pct)}">${Calc.fmtPct(x.pct)}</span></button></li>`)}</ul>` : html`<p class="muted" style="padding:6px 18px 16px">Aparecerá cuando haya un mes de precios.</p>`;

    const health = conc ? html`<div class="mini-metrics">
        <div class="mini"><div class="v num">${pctPlain.format(conc.topPct)}</div><div class="l">en tu mayor posición<br>${conc.top.asset.name}</div></div>
        <div class="mini"><div class="v num">${pctPlain.format(conc.top3Pct)}</div><div class="l">en tus 3 mayores posiciones</div></div>
        <div class="mini"><div class="v num">${pctPlain.format(conc.liquidPct)}</div><div class="l">líquido (efectivo, fondos y acciones)</div></div>
        <div class="mini"><div class="v num">${pctPlain.format(conc.debtPct)}</div><div class="l">deudas sobre tus activos</div></div></div>` : '';

    return html`
      <section class="panel"><div class="panel-head"><div><h2>Evolución del patrimonio</h2><div class="sub">Pulsa un tipo de la leyenda para quitarlo o ponerlo y ver la evolución conjunta de los demás</div></div>${rangeSeg()}</div>
        ${n >= 2 ? html`<div class="chart-wrap"><div id="chart-main" class="chart"></div></div>
          <div class="chart-foot"><div class="legend legend-buttons" id="legend-main"></div></div>` : html`<p class="chart-empty">La gráfica aparece cuando hay datos de dos fechas distintas.</p>`}
        <div class="panel-sep"><h3>Mes a mes</h3><p class="sub">Cuánto ha cambiado tu patrimonio neto cada mes (incluye aportaciones y mercado)</p></div>
        <div class="monthly"><div id="monthly-bars" class="chart-wrap" style="padding:0"></div><div class="table-scroll monthly-table" id="monthly-table"></div></div></section>
      <div class="kpis">
        <div class="kpi"><div class="kl">${debt > 0.005 ? 'Patrimonio neto' : 'Patrimonio'}</div><div class="kv num">${Calc.fmtEUR(net)}</div><div class="kd">${kd30}</div></div>
        <div class="kpi" style="--kc:var(--c-efectivo)"><div class="kl">Activos</div><div class="kv num">${Calc.fmtEUR(gross)}</div><div class="kd">${conc ? conc.count + ' productos' : ''}${yt ? html` · <span class="${changeClass(yt.abs)}">${Calc.fmtSigned(yt.abs)}</span> ${yt.partial ? 'desde el inicio' : 'en el año'}` : ''}</div></div>
        <div class="kpi" style="--kc:var(--c-deuda)"><div class="kl">Deudas</div><div class="kv num">${debt > 0.005 ? '−' : ''}${Calc.fmtEUR(debt)}</div><div class="kd">${quotas > 0 ? html`Cuotas: <span class="num">${Calc.fmtEUR(quotas)}</span> al mes` : 'Sin cuotas configuradas'}</div></div>
        <div class="kpi" style="--kc:var(--c-plan_pensiones)"><div class="kl">Líquido</div><div class="kv num">${Calc.fmtEUR(conc ? conc.liquid : 0)}</div><div class="kd">${conc ? pctPlain.format(conc.liquidPct) + ' de tus activos' : ''}</div></div>
        <div class="kpi" style="--kc:var(--c-accion)"><div class="kl">Beneficio de inversiones</div><div class="kv num ${ret.rows.length ? changeClass(ret.gain) : ''}">${ret.rows.length ? Calc.fmtSigned(ret.gain) : '—'}</div><div class="kd">${ret.pct != null ? html`${Calc.fmtPct(ret.pct)} sobre <span class="num">${Calc.fmtEUR(ret.invested)}</span> aportados` : 'Estimado con tus compras'}</div></div>
      </div>
      ${notesHtml}
      <div class="grid-half">
        <section class="panel"><div class="panel-head"><div><h2>Reparto</h2><div class="sub">Dónde está tu dinero</div></div>
          <div class="seg">${[['cat', 'Tipo'], ['ent', 'Entidad']].map(([k, l]) => html`<button type="button" data-action="donut-mode" data-mode="${k}" aria-pressed="${state.donut === k}">${l}</button>`)}</div></div>
          <div class="panel-body"><div class="donut"><div id="donut-host"></div><div class="donut-center"><div class="big num">${Calc.fmtEUR(gross)}</div><div class="lbl">activos</div></div></div>
          <div class="conc-list" id="donut-list" style="margin-top:14px"></div></div></section>
        <section class="panel"><div class="panel-head"><div><h2>Composición de la cartera</h2><div class="sub">Concentración, liquidez y endeudamiento</div></div></div><div class="panel-body">${health}
          <div class="conc-list">${A.positions(m, today).slice(0, 6).map((p) => html`<div class="conc-row"><span class="sw" style="background:var(--c-${p.asset.category})"></span><span class="nm">${p.asset.name}</span>
            <span class="bar"><i style="width:${(p.value / gross * 100).toFixed(1)}%;background:var(--c-${p.asset.category})"></i></span><span class="pc num">${pctPlain.format(p.value / gross)}</span><span class="am num">${Calc.fmtEUR(p.value)}</span></div>`)}</div></div></section>
      </div>
      <div class="grid-half">
        <section class="panel"><div class="panel-head"><div><h2>Objetivo</h2><div class="sub">Tu meta de patrimonio neto</div></div></div><div class="panel-body">${goalHtml}</div></section>
        <section class="panel"><div class="panel-head"><div><h2>Próximos movimientos</h2><div class="sub">Aportaciones y cuotas de los próximos 45 días</div></div></div>${upHtml}</section>
      </div>
      <section class="panel"><div class="panel-head"><div><h2>Movimientos en 30 días</h2><div class="sub">Variación del precio de cada producto</div></div></div>${mvHtml}</section>`;
  }

  function drawMain() {
    const host = $('#chart-main');
    if (!host) return;
    const m = state.model, i0 = cutIndex(m.dates), hidden = state.hiddenCats;
    const dates = m.dates.slice(i0);
    const all = Calc.STACK_ORDER.map((c) => ({ key: c, label: Calc.CATEGORIES[c].label, color: `var(--c-${c})`, values: m.byCat[c].slice(i0) })).filter((x) => x.values.some((v) => v > 0.005));
    const series = all.filter((x) => !hidden.has(x.key));
    const debt = m.byCat.deuda.slice(i0), net = m.net.slice(i0);
    const gross = m.gross.slice(i0);
    const filtered = hidden.size > 0;
    const hasDebt = !filtered && debt.some((v) => v > 0.005);
    const total = dates.map((_, i) => series.reduce((sum, x) => sum + (x.values[i] || 0), 0));
    Charts.draw(host, {
      dates, series, stacked: true, yMode: 'zero', fmt: Calc.fmtEUR, tall: true,
      ariaLabel: `Evolución del patrimonio entre ${Calc.fmtDate(dates[0])} y ${Calc.fmtDate(dates[dates.length - 1])}. ${filtered ? 'Suma de los tipos seleccionados' : 'Patrimonio actual'}: ${Calc.fmtEUR(filtered ? total[total.length - 1] : net[net.length - 1])}.`,
      showTotal: !hasDebt, totalLabel: filtered ? 'Selección' : 'Total', totalValues: total,
      extraRows: hasDebt ? (i) => [{ label: 'Activos', value: gross[i] }, { label: 'Deudas', value: -debt[i], color: 'var(--c-deuda)' }, { label: 'Patrimonio neto', value: net[i], total: true }] : null,
    });
    const lg = $('#legend-main');
    if (lg) lg.innerHTML = all.slice().reverse().map((x) => `<button type="button" class="legend-toggle${hidden.has(x.key) ? ' off' : ''}" data-action="toggle-cat" data-cat="${x.key}" aria-pressed="${!hidden.has(x.key)}"><i style="background:${x.color}"></i>${esc(x.label)}</button>`).join('');
    if (!state.revealed) {
      host.classList.add('reveal');
      host.addEventListener('animationend', () => host.classList.remove('reveal'), { once: true });
      state.revealed = true;
    }
  }

  function drawDonut() {
    const host = $('#donut-host'), list = $('#donut-list');
    if (!host || !list) return;
    const m = state.model, n = m.dates.length, today = Calc.todayStr();
    let items;
    if (state.donut === 'ent') items = A.byEntity(m, today).map((x, i) => ({ label: x.name, value: x.value, color: ENTITY_COLORS[i % ENTITY_COLORS.length] }));
    else items = Calc.LIST_ORDER.map((c) => ({ label: Calc.CATEGORIES[c].label, value: m.byCat[c][n - 1], color: `var(--c-${c})` })).filter((x) => x.value > 0.005);
    const total = items.reduce((s, x) => s + x.value, 0);
    Charts.donut(host, items, { fmt: Calc.fmtEUR, ariaLabel: 'Reparto de tus activos' });
    list.innerHTML = items.map((x) => `<div class="conc-row"><span class="sw" style="background:${x.color}"></span><span class="nm">${esc(x.label)}</span>
      <span class="bar"><i style="width:${(x.value / total * 100).toFixed(1)}%;background:${x.color}"></i></span><span class="pc num">${pctPlain.format(x.value / total)}</span><span class="am num">${esc(Calc.fmtEUR(x.value))}</span></div>`).join('');
  }

  function drawMonthly() {
    const bars = $('#monthly-bars'), tbl = $('#monthly-table');
    if (!bars || !tbl) return;
    const mo = A.monthly(state.model).slice(-13);
    const withDelta = mo.filter((r) => r.delta != null);
    if (!withDelta.length) { bars.innerHTML = '<p class="chart-empty">Necesitas al menos dos meses de datos.</p>'; return; }
    Charts.bars(bars, withDelta.map((r) => ({ label: monthLabel(r.month), value: r.delta })), { fmtSigned: Calc.fmtSigned, ariaLabel: 'Variación mensual del patrimonio neto' });
    tbl.innerHTML = `<table><thead><tr><th>Mes</th><th class="r">Patrimonio neto</th><th class="r">Variación</th></tr></thead><tbody>${mo.slice().reverse().map((r) =>
      `<tr><td>${esc(monthLabel(r.month))}</td><td class="r num">${esc(Calc.fmtEUR(r.net))}</td><td class="r num ${r.delta == null ? '' : changeClass(r.delta)}">${r.delta == null ? '—' : esc(Calc.fmtSigned(r.delta)) + (r.pct != null ? ' · ' + esc(Calc.fmtPct(r.pct)) : '')}</td></tr>`).join('')}</tbody></table>`;
  }

  // ---------- inversiones ----------
  const INV_COLS = [['name', 'Producto', false], ['value', 'Valor', true], ['weight', 'Peso', true], ['invested', 'Aportado', true], ['gain', 'Beneficio', true], ['pct', 'Rentab.', true], ['m30', '30 días', true]];
  function renderInversiones() {
    const m = state.model, today = Calc.todayStr();
    const list = m.assets.filter((a) => a.active && a.valuation === 'units');
    if (!list.length) return emptyState('No hay fondos, acciones ni planes', 'Añádelos en Ajustes con su ISIN y sus participaciones.', [['ajustes', 'Ir a Ajustes']]);
    const ret = A.returns(m, today);
    const total = ret.value || 1;
    const rows = ret.rows.map((r) => ({ r, name: r.asset.name, value: r.value, weight: r.value / total, invested: r.invested, gain: r.gain, pct: r.pct, m30: Calc.priceChange(r.asset, m.idx, 30) }));
    const { key, dir } = state.invSort;
    rows.sort((a, b) => key === 'name' ? dir * a.name.localeCompare(b.name, 'es') : dir * ((a[key] == null ? -Infinity : a[key]) - (b[key] == null ? -Infinity : b[key])));
    const missing = list.filter((a) => !ret.rows.some((r) => r.asset.id === a.id));
    const contrib = A.monthlyContributions(m);
    return html`
      <div class="kpis">
        <div class="kpi"><div class="kl">Valor de tus inversiones</div><div class="kv num">${Calc.fmtEUR(ret.value)}</div><div class="kd">${ret.rows.length} productos</div></div>
        <div class="kpi" style="--kc:var(--c-efectivo)"><div class="kl">Aportado</div><div class="kv num">${Calc.fmtEUR(ret.invested)}</div><div class="kd">Compras a precio del día</div></div>
        <div class="kpi" style="--kc:${ret.gain >= 0 ? 'var(--positive)' : 'var(--negative)'}"><div class="kl">Beneficio</div><div class="kv num ${changeClass(ret.gain)}">${Calc.fmtSigned(ret.gain)}</div><div class="kd">${ret.pct != null ? Calc.fmtPct(ret.pct) : ''}</div></div>
        <div class="kpi" style="--kc:var(--c-plan_pensiones)"><div class="kl">Aportación mensual</div><div class="kv num">${contrib > 0 ? Calc.fmtEUR(contrib) : '—'}</div><div class="kd">${contrib > 0 ? Calc.fmtEUR(contrib * 12) + ' al año' : 'Sin aportaciones automáticas'}</div></div>
      </div>
      <section class="panel"><div class="panel-head"><div><h2>Valor frente a lo aportado</h2><div class="sub">La distancia entre las dos líneas es tu beneficio</div></div>${rangeSeg()}</div>
        <div class="chart-wrap"><div id="chart-invest" class="chart"></div></div>
        <div class="chart-foot"><div class="legend"><span><i style="background:var(--accent)"></i>Valor</span><span><i class="dash"></i>Capital aportado</span></div></div></section>
      <section class="panel"><div class="panel-head"><div><h2>Tus productos</h2><div class="sub">Toca uno para ver su gráfica, corregir un precio o cambiar tus participaciones</div></div></div>
        <div class="table-scroll"><table><thead><tr>${INV_COLS.map(([k, l, r]) => html`<th class="${r ? 'r ' : ''}sortable" data-action="sort-inv" data-key="${k}" role="button" tabindex="0" style="cursor:pointer">${l}${key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`)}<th>Precio</th></tr></thead>
        <tbody>${rows.map((x) => html`<tr class="click" data-action="open-asset" data-id="${x.r.asset.id}">
          <td><span class="name-cell"><span class="sw" style="background:var(--c-${x.r.asset.category})"></span><span>${x.r.asset.name}<span class="sub">${[x.r.asset.entity, Calc.CATEGORIES[x.r.asset.category].label].filter(Boolean).join(' · ')}${x.r.asset.plan ? ' · aporta ' + Calc.fmtEUR(Number(x.r.asset.plan.amount)) + '/mes' : ''}</span></span></span></td>
          <td class="r num">${Calc.fmtEUR(x.value)}</td><td class="r num">${pctPlain.format(x.weight)}</td><td class="r num">${Calc.fmtEUR(x.invested)}</td>
          <td class="r num ${changeClass(x.gain)}">${Calc.fmtSigned(x.gain)}</td><td class="r num ${x.pct == null ? '' : changeClass(x.pct)}">${x.pct == null ? '—' : Calc.fmtPct(x.pct)}</td>
          <td class="r num ${x.m30 == null ? '' : changeClass(x.m30)}">${x.m30 == null ? '—' : Calc.fmtPct(x.m30)}</td>
          <td>${x.r.info.stale ? html`<span class="pill warn">del ${Calc.fmtDate(x.r.info.priceDate, false)}</span>` : html`<span class="pill on">al día</span>`}</td></tr>`)}</tbody>
        <tfoot><tr><td>Total</td><td class="r num">${Calc.fmtEUR(ret.value)}</td><td class="r num">100 %</td><td class="r num">${Calc.fmtEUR(ret.invested)}</td><td class="r num ${changeClass(ret.gain)}">${Calc.fmtSigned(ret.gain)}</td><td class="r num">${ret.pct != null ? Calc.fmtPct(ret.pct) : '—'}</td><td></td><td></td></tr></tfoot></table></div>
        ${missing.length ? html`<p class="small muted" style="padding:10px 18px 0">Sin precio o participaciones todavía: ${missing.map((a) => a.name).join(', ')}.</p>` : ''}
        <p class="small muted" style="padding:10px 18px 16px">«Aportado» suma cada compra (participaciones nuevas × precio de ese día, ya con tu parte). Es una estimación: si los precios históricos son aproximados, el beneficio también lo es.</p></section>`;
  }

  function drawInvest() {
    const host = $('#chart-invest');
    if (!host) return;
    const m = state.model;
    const i0 = cutIndex(m.dates), dates = m.dates.slice(i0);
    const value = A.investValueSeries(m).slice(i0), invested = A.investedSeries(m).slice(i0);
    if (dates.length < 2) { host.outerHTML = '<p class="chart-empty">La gráfica aparece cuando hay datos de dos fechas.</p>'; return; }
    Charts.draw(host, { dates, series: [{ label: 'Valor', color: 'var(--accent)', values: value }], lines: [{ label: 'Capital aportado', color: 'var(--text-dim)', values: invested }],
      diffRow: 'Beneficio', fmtSigned: Calc.fmtSigned, stacked: false, yMode: 'fit', fmt: Calc.fmtEUR,
      ariaLabel: `Valor de tus inversiones frente a lo aportado, de ${Calc.fmtDate(dates[0])} a ${Calc.fmtDate(dates[dates.length - 1])}.` });
  }

  // ---------- cuentas e inmuebles ----------
  function renderCuentas() {
    const m = state.model, today = Calc.todayStr();
    const order = ['efectivo', 'inmobiliario', 'deuda'];
    const list = m.assets.filter((a) => a.active && a.valuation === 'manual');
    if (!list.length) return emptyState('No hay cuentas ni inmuebles', 'Añade tus cuentas bancarias, inmuebles y deudas en Ajustes.', [['ajustes', 'Ir a Ajustes']]);
    return html`<div class="view-title"><div><h2 style="font-size:19px">Cuentas, inmuebles y deudas</h2><p class="muted small">Estos valores los anotas tú (o se calculan solos si la deuda tiene cuota). La pestaña Actualizar te deja ponerlos todos de una vez.</p></div>
        <button class="btn" type="button" data-action="tab" data-tab="actualizar">Actualizar saldos</button></div>
      ${order.map((c) => {
        const items = list.filter((a) => a.category === c);
        if (!items.length) return '';
        let sum = 0;
        const rows = items.map((a) => {
          const info = Calc.latestInfo(a, m.idx, today);
          if (info.value != null) sum += info.value;
          const hist = m.idx.manual.get(a.id) || [];
          const prev = hist.length > 1 ? Number(hist[hist.length - 2].value) : null;
          const d = prev != null && info.total != null ? (info.total - prev) * info.share : null;
          return html`<li><button type="button" class="row" data-action="open-manual" data-id="${a.id}">
            <span class="title"><span class="sw" style="background:var(--c-${a.category})"></span><span class="name">${a.name}${info.share < 1 ? ' (' + Math.round(info.share * 100) + ' %)' : ''}</span></span>
            <span class="val num">${info.missingValue ? '—' : (c === 'deuda' ? '−' : '') + Calc.fmtEUR(info.value)}</span>
            <span class="sub">${info.missingValue ? html`<span class="flag">Sin valor todavía</span>` : info.stale ? html`<span class="flag">Sin actualizar desde el ${Calc.fmtDate(info.date)}</span>` : `Actualizado el ${Calc.fmtDate(info.date)}`}${a.entity ? ' · ' + a.entity : ''}${a.loan ? ' · se calcula sola cada mes' : ''}</span>
            <span class="val2 num">${d != null && Math.abs(d) >= 0.005 ? html`<span class="${(c === 'deuda' ? -d : d) >= 0 ? 'pos' : 'neg'}">${Calc.fmtSigned(d)}</span> desde el anterior` : ''}</span></button></li>`;
        });
        return html`<section class="panel"><div class="panel-head"><div><h2>${Calc.CATEGORIES[c].label}</h2></div><b class="num" style="font-family:var(--font-display)">${c === 'deuda' ? '−' : ''}${Calc.fmtEUR(sum)}</b></div><ul class="rows">${rows}</ul></section>`;
      })}`;
  }

  // ---------- futuro: proyección, deudas y calendario ----------
  const HORIZONS = [[1, '1 año'], [3, '3 años'], [5, '5 años'], [10, '10 años'], [20, '20 años']];
  function renderFuturo() {
    const m = state.model, today = Calc.todayStr();
    if (!m.dates.length) return emptyState('Todavía no hay datos', 'La proyección necesita al menos tus saldos y precios actuales.', [['actualizar', 'Ir a Actualizar']]);
    const loans = A.loans(m, today), contrib = A.monthlyContributions(m), up = A.upcoming(m, today, 60);
    const pr = state.proj;
    return html`
      <div class="grid-main">
        <section class="panel"><div class="panel-head"><div><h2>Proyección de tu patrimonio</h2><div class="sub">Ilustrativa: sigue tus aportaciones y cuotas actuales con los supuestos de la derecha</div></div>
          <div class="seg">${HORIZONS.map(([y, l]) => html`<button type="button" data-action="proj-years" data-years="${y}" aria-pressed="${pr.years === y}">${l}</button>`)}</div></div>
          <div class="chart-wrap"><div id="chart-proj" class="chart"></div></div>
          <div class="chart-foot"><div class="legend"><span><i style="background:var(--accent)"></i>Patrimonio neto</span><span><i class="dash"></i>Inversiones</span></div></div></section>
        <section class="panel"><div class="panel-head"><div><h2>Supuestos</h2><div class="sub">Muévelos para ver cómo cambia</div></div></div><div class="panel-body">
          <div class="slider-row"><label for="pr-ret">Rentabilidad anual de tus inversiones</label><output id="pr-ret-o" class="num">${String(pr.ret).replace('.', ',')} %</output><input id="pr-ret" type="range" min="0" max="12" step="0.5" value="${pr.ret}" data-proj="ret"></div>
          <div class="slider-row"><label for="pr-re">Revalorización anual de inmuebles</label><output id="pr-re-o" class="num">${String(pr.re).replace('.', ',')} %</output><input id="pr-re" type="range" min="0" max="6" step="0.5" value="${pr.re}" data-proj="re"></div>
          <p class="small muted">Aportaciones: <b class="num">${Calc.fmtEUR(contrib)}</b> al mes${contrib > 0 ? '' : ' (configura una aportación mensual en Ajustes para incluirla)'}. Las deudas bajan según su cuota; el efectivo no cambia.</p>
          <div id="proj-table" class="table-scroll"></div></div></section>
      </div>
      <div class="grid-half">
        <section class="panel"><div class="panel-head"><div><h2>Deudas y préstamos</h2><div class="sub">Con cuota configurada (tu parte)</div></div></div>
          ${loans.length ? loans.map((l) => html`<div class="loan-card"><div class="loan-top"><b>${l.asset.name}${l.share < 1 ? ' (' + Math.round(l.share * 100) + ' %)' : ''}</b><b class="num">−${Calc.fmtEUR(l.balance * l.share)}</b></div>
            <div class="loan-facts"><div><div class="l">Cuota mensual</div><div class="v num">${Calc.fmtEUR(l.payment * l.share, 2)}</div></div>
            <div><div class="l">Tipo de interés</div><div class="v num">${String(l.rate).replace('.', ',')} %</div></div>
            <div><div class="l">${l.never ? 'Estado' : 'Terminarás de pagar'}</div><div class="v">${l.never ? 'La cuota no cubre los intereses' : Calc.fmtDate(l.payoff).replace(/^\d+ /, '')}</div></div>
            <div><div class="l">${l.never ? '' : 'Intereses que te quedan'}</div><div class="v num">${l.never ? '' : Calc.fmtEUR(l.interestLeft * l.share)}</div></div></div>
            ${l.months ? html`<p class="small muted" style="margin:8px 0 0">${l.months} cuotas restantes (${Math.floor(l.months / 12)} años y ${l.months % 12} meses).</p>` : ''}</div>`)
            : html`<p class="muted" style="padding:6px 18px 16px">Aún no hay deudas con cuota. En Ajustes, edita la deuda y rellena cuota, tipo y día de cobro.</p>`}</section>
        <section class="panel"><div class="panel-head"><div><h2>Calendario</h2><div class="sub">Próximos 60 días</div></div></div>
          ${up.length ? up.slice(0, 12).map((e) => html`<div class="event"><div class="d"><b>${Number(e.date.slice(8))}</b><span>${MES[Number(e.date.slice(5, 7)) - 1]}</span></div>
            <div class="t">${e.label}<small>${e.kind === 'cuota' ? 'Cuota de la deuda (tu parte)' : 'Aportación automática'}</small></div><div class="a num">${e.kind === 'cuota' ? '−' : ''}${Calc.fmtEUR(e.amount, 2)}</div></div>`)
            : html`<p class="muted" style="padding:6px 18px 16px">Nada previsto. Configura aportaciones o cuotas en Ajustes.</p>`}</section>
      </div>`;
  }

  function drawProjection() {
    const host = $('#chart-proj'), tbl = $('#proj-table');
    if (!host || !tbl) return;
    const m = state.model, today = Calc.todayStr(), pr = state.proj;
    const p = A.project(m, today, { months: 240, returnPct: pr.ret, realEstatePct: pr.re });
    if (!p) return;
    const k = pr.years * 12 + 1;
    Charts.draw(host, { dates: p.dates.slice(0, k), series: [{ label: 'Patrimonio neto', color: 'var(--accent)', values: p.net.slice(0, k) }],
      lines: [{ label: 'Inversiones', color: 'var(--text-dim)', values: p.invest.slice(0, k) }], stacked: false, yMode: 'fit', fmt: Calc.fmtEUR,
      ariaLabel: `Proyección ilustrativa del patrimonio neto a ${pr.years} años.` });
    const at = (y) => y * 12;
    tbl.innerHTML = `<table><thead><tr><th>En</th><th class="r">Patrimonio neto</th><th class="r">Deudas</th></tr></thead><tbody>${[1, 3, 5, 10, 20].map((y) =>
      `<tr><td>${y} ${y === 1 ? 'año' : 'años'}</td><td class="r num">${esc(Calc.fmtEUR(p.net[at(y)]))}</td><td class="r num">${esc(Calc.fmtEUR(p.debt[at(y)]))}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderActualizar() {
    const m = state.model, today = Calc.todayStr();
    const list = m.assets.filter((a) => a.active && a.valuation === 'manual');
    if (!list.length) return emptyState('No hay nada que actualizar', 'Añade tus cuentas bancarias, inmuebles y deudas en Ajustes.', [['ajustes', 'Ir a Ajustes']]);
    return html`<section class="panel"><div class="panel-head"><div><h2>Actualizar el mes</h2><div class="sub">Anota el saldo de cada cuenta y, si ha cambiado, el valor de inmuebles y deudas. Lo que dejes en blanco no se toca.</div></div></div>
      <div class="panel-body"><form data-form="update-month" novalidate>
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
      </form></div></section>
      <section class="panel"><div class="panel-head"><div><h2>Fondos, acciones y planes</h2></div></div><div class="panel-body">
        <p>Sus precios se actualizan solos desde GitHub y las aportaciones mensuales se suman solas. Si compras o vendes participaciones por tu cuenta, cámbialas en Inversiones.</p>
        <div class="actions"><button class="btn ghost" type="button" data-action="tab" data-tab="inversiones">Ir a Inversiones</button></div></div></section>`;
  }

  function renderAjustes() {
    const m = state.model;
    const all = m.assets.slice().sort((a, b) => (b.active - a.active) || (a.sort - b.sort) || a.name.localeCompare(b.name, 'es'));
    return html`<section class="panel"><div class="panel-head"><div><h2>Productos</h2><div class="sub">Añade, edita o da de baja cuentas, fondos, inmuebles y deudas</div></div><button class="btn" type="button" data-action="new-asset">Añadir producto</button></div>
        ${all.length ? html`<ul class="rows">${all.map((a) => html`<li><button type="button" class="row${a.active ? '' : ' dim'}" data-action="edit-asset" data-id="${a.id}">
          <span class="title"><span class="sw" style="background:var(--c-${a.category})"></span><span class="name">${a.name}</span></span>
          <span class="val2">${a.active ? Calc.CATEGORIES[a.category].label : 'Dado de baja'}</span>
          <span class="sub">${[a.entity, a.isin, a.plan ? 'aportación ' + Calc.fmtEUR(Number(a.plan.amount)) + ' el día ' + a.plan.day : null, a.loan ? 'cuota ' + Calc.fmtEUR(Number(a.loan.payment), 2) : null].filter(Boolean).join(' · ')}</span></button></li>`)}</ul>` : html`<p class="muted" style="padding:6px 18px 16px">Todavía no hay productos.</p>`}
      </section>
      <div class="grid-half">
      <section class="panel"><div class="panel-head"><div><h2>Copias y exportación</h2></div></div><div class="panel-body">
        <p>Descarga todos tus datos en un archivo (JSON) o la evolución de tu patrimonio en una hoja de cálculo (CSV). Guárdalos en un sitio privado, nunca en GitHub.</p>
        <div class="actions"><button class="btn ghost" type="button" data-action="backup">Descargar copia</button><button class="btn ghost" type="button" data-action="csv">Descargar evolución (CSV)</button></div></div></section>
      <section class="panel"><div class="panel-head"><div><h2>Sesión</h2></div></div><div class="panel-body">
        <p class="muted">Has entrado como ${(state.user && state.user.email) || 'tu usuario'}.</p>
        <div class="actions"><button class="btn ghost" type="button" data-action="logout">Cerrar sesión</button></div></div></section></div>`;
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
    range: (t) => {
      state.range = t.dataset.range;
      document.querySelectorAll('[data-action="range"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === state.range)));
      if (state.tab === 'resumen') drawMain(); else if (state.tab === 'inversiones') drawInvest();
    },
    privacy: (t) => {
      state.hide = !state.hide; store.set('hide', state.hide ? '1' : null);
      document.body.classList.toggle('hide-amounts', state.hide); t.setAttribute('aria-pressed', String(state.hide));
    },
    'donut-mode': (t) => { state.donut = t.dataset.mode; renderView(); },
    'toggle-cat': (t) => {
      const c = t.dataset.cat, h = state.hiddenCats;
      if (h.has(c)) h.delete(c);
      else {
        const visible = Calc.STACK_ORDER.filter((k) => !h.has(k) && state.model.byCat[k].some((v) => v > 0.005));
        if (visible.length <= 1) return toast('Deja al menos un tipo en el gráfico.', true);
        h.add(c);
      }
      drawMain();
    },
    'sort-inv': (t) => {
      const k = t.dataset.key;
      state.invSort = { key: k, dir: state.invSort.key === k ? -state.invSort.dir : (k === 'name' ? 1 : -1) };
      renderView();
    },
    'proj-years': (t) => {
      state.proj.years = Number(t.dataset.years);
      document.querySelectorAll('[data-action="proj-years"]').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
      drawProjection();
    },
    'goal-edit': () => { state.goal = null; renderView(); },
    'goal-clear': () => { store.set('goal', null); state.goal = null; renderView(); },
    csv: () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['\ufeff' + A.evolutionCSV(state.model)], { type: 'text/csv;charset=utf-8' }));
      a.download = `patrimonio-evolucion-${Calc.todayStr()}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast('Evolución descargada');
    },
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
    'set-goal': (form) => {
      const v = num(new FormData(form).get('goal'));
      if (v == null || !(v > 0)) return toast('Escribe un objetivo mayor que 0.', true);
      store.set('goal', v); state.goal = v; renderView();
    },
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
  document.addEventListener('toggle', (e) => {
    if (e.target && e.target.id === 'notes-panel') { state.notesOpen = e.target.open; store.set('notes', e.target.open ? '1' : '0'); }
  }, true);
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.proj) {
      state.proj[t.dataset.proj] = Number(t.value);
      const o = $('#pr-' + t.dataset.proj + '-o');
      if (o) o.textContent = String(t.value).replace('.', ',') + ' %';
      drawProjection();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches && e.target.matches('th[data-action="sort-inv"]')) handlers['sort-inv'](e.target);
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
