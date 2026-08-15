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
    // Los códigos de vendedor son de 5; al quinto dígito entra solo. El de
    // invitados puede ser más corto o más largo (4 a 6): ese se manda con el botón
    // ENTRAR, sin que la pantalla delate que existen códigos de otras medidas.
    PIN = input.value.replace(/\D/g, '').slice(0, 6);
    input.value = PIN;
    renderPin();
    $('#lg-err').textContent = '';
    if (PIN.length === 5) doLogin();
  });
  $('#btn-enter').addEventListener('click', () => PIN.length >= 4 ? doLogin() : focus());
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
  // AL FINAL: exitGroupMode vuelve a mostrar el formulario, así que el cierre tiene
  // que ser lo último que se aplica o el vendedor vería la boletera igual que siempre.
  aplicarCierre();
  show('form');
  // el catálogo dice si le falta el tutorial: así también le sale al que recarga la
  // página con la sesión ya iniciada, no solo al que acaba de meter su código
  if (CATALOG.tutorial_pendiente) mostrarTutorial();
}

/* Con las ventas cerradas se retira el formulario entero: campos, tipos, grupo y el
   botón de generar. Da igual que el servidor rechace la petición —eso el vendedor lo
   vería después de escribir todo—; mejor que no empiece. */
function aplicarCierre() {
  const cerradas = !!(CATALOG && CATALOG.ventas_cerradas);
  // OJO: exitGroupMode vuelve a MOSTRAR el formulario, así que va antes de esconderlo.
  if (cerradas) exitGroupMode();
  $('#ventas-cerradas').classList.toggle('hidden', !cerradas);
  ['#mode-individual', '#group-switch', '#btn-generate', '#f-phase-timer'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    if (cerradas) el.classList.add('hidden');
    else if (sel !== '#f-phase-timer') el.classList.remove('hidden');
  });
  $('#f-hint').textContent = cerradas ? 'El corte ya se hizo' : '';
  return cerradas;
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
  aplicarCierre();
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
  const sg = Math.floor(diff % 60000 / 1000);

  // Cuenta regresiva de verdad: cada unidad en su casilla, con el segundero
  // corriendo. Es lo que el vendedor le enseña al comprador para cerrar la venta
  // ("mira, faltan 20 días y sube"), así que tiene que verse.
  const casilla = (v, etq) => `<div class="pt-u"><b>${pad2(v)}</b><i>${etq}</i></div>`;
  const reloj = casilla(d, 'días') + casilla(h, 'hrs') +
                casilla(m, 'min') + casilla(sg, 'seg');

  // Menos de 48 h: se enciende. Si gritara siempre, dejaría de significar.
  const urge = diff < 48 * 3600000;
  const lines = g.items.map(i =>
    `<span>${esc(i.name)}<b>${fmtMoney(i.price_cents / 100)}</b></span>`).join('');

  box.classList.remove('hidden');
  box.classList.toggle('urge', urge);
  box.innerHTML =
    `<div class="pt-head">
       <span class="pt-sub">Los precios suben</span>
       <span class="pt-fase">${esc(g.name)}</span>
     </div>
     <div class="pt-clock">${reloj}</div>
     <div class="pt-items">${lines}</div>`;
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
// El cierre de ventas SÍ se consulta aunque haya una venta a medias: si el
// organizador ya cortó, el vendedor tiene que enterarse ahora, no al fallarle el
// botón después de escribir diez nombres.
async function revisaCierre() {
  if (!API.token || !CATALOG) return;
  try {
    const c = await API.get('/api/catalog');
    if (!!c.ventas_cerradas !== !!CATALOG.ventas_cerradas) {
      CATALOG = c;
      if (aplicarCierre()) toast('El organizador cerr\u00f3 las ventas');
    }
  } catch (_) { /* se reintenta en el siguiente tick */ }
}
setInterval(revisaCierre, 45000);
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
  $('#f-hint').textContent = '';
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
  // Llevaba DOS palomitas rojas idénticas —una de estado y otra en el botón— y el
  // texto decía "toca la flecha" cuando no había ninguna flecha. Encima se quedaba
  // ahí mientras el vendedor escribía el siguiente nombre, así que parecía parte de
  // la venta en curso. Ahora dice qué es ("último boleto") y solo hay UNA cosa
  // tocable, con su flecha y su palabra.
  $('#solo-row').innerHTML = `
    <div class="ultimo">
      <div class="u-cab">Último boleto${bajoAutomatico ? ' · descargado' : ''}</div>
      <div class="u-fila">
        <div class="u-datos">
          <div class="u-nombre">${esc(t.buyer_name)}</div>
          <div class="u-meta">${esc(ticketTypeLabel(t))} \u00b7 ${fmtMoney(t.price)}</div>
        </div>
        <button class="u-dl" id="solo-dl">${DL_ICON}<span>Descargar</span></button>
      </div>
    </div>`;
  if (bajoAutomatico) DOWNLOADED.add(t.id);
  const b = $('#solo-dl');
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await downloadTicket(t, CATALOG);
      DOWNLOADED.add(t.id);
      toast('Boleto descargado otra vez');
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

/* "Más reciente ↓" era un rótulo con pinta de botón: la gente lo tocaba y no pasaba
   nada. Si tiene forma de botón, que lo sea — ordena al revés. */
let H_VIEJOS_PRIMERO = false;

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
    const orden = H_VIEJOS_PRIMERO ? [...r.tickets].reverse() : r.tickets;
    orden.forEach(t => {
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
$('#h-orden').addEventListener('click', () => {
  H_VIEJOS_PRIMERO = !H_VIEJOS_PRIMERO;
  $('#h-orden').innerHTML = (H_VIEJOS_PRIMERO ? 'M\u00e1s antiguo' : 'M\u00e1s reciente') +
    `<span class="o-fl">${H_VIEJOS_PRIMERO ? '\u2191' : '\u2193'}</span>`;
  loadHistory();
});
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

/* ---------------- guía de uso ----------------
   El vendedor entra una vez, le enseñan en dos minutos y luego está solo en una
   fiesta con el celular en la mano. Esto es para ese momento: pasos numerados en
   el mismo orden en que se hacen, y respuestas a lo que de verdad preguntan. */
function modal(html) {
  $('#modal').innerHTML = html;
  $('#modal-bg').classList.remove('hidden');
}
function closeModal() { $('#modal-bg').classList.add('hidden'); }
$('#modal-bg').addEventListener('click', e => { if (e.target.id === 'modal-bg') closeModal(); });

/* El precio SALE DEL CATÁLOGO, no escrito a mano: si mañana entra una fase nueva o
   cambias un precio, la guía se actualiza sola. Si un tipo no existe todavía (Ultra
   VIP, por ejemplo), su nivel se marca PRÓXIMAMENTE en vez de mentir con uno viejo. */
function precioDe(incluye, excluye = []) {
  const hay = (CATALOG && CATALOG.types || []).filter(t => {
    const n = (t.name || '').toLowerCase().replace(/\s+/g, '');
    return incluye.some(k => n.includes(k)) && !excluye.some(k => n.includes(k));
  });
  if (!hay.length) return '';
  return [...new Set(hay.map(t => '$' + (t.price_cents / 100).toFixed(0)))].join(' · ');
}

/* Un nivel de boleto en DOS renglones: nombre con precio, y lo que trae separado
   por puntos. Antes era una viñeta por línea y seis viñetas ocupaban media
   pantalla; lo mismo dicho de corrido se lee de un vistazo. */
function nivel(titulo, precio, mas) {
  const proximo = !precio;
  return `<div class="niv${proximo ? ' proximo' : ''}">
    <div class="nv-top">
      <span class="nv-t">${titulo}</span>
      ${proximo ? '<span class="nv-soon">Próximamente</span>'
                : `<span class="nv-p">${precio}</span>`}
    </div>
    <div class="nv-d">${mas}</div>
  </div>`;
}

function bloque(titulo, dentro, abierto) {
  return `<details class="seccion"${abierto ? ' open' : ''}>
    <summary>${titulo}</summary><div class="sec-in">${dentro}</div></details>`;
}
function paso(n, texto) {
  return `<div class="g-item"><div class="g-n">${n}</div><div class="g-tit">${texto}</div></div>`;
}
function duda(preg, resp) {
  return `<details class="faq"><summary>${preg}</summary><div>${resp}</div></details>`;
}

function mostrarAyuda() {
  // Tres secciones plegadas, no un muro. Abre la de los boletos porque es la que se
  // consulta CON EL COMPRADOR ENFRENTE; las otras dos se abren cuando hacen falta.
  const conFac = (CATALOG && CATALOG.types || [])
    .filter(t => t.needs_faculty).map(t => esc(t.name));

  const boletos =
    nivel('UADY / Externo', precioDe(['uady', 'externo']),
          'Barra libre toda la noche · aguas locas · shots') +
    nivel('VIP', precioDe(['vip'], ['ultra']),
          'Todo lo anterior <b>+ no haces fila</b> · segunda barra solo VIP · ' +
          'botellas exclusivas · Coca sin límite · shot de bienvenida · pulsera') +
    nivel('Ultra VIP', precioDe(['ultra']),
          'Todo lo del VIP <b>+ zona propia</b> · tercera barra solo tuya · ' +
          'botellas top · margaritas y palomas');

  const vender = `<div class="guia">
      ${paso(1, 'Escribe el <b>nombre</b> de quien te compra')}
      ${paso(2, 'Toca el <b>tipo</b> de boleto')}
      ${paso(3, 'Dale a <b>GENERAR</b> — se descarga solo')}
      ${paso(4, '<b>Mándaselo por WhatsApp</b>. Esa imagen es su boleto')}
    </div>`;

  const dudas =
    duda('¿Qué es el reloj de arriba?',
         'Los días que faltan para que <b>suban los precios</b>. Enséñaselo: <i>"cómpralo hoy, que el martes sube"</i>.') +
    (conFac.length ? duda('¿Cuándo pido la facultad?',
         `Solo con <b>${conFac.join(' o ')}</b>. El sistema te la pide solo.`) : '') +
    duda('¿Cómo hago un grupo de 10?',
         'Botón <b>Armar grupo de 10</b>: escribes los diez nombres y marcas con la <b>★</b> al representante, que se lleva <b>botella gratis</b>.') +
    duda('Se me borró un boleto',
         'En <b>Ver mi historial</b> están todos. Búscalo por nombre y descárgalo otra vez.') +
    duda('¿Cuándo me pagan?',
         'Cobras el boleto completo. En el corte entregas y ahí se te descuenta tu comisión. Todo queda con fecha.') +
    duda('Se cayó el internet a media venta',
         'Dale a <b>GENERAR</b> otra vez sin miedo: el sistema sabe que es la misma venta y <b>no la duplica</b>.');

  modal(`<div class="h1" style="font-size:19px">Guía rápida</div>
    <div class="mt12">
      ${bloque('Qué incluye cada boleto', boletos, true)}
      ${bloque('Cómo vender', vender)}
      ${bloque('Dudas', dudas)}
    </div>
    <button class="btn mt16" onclick="closeModal()">Entendido</button>`);
}
$('#btn-ayuda').addEventListener('click', mostrarAyuda);

/* ---------------- tutorial de bienvenida (una sola vez) ----------------
   No es un texto que describe la pantalla: es la pantalla misma. Se oscurece todo,
   se ilumina EL botón del que se está hablando y al lado sale una frase corta. El
   vendedor no tiene que traducir "el botón naranja de abajo" a nada — lo está
   viendo señalado.

   Se marca como visto en el SERVIDOR al terminarlo, así que cambiar de celular no
   se lo vuelve a poner, y cerrar la app a medias sí. */
const TOUR = [
  { sel: '#f-buyer',      txt: 'Aquí escribes el <b>nombre</b> de quien te compra.' },
  { sel: '#f-types',      txt: 'Aquí eliges el <b>tipo</b> de boleto.' },
  { sel: '#btn-generate', txt: 'Le das aquí y <b>el boleto se descarga solo</b>. Mándaselo por WhatsApp: esa imagen es su boleto.' },
  { sel: '#btn-group-10', txt: 'Si son <b>10 juntos</b>, por aquí. Al representante le va botella gratis.' },
  { sel: '#f-phase-timer',txt: 'Este reloj dice cuándo <b>suben los precios</b>. Enséñaselo para cerrar la venta.' },
];

function cerrarTour(marcar) {
  const c = $('#tour');
  if (c) c.remove();
  document.body.style.overflow = '';
  if (marcar) API.post('/api/tutorial-visto').catch(() => {});
}

function mostrarTour(i = 0) {
  // se saltan los que no estén en pantalla (ej. el grupo con las ventas cerradas)
  while (i < TOUR.length) {
    const e = $(TOUR[i].sel);
    if (e && e.offsetParent !== null) break;
    i++;
  }
  if (i >= TOUR.length) return cerrarTour(true);

  const paso = TOUR[i], el = $(paso.sel);
  el.scrollIntoView({ block: 'center', behavior: 'instant' });

  let c = $('#tour');
  if (!c) {
    c = document.createElement('div');
    c.id = 'tour';
    c.innerHTML = '<div class="tr-foco"></div><div class="tr-globo"></div>';
    document.body.appendChild(c);
    document.body.style.overflow = 'hidden';
  }
  const r = el.getBoundingClientRect(), pad = 7;
  const foco = c.querySelector('.tr-foco');
  foco.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;` +
    `width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;

  // Solo cuentan las paradas cuyo elemento está en pantalla: si el grupo o el reloj
  // no salen, ni el contador ni los puntos deben prometer paradas que no van a venir.
  const visibles = TOUR.filter(x => { const e = $(x.sel); return e && e.offsetParent !== null; });
  const total = visibles.length;
  const nEste = TOUR.slice(0, i + 1).filter(x => { const e = $(x.sel); return e && e.offsetParent !== null; }).length;
  const ultimo = i === TOUR.length - 1 || nEste === total;

  const globo = c.querySelector('.tr-globo');
  globo.innerHTML = `<div class="tr-num">${nEste} de ${total}</div>
    <div class="tr-txt">${paso.txt}</div>
    <div class="tr-pie">
      <div class="tr-dots">${visibles.map((_, k) =>
        `<span class="tr-dot${k < nEste ? ' on' : ''}"></span>`).join('')}</div>
      <button class="btn sm" id="tr-next" style="width:auto;padding:11px 20px">
        ${ultimo ? 'Listo' : 'Siguiente ›'}</button>
    </div>`;

  // El globo va donde quepa, y el PICO apunta al elemento: sin él, el globo parece
  // un aviso suelto y no queda claro de qué está hablando.
  const alto = globo.offsetHeight || 150;
  const cabeAbajo = r.bottom + 16 + alto < window.innerHeight;
  globo.className = 'tr-globo ' + (cabeAbajo ? 'abajo' : 'arriba');
  globo.style.top = cabeAbajo ? (r.bottom + 16) + 'px'
                              : Math.max(10, r.top - 16 - alto) + 'px';
  // el pico se alinea con el centro del elemento, sin salirse del globo
  const g = globo.getBoundingClientRect();
  const cx = Math.min(Math.max(r.left + r.width / 2, g.left + 22), g.right - 22);
  globo.style.setProperty('--pico', (cx - g.left) + 'px');

  $('#tr-next').onclick = () => ultimo ? cerrarTour(true) : mostrarTour(i + 1);
}

/* Directo al recorrido: sin pantalla de bienvenida. La primera parada ya saluda
   sola —oscurece todo y señala el campo del nombre— y nadie quería leer un saludo
   antes de eso. */
function mostrarTutorial() { setTimeout(() => mostrarTour(0), 400); }
