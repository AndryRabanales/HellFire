/* OnFire — app del vendedor */
API.init('onfire_seller_token');

let CATALOG = null;      // {types, faculties, event_name, ...}
let SELLER_NAME = '';
let SELECTED_TYPE = null;
let LAST_TICKET = null;
let PIN = '';
const DOWNLOADED = new Set();   // ids de boletos ya descargados en esta sesión
// Referencia de la venta en curso: si falla la red y el vendedor vuelve a darle a
// Generar, se manda LA MISMA y el servidor devuelve el boleto que ya había creado
// en vez de crear otro. Se renueva al cerrar cada venta.
let VENTA_REF = null;
function nuevaRef() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const views = ['login', 'form', 'done', 'history'];
function show(view) {
  views.forEach(v => $('#view-' + v).classList.toggle('hidden', v !== view));
  window.scrollTo(0, 0);
}

/* ---------------- acceso ---------------- */
function renderPin() {
  $$('#pinrow .pinbox').forEach((box, i) => {
    box.textContent = PIN[i] || '•';
    box.classList.toggle('filled', i < PIN.length);
  });
}

function bindLogin() {
  const input = $('#pin-input');
  const focus = () => input.focus({ preventScroll: true });
  $('#pinrow').addEventListener('click', focus);
  input.addEventListener('input', () => {
    PIN = input.value.replace(/\D/g, '').slice(0, 4);
    input.value = PIN;
    renderPin();
    $('#lg-err').textContent = '';
    if (PIN.length === 4) doLogin();
  });
  $('#btn-enter').addEventListener('click', () => PIN.length === 4 ? doLogin() : focus());
  setTimeout(focus, 300);
}

async function doLogin() {
  try {
    const r = await API.post('/api/login-code', { code: PIN });
    API.setToken(r.token);
    SELLER_NAME = r.name;
    PIN = ''; $('#pin-input').value = ''; renderPin();
    await enterApp();
  } catch (e) {
    PIN = ''; $('#pin-input').value = ''; renderPin();
    $('#lg-err').textContent = e.message;   // RF-28: mensaje genérico
  }
}

async function logout() {
  try { await API.post('/api/logout'); } catch (_) {}
  API.setToken(null);
  show('login');
}

/* ---------------- catálogo + formulario ---------------- */
async function enterApp() {
  CATALOG = await API.get('/api/catalog');
  const first = SELLER_NAME.trim().split(/\s+/)[0] || SELLER_NAME;
  $('#hello-1').textContent = 'Hola, ' + first;
  $('#hello-2').textContent = 'Hola, ' + first;
  $('#av-1').textContent = (CATALOG.event_name || 'O')[0];
  const sel = $('#f-faculty');
  sel.innerHTML = '<option value="" disabled selected>Elige facultad…</option>' +
    CATALOG.faculties.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  renderTypes();
  startPhaseTimer();
  // Arrancar SIEMPRE en limpio: si el vendedor anterior dejó un grupo o un boleto
  // en pantalla y no tocó "Listo", al entrar otro (o el mismo) se quedaba viendo
  // los nombres de los compradores de esa venta. Además el marcado de "ya
  // descargado" es por sesión, así que tampoco debe heredarse.
  exitGroupMode();
  exitSoloResult();
  DOWNLOADED.clear();
  LAST_TICKET = null;
  show('form');
}

function renderTypes() {
  const box = $('#f-types');
  box.innerHTML = '';
  CATALOG.types.forEach(t => {
    const el = document.createElement('div');
    el.className = 'typeopt' + (SELECTED_TYPE === t.id ? ' sel' : '');
    const priceLabel = t.price_cents > 0
      ? fmtMoney(t.price_cents / 100)
      : '<span style="color:var(--cream-45);font-size:12px">Por definir</span>';
    el.innerHTML = `<div class="tname">${esc(t.name)}</div><div class="tprice">${priceLabel}</div>`;
    el.addEventListener('click', () => { SELECTED_TYPE = t.id; renderTypes(); });
    box.appendChild(el);
  });
  // La facultad solo se pide para tipos que la requieren (UADY). Antes también se
  // mostraba SIN tipo elegido; ahora que tras cada venta el formulario se queda en
  // pantalla, eso dejaba un "Elige facultad..." colgando después de cada boleto.
  const sel = CATALOG.types.find(t => t.id === SELECTED_TYPE);
  const showFac = !!sel && !!sel.needs_faculty;
  $('#f-faculty-block').style.display = showFac ? '' : 'none';
  renderPhaseTimer();
}

/* ---------------- cronómetro de la próxima fase de precio ---------------- */
let PHASE_INT = null, _reloadingCatalog = false;

// "AAAA-MM-DD" → medianoche local de ese día (cuando entra la nueva fase)
function phaseStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function pad2(n) { return String(n).padStart(2, '0'); }

// La próxima fase de venta: la fecha futura más cercana entre todos los tipos,
// con el precio nuevo de CADA tipo (las fases son globales: misma fecha para todos).
function nextGlobalPhase() {
  const withPhase = CATALOG.types.filter(t => t.next_phase);
  if (!withPhase.length) return null;
  const soonest = withPhase.map(t => t.next_phase.starts_on).sort()[0];
  const items = withPhase
    .filter(t => t.next_phase.starts_on === soonest)
    .map(t => ({ name: t.name, is_vip: t.is_vip, price_cents: t.next_phase.price_cents }));
  const phaseName = withPhase.find(t => t.next_phase.starts_on === soonest).next_phase.name;
  return { starts_on: soonest, name: phaseName, items };
}

function renderPhaseTimer() {
  const box = $('#f-phase-timer');
  const g = nextGlobalPhase();
  if (!g) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const diff = phaseStart(g.starts_on) - new Date();
  if (diff <= 0) {                     // la fase ya llegó → tomar los precios nuevos
    box.classList.add('hidden');
    reloadCatalog();
    return;
  }
  const d = Math.floor(diff / 86400000);
  const h = Math.floor(diff % 86400000 / 3600000);
  const m = Math.floor(diff % 3600000 / 60000);
  const s = Math.floor(diff % 60000 / 1000);
  const clock = (d > 0 ? d + 'd ' : '') + pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  // mes abreviado: "28 ago" en vez de "28 de agosto", para que la línea no se parta
  const fecha = phaseStart(g.starts_on).toLocaleDateString('es-MX',
    { day: 'numeric', month: 'short' }).replace('.', '');
  // todo en un renglón: "UADY $200 · Externo $225 · VIP ★ $425 · desde el 28 de agosto"
  const lines = g.items.map(i =>
    `${esc(i.name)}${i.is_vip ? ' \u2605' : ''} <b>${fmtMoney(i.price_cents / 100)}</b>`
  ).join(' \u00b7 ');
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="pt-top">
       <span class="pt-label">Los precios suben \u00b7 ${esc(g.name)}</span>
       <span class="pt-clock">${clock}</span>
     </div>
     <div class="pt-items">${lines} \u00b7 desde el ${fecha}</div>`;
}

// al vencer una fase se recarga el catálogo para reflejar el precio nuevo
async function reloadCatalog() {
  if (_reloadingCatalog) return;
  _reloadingCatalog = true;
  try {
    CATALOG = await API.get('/api/catalog');
    renderTypes();
  } catch (e) { /* reintenta en el siguiente tick */ }
  finally { _reloadingCatalog = false; }
}

/* El catálogo se leía UNA sola vez, al entrar. Un vendedor que dejaba la sesión
   abierta todo el día seguía con los precios y los tipos de la mañana: si un admin
   corregía algo, en su teléfono no cambiaba nada hasta volver a entrar. Ahora se
   refresca al volver a la pantalla y cada pocos minutos, sin estorbar mientras
   está escribiendo un nombre o armando un grupo. */
function catalogoAlDia() {
  if (!CATALOG || !API.token) return;
  if (GROUP_SIZE || $('#f-buyer').value.trim()) return;   // venta a medias: no se toca
  reloadCatalog();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) catalogoAlDia(); });
setInterval(catalogoAlDia, 120000);

function startPhaseTimer() {
  if (PHASE_INT) clearInterval(PHASE_INT);
  PHASE_INT = setInterval(renderPhaseTimer, 1000);
}

function clearForm() {
  $('#f-buyer').value = '';
  $('#f-faculty').selectedIndex = 0;
  SELECTED_TYPE = null;
  renderTypes();
  $('#f-err').textContent = '';
}

/* ---------------- plan de grupo (5 o 10, solo Externo, -20%) ---------------- */
let GROUP_SIZE = null;      // null | 5 | 10
let GROUP_REP_IDX = null;   // índice del representante (solo grupo de 10)
let GROUP_RESULT = null;    // respuesta de /api/groups una vez generado (hasta tocar "Listo")

function enterGroupMode(size) {
  if (!CATALOG.group) {
    toast('El precio de grupo aún no está configurado. Pídele al admin que lo defina.');
    return;
  }
  GROUP_SIZE = size;
  GROUP_REP_IDX = null;
  GROUP_RESULT = null;
  $('#mode-individual').classList.add('hidden');
  $('#group-switch').classList.add('hidden');
  $('#mode-group').classList.remove('hidden');
  $('#btn-generate').classList.add('hidden');
  $('#btn-generate-group').classList.remove('hidden');
  $('#btn-generate-group').textContent = 'GENERAR GRUPO DE ' + size;
  $('#btn-group-done').classList.add('hidden');
  $('#btn-group-back').classList.remove('hidden');
  $('#group-result-bar').classList.add('hidden'); $('#group-result-bar').classList.remove('done');
  $('#f-hint').textContent = 'Grupo de ' + size + ' · un boleto por integrante';
  $('#f-err').textContent = '';
  renderGroupPriceBar();
  renderGroupNames();
}

function exitGroupMode() {
  GROUP_SIZE = null; GROUP_REP_IDX = null; GROUP_RESULT = null;
  $('#mode-individual').classList.remove('hidden');
  $('#group-switch').classList.remove('hidden');
  $('#mode-group').classList.add('hidden');
  $('#btn-generate').classList.remove('hidden');
  $('#btn-generate-group').classList.add('hidden');
  $('#btn-group-done').classList.add('hidden');
  $('#group-result-bar').classList.add('hidden'); $('#group-result-bar').classList.remove('done');
  $('#f-hint').textContent = 'Los datos del comprador';
  $('#f-err').textContent = '';
  $('#group-names').innerHTML = '';
}

function renderGroupPriceBar() {
  const g = CATALOG.group;
  // el grupo ya no lleva descuento: van a precio normal y el beneficio es la botella
  $('#group-price-bar').innerHTML = `
    <div class="gp-line">Precio por boleto · grupo de ${GROUP_SIZE}</div>
    <div class="gp-price">${fmtMoney(g.group_price_cents / 100)}</div>
    <div class="gp-save">Total ${fmtMoney(g.group_price_cents * GROUP_SIZE / 100)} · el representante se lleva la botella</div>`;
}

// cada integrante va en su propia tarjeta (borde + ficha numerada), para que
// se vean claramente separados y nunca se pierda de vista a cuál boleto
// corresponde cada nombre.
function renderGroupNames() {
  const box = $('#group-names');
  box.innerHTML = '';
  for (let i = 0; i < GROUP_SIZE; i++) {
    const row = document.createElement('div');
    row.className = 'grouprow';
    const num = document.createElement('div');
    num.className = 'gr-num'; num.textContent = i + 1;
    row.appendChild(num);
    const col = document.createElement('div');
    col.style.cssText = 'flex:1;min-width:0';
    col.innerHTML = `<div class="gr-label">Boleto ${i + 1}</div>`;
    const input = document.createElement('input');
    input.className = 'input grow'; input.dataset.idx = i;
    input.placeholder = 'Nombre completo';
    col.appendChild(input);
    row.appendChild(col);
    if (GROUP_SIZE === 10) {
      const rep = document.createElement('button');
      rep.className = 'repbtn'; rep.type = 'button'; rep.title = 'Marcar como representante (botella)';
      rep.textContent = '★';
      rep.addEventListener('click', () => {
        GROUP_REP_IDX = (GROUP_REP_IDX === i) ? null : i;
        $$('#group-names .repbtn').forEach((b, bi) => b.classList.toggle('sel', bi === GROUP_REP_IDX));
      });
      row.appendChild(rep);
    }
    box.appendChild(row);
  }
}

// tras generar: NO se sale de la pantalla. Cada tarjeta pasa a verde con su
// número en ✓, el nombre queda subrayado con su propio botón ⬇ (descarga bajo
// demanda, la más confiable en iPhone porque es un toque real del usuario), y
// abajo el monto final + ahorro para captura de pantalla.
function showGroupResult(r) {
  GROUP_RESULT = r;
  const box = $('#group-names');
  box.innerHTML = r.tickets.map((t, i) => `
    <div class="grouprow done">
      <div class="gr-num">${i + 1}</div>
      <div style="flex:1;min-width:0">
        <div class="gr-label">Boleto ${i + 1}</div>
        <div style="font:700 14px Manrope;color:var(--cream);
          text-decoration:underline;text-decoration-color:#ff7a4d;text-underline-offset:4px">
          ${esc(t.buyer_name)}${r.representative === t.buyer_name ? ' <span style="color:#f3d27a">★</span>' : ''}
        </div>
      </div>
      <button class="iconbtn" data-idx="${i}" title="Descargar boleto">${DL_ICON}</button>
    </div>`).join('');
  box.querySelectorAll('.iconbtn').forEach(b => {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await downloadTicket(r.tickets[Number(b.dataset.idx)], CATALOG);
        // marca el botón como "ya descargado" (check + relleno), para que el
        // vendedor sepa de un vistazo cuáles boletos del grupo le faltan
        b.innerHTML = CHECK_ICON;
        b.classList.add('grabbed');
        b.title = 'Ya descargado · toca para volver a descargarlo';
      } finally { b.disabled = false; }
    });
  });
  const totalFinal = r.tickets.reduce((s, t) => s + t.price, 0);
  $('#group-result-bar').classList.remove('hidden');
  $('#group-result-bar').classList.add('done');
  $('#group-result-bar').innerHTML = `
    <div class="gp-line">¡Listo! Grupo de ${r.size} generado ✓</div>
    <div class="gp-price">${fmtMoney(totalFinal)} <span style="font-size:12px;color:var(--cream-45);font-weight:600">monto final</span></div>
    <div class="gp-save">No olvides la botella para ${esc(r.representative || 'el representante')}</div>`;
  $('#f-hint').textContent = 'Descarga cada boleto abajo';
  $('#btn-generate-group').classList.add('hidden');
  $('#btn-group-back').classList.add('hidden');
  $('#btn-group-done').classList.remove('hidden');
}

async function generateGroup() {
  const btn = $('#btn-generate-group');
  const inputs = [...document.querySelectorAll('#group-names input')];
  const names = inputs.map(i => i.value.trim());
  $('#f-err').textContent = '';
  const emptyIdx = names.findIndex(n => n.length < 3);
  if (emptyIdx !== -1) {
    $('#f-err').textContent = `Escribe el nombre completo del integrante ${emptyIdx + 1}`;
    return;
  }
  if (GROUP_SIZE === 10 && GROUP_REP_IDX === null) {
    $('#f-err').textContent = 'Marca quién es el representante del grupo (★, recibe la botella)';
    return;
  }
  btn.disabled = true; btn.textContent = 'GENERANDO…';
  try {
    const r = await API.post('/api/groups', {
      size: GROUP_SIZE, names,
      representative_index: GROUP_SIZE === 10 ? GROUP_REP_IDX : null,
    });
    showGroupResult(r);
  } catch (e) {
    if (e.data && e.data._unauthorized) return sessionLost();
    $('#f-err').textContent = e.message;
  } finally {
    btn.disabled = false;
    if (!GROUP_RESULT) btn.textContent = 'GENERAR GRUPO DE ' + GROUP_SIZE;
  }
}

async function generate() {
  const btn = $('#btn-generate');
  const buyer = $('#f-buyer').value.trim();
  const faculty = $('#f-faculty').value;
  const selType = CATALOG.types.find(t => t.id === SELECTED_TYPE);
  $('#f-err').textContent = '';
  if (buyer.length < 3) { $('#f-err').textContent = 'Escribe el nombre completo del comprador'; return; }
  if (!SELECTED_TYPE) { $('#f-err').textContent = 'Elige el tipo de boleto'; return; }
  // la facultad solo es obligatoria para tipos que la requieren (UADY)
  if (selType && selType.needs_faculty && !faculty) {
    $('#f-err').textContent = 'Elige la facultad'; return;
  }
  btn.disabled = true; btn.textContent = 'GENERANDO…';
  if (!VENTA_REF) VENTA_REF = nuevaRef();   // la misma en los reintentos de ESTA venta
  try {
    const r = await API.post('/api/tickets', {
      buyer_name: buyer, type_id: SELECTED_TYPE,
      faculty_id: (selType && selType.needs_faculty) ? Number(faculty) : null,
      client_ref: VENTA_REF,
    });
    LAST_TICKET = r.ticket;
    VENTA_REF = null;                       // venta cerrada: la siguiente lleva otra
    // se descarga en el acto; si el navegador lo bloquea queda el botón de la tira
    let bajo = false;
    try { await downloadTicket(r.ticket, CATALOG); bajo = true; } catch (_) {}
    showSoloResult(r.ticket, bajo);
    clearForm();                            // listo para la siguiente venta
    toast(r.repetido
      ? 'Ese boleto ya se hab\u00eda generado: es el mismo, no se duplic\u00f3'
      : (bajo ? 'Boleto descargado' : 'Boleto generado \u00b7 toca la flecha para bajarlo'));
  } catch (e) {
    if (e.data && e.data._unauthorized) return sessionLost();
    $('#f-err').textContent = mensajeDeError(e);
  } finally {
    btn.disabled = false; btn.textContent = 'GENERAR BOLETO';
  }
}

/* Boleto individual: NO se cambia de pantalla. Se descarga y punto — el formulario
   se queda listo para la siguiente venta, que es lo que se hace 100 veces al día.

   Debajo del formulario queda una tira con el último boleto y su botón: en iPhone
   la descarga automática a veces no se ve por ningún lado, y sin esa tira el
   vendedor no tendría cómo recuperarla salvo yéndose al historial. */
function showSoloResult(t, bajoAutomatico) {
  $('#solo-row').innerHTML = `
    <div class="grouprow done">
      <div class="gr-num">\u2713</div>
      <div style="flex:1;min-width:0">
        <div class="gr-label">${esc(ticketTypeLabel(t))} \u00b7 ${fmtMoney(t.price)}</div>
        <div style="font:700 15px Manrope;color:var(--cream);overflow:hidden;
          text-overflow:ellipsis;white-space:nowrap">${esc(t.buyer_name)}</div>
      </div>
      <button class="iconbtn" id="solo-dl" title="Descargar de nuevo">${bajoAutomatico ? CHECK_ICON : DL_ICON}</button>
    </div>
    <div class="muted" style="font-size:10.5px;margin-top:6px;text-align:center">
      ${bajoAutomatico ? 'Descargado. Si no lo encuentras, toca la flecha para bajarlo otra vez.'
                       : 'Toca la flecha para descargar el boleto.'}
    </div>`;
  const b = $('#solo-dl');
  if (bajoAutomatico) { b.classList.add('grabbed'); DOWNLOADED.add(t.id); }
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await downloadTicket(t, CATALOG);
      b.innerHTML = CHECK_ICON;
      b.classList.add('grabbed');
      DOWNLOADED.add(t.id);
    } finally { b.disabled = false; }
  });
  $('#solo-result').classList.remove('hidden');
}

function exitSoloResult() {
  $('#solo-result').classList.add('hidden');
  $('#solo-row').innerHTML = '';
}

/* ---------------- confirmación (RF-47) ---------------- */
function showDone(t) {
  $('#d-event').textContent = CATALOG.event_name;
  $('#d-subtitle').textContent = CATALOG.event_subtitle;
  $('#d-buyer').textContent = t.buyer_name;
  $('#d-faculty').textContent = t.faculty_name;
  $('#d-type').textContent = t.type_name + ' · ' + fmtMoney(t.price);
  drawPreviewQR(t.qr_payload || t.qr_token);
  show('done');
}

function drawPreviewQR(token) {
  const cv = $('#d-qr');
  const qr = qrcode(0, 'M');
  qr.addData(toUTF8(token), 'Byte'); qr.make();   // toUTF8 definido en ticket.js
  const n = qr.getModuleCount();
  cv.width = n; cv.height = n;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, n, n);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect(c, r, 1, 1);
}

/* ---------------- historial ---------------- */
let _searchTimer = null;

async function loadHistory() {
  const q = $('#h-search').value.trim();
  try {
    const r = await API.get('/api/my-tickets' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const list = $('#h-list');
    list.innerHTML = '';
    if (!r.tickets.length) {
      list.innerHTML = '<div class="muted" style="text-align:center;padding:30px 0">' +
        (q ? 'Sin resultados para esa búsqueda' : 'Aún no has generado boletos') + '</div>';
      return;
    }
    r.tickets.forEach(t => {
      const row = document.createElement('div');
      const isVoid = t.status === 'void';
      row.className = 'trow' + (isVoid ? ' void' : '');
      row.innerHTML = `
        <div class="tmain">
          <div class="tbuyer">${esc(t.buyer_name)}</div>
          <div class="tmeta">${esc(t.type_name)} · ${esc(fmtDate(t.created_at))}</div>
        </div>
        <div class="tprice">${fmtMoney(t.price)}</div>`;
      if (isVoid) {
        row.insertAdjacentHTML('beforeend', '<div class="badge-void">Anulado</div>');   // RF-75
      } else {
        const b = document.createElement('button');   // RF-71/76: re-descarga solo no anulados
        b.className = 'iconbtn';
        const already = DOWNLOADED.has(t.id);
        if (already) b.classList.add('grabbed');
        b.title = already ? 'Ya descargado · toca para volver a descargarlo' : 'Descargar imagen';
        b.innerHTML = already ? CHECK_ICON : DL_ICON;
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await downloadTicket(t, CATALOG);
            toast('Boleto descargado');
            DOWNLOADED.add(t.id);
            b.innerHTML = CHECK_ICON;
            b.classList.add('grabbed');
            b.title = 'Ya descargado · toca para volver a descargarlo';
          } finally { b.disabled = false; }
        });
        row.appendChild(b);
      }
      list.appendChild(row);
    });
  } catch (e) {
    if (e.data && e.data._unauthorized) return sessionLost();
    toast(e.message);
  }
}

/* Sin internet, fetch lanza un error del navegador en ingl\u00e9s ("Failed to fetch").
   En la calle eso pasa seguido y el vendedor necesita saber qu\u00e9 hacer. */
function mensajeDeError(e) {
  const red = !e.status && (navigator.onLine === false ||
    /fetch|network|load failed|conexi/i.test(e.message || ''));
  return red
    ? 'Sin internet. Revisa tu se\u00f1al y vuelve a darle a Generar (no se duplica).'
    : e.message;
}

function sessionLost() {
  API.setToken(null);
  toast('Tu sesión terminó. Vuelve a entrar.');
  show('login');
}

/* ---------------- eventos ---------------- */
bindLogin();
$('#btn-logout-1').addEventListener('click', logout);
$('#btn-logout-2').addEventListener('click', logout);
$('#btn-generate').addEventListener('click', generate);
$('#btn-generate-group').addEventListener('click', generateGroup);
$('#btn-group-10').addEventListener('click', () => enterGroupMode(10));
$('#btn-group-back').addEventListener('click', exitGroupMode);
$('#btn-group-done').addEventListener('click', exitGroupMode);
$('#btn-history').addEventListener('click', () => { show('history'); loadHistory(); });
$('#btn-back').addEventListener('click', () => show('form'));
$('#btn-another').addEventListener('click', () => { clearForm(); show('form'); });  // RF-48
$('#btn-download').addEventListener('click', async () => {
  const b = $('#btn-download');
  const restore = b.innerHTML;
  b.disabled = true; b.textContent = 'Generando imagen…';
  try { await downloadTicket(LAST_TICKET, CATALOG); toast('Boleto descargado ✓'); }
  catch (e) { toast('No se pudo descargar: ' + e.message); }
  finally { b.disabled = false; b.innerHTML = restore; }
});
$('#h-search').addEventListener('input', () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(loadHistory, 250);
});

/* ---------------- arranque ---------------- */
(async function boot() {
  // nombre real del evento en la pantalla de acceso
  API.get('/api/event').then(ev => {
    $('#lg-name').textContent = ev.event_name;
    $('#lg-sub').textContent = (ev.event_subtitle || '').toUpperCase();
  }).catch(() => {});
  try {
    if (API.token) {
      const me = await API.get('/api/me');
      if (me.role === 'seller') { SELLER_NAME = me.name; await enterApp(); return; }
      API.setToken(null);
    }
  } catch (_) { API.setToken(null); }
  show('login');
})();
