/* OnFire — app del vendedor */
API.init('onfire_seller_token');

let CATALOG = null;      // {types, faculties, event_name, ...}
let SELLER_NAME = '';
let SELECTED_TYPE = null;
let LAST_TICKET = null;
let PIN = '';

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
  show('form');
}

function renderTypes() {
  const box = $('#f-types');
  box.innerHTML = '';
  CATALOG.types.forEach(t => {
    const el = document.createElement('div');
    el.className = 'typeopt' + (SELECTED_TYPE === t.id ? ' sel' : '');
    el.innerHTML = `<div class="tname">${esc(t.name)}</div>
                    <div class="tprice">${fmtMoney(t.price_cents / 100)}</div>`;
    el.addEventListener('click', () => { SELECTED_TYPE = t.id; renderTypes(); });
    box.appendChild(el);
  });
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
  const fecha = phaseStart(g.starts_on).toLocaleDateString('es-MX',
    { day: 'numeric', month: 'long' });
  const lines = g.items.map(i =>
    `<div class="pt-item"><span>${esc(i.name)}${i.is_vip ? ' ★' : ''}</span><b>${fmtMoney(i.price_cents / 100)}</b></div>`
  ).join('');
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="pt-label">Los precios suben · ${esc(g.name)}</div>
     <div class="pt-clock">${clock}</div>
     <div class="pt-items">${lines}</div>
     <div class="pt-date">a partir del ${fecha}</div>`;
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

async function generate() {
  const btn = $('#btn-generate');
  const buyer = $('#f-buyer').value.trim();
  const faculty = $('#f-faculty').value;
  $('#f-err').textContent = '';
  if (buyer.length < 3) { $('#f-err').textContent = 'Escribe el nombre completo del comprador'; return; }
  if (!faculty) { $('#f-err').textContent = 'Elige la facultad'; return; }
  if (!SELECTED_TYPE) { $('#f-err').textContent = 'Elige el tipo de boleto'; return; }
  btn.disabled = true; btn.textContent = 'GENERANDO…';
  try {
    const r = await API.post('/api/tickets', {
      buyer_name: buyer, faculty_id: Number(faculty), type_id: SELECTED_TYPE,
    });
    LAST_TICKET = r.ticket;
    // sin pantalla de confirmación: se descarga al instante, se limpia el
    // formulario para el siguiente y el boleto queda guardado en el historial.
    clearForm();
    btn.textContent = 'DESCARGANDO…';
    await downloadTicket(r.ticket, CATALOG);
    toast('Boleto de ' + r.ticket.buyer_name + ' generado y descargado ✓');
  } catch (e) {
    if (e.data && e.data._unauthorized) return sessionLost();
    $('#f-err').textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'GENERAR BOLETO  🎟';
  }
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
        b.className = 'iconbtn'; b.title = 'Descargar imagen'; b.textContent = '⬇';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try { await downloadTicket(t, CATALOG); toast('Boleto descargado'); }
          finally { b.disabled = false; }
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
$('#btn-history').addEventListener('click', () => { show('history'); loadHistory(); });
$('#btn-back').addEventListener('click', () => show('form'));
$('#btn-another').addEventListener('click', () => { clearForm(); show('form'); });  // RF-48
$('#btn-download').addEventListener('click', async () => {
  const b = $('#btn-download');
  b.disabled = true; b.textContent = 'Generando imagen…';
  try { await downloadTicket(LAST_TICKET, CATALOG); toast('Boleto descargado ✓'); }
  catch (e) { toast('No se pudo descargar: ' + e.message); }
  finally { b.disabled = false; b.textContent = '⬇  Descargar boleto'; }
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
