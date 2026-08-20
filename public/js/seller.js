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
  // Estando dentro del grupo NO se vuelve a mostrar el formulario individual:
  // el grupo es otra pantalla, no algo que se abre debajo. Si se re-mostrara,
  // quedarían los dos a la vez y el vendedor no sabría en cuál está escribiendo.
  const enGrupo = !!GROUP_SIZE;
  ['#mode-individual', '#group-switch', '#btn-generate', '#f-phase-timer'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    if (cerradas || enGrupo) el.classList.add('hidden');
    else if (sel !== '#f-phase-timer') el.classList.remove('hidden');
  });
  if (cerradas) $('#f-hint').textContent = 'El corte ya se hizo';
  else if (!enGrupo) $('#f-hint').textContent = '';
  return cerradas;
}

function renderTypes() {
  const box = $('#f-types');
  box.innerHTML = '';
  CATALOG.types.forEach(t => {
    const el = document.createElement('div');
    el.className = 'typeopt' + (SELECTED_TYPE === t.id ? ' sel' : '');
    // En venta flash el botón enseña los DOS números: el vendedor no tiene que
    // acordarse de cuánto costaba antes para poder decir cuánto se está ahorrando.
    const enFlash = t.normal_cents && t.normal_cents > t.price_cents;
    const priceLabel = t.price_cents > 0
      ? (enFlash
          ? `<span class="tantes">${fmtMoney(t.normal_cents / 100)}</span> ${fmtMoney(t.price_cents / 100)}`
          : fmtMoney(t.price_cents / 100))
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

// ¿Estamos en venta flash? Lo dice el catálogo: si un tipo trae normal_cents es
// porque su precio de hoy está por debajo del que regiría sin el flash.
function flashActivo() {
  const t = (CATALOG.types || []).filter(x => x.normal_cents && x.normal_cents > x.price_cents);
  if (!t.length) return null;
  const ahorro = Math.max(...t.map(x => (x.normal_cents - x.price_cents) / 100));
  // el nombre de la fase EN CURSO (no la que viene): si el admin la llamó "Fase 2
  // Flash", el vendedor tiene que poder decir en cuál está cuando le pregunten
  return { nombre: t[0].phase || 'Venta flash', ahorroMax: ahorro };
}

function renderPhaseTimer() {
  const box = $('#f-phase-timer');
  const fmanual = CATALOG.flash_manual && flashActivo();
  // Una venta flash prendida a mano se apaga cuando el organizador quiera: NO tiene
  // hora de fin. Enseñar un reloj sería prometerle al comprador un plazo que no
  // existe —y peor, uno más largo del real—. Se dice lo que sí es cierto: está
  // activa ahora, y puede terminar en cualquier momento.
  if (fmanual) {
    const vuelve = (CATALOG.types || []).filter(t => t.normal_cents > t.price_cents)
      .map(t => `<span>${esc(t.name)}<b>${fmtMoney(t.normal_cents / 100)}</b></span>`).join('');
    box.classList.remove('hidden'); box.classList.add('flash'); box.classList.remove('urge');
    box.innerHTML = `<div class="pt-flash">⚡ ${esc(fmanual.nombre)} · hasta $${fmanual.ahorroMax.toFixed(0)} de descuento</div>
      <div class="pt-ahora">Precios de oferta · solo mientras dure</div>
      <div class="pt-vuelve">Después vuelve a</div>
      <div class="pt-items">${vuelve}</div>`;
    return;
  }
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

  // En flash el reloj cambia de sentido: no cuenta para que "suban", cuenta para que
  // se ACABE la oferta. Es el mismo dato pero el argumento de venta es el contrario.
  const fl = flashActivo();
  box.classList.remove('hidden');
  box.classList.toggle('urge', urge);
  box.classList.toggle('flash', !!fl);
  // En flash NO se nombra la fase que viene: al vendedor no le sirve saber que
  // después entra "Fase 1", le sirve saber que la oferta se acaba. Y los precios de
  // abajo dejan de ser "los nuevos" para ser "a lo que vuelve".
  box.innerHTML =
    (fl ? `<div class="pt-flash">⚡ ${esc(fl.nombre)} · hasta $${fl.ahorroMax.toFixed(0)} de descuento</div>` : '')
    + `<div class="pt-head">
       <span class="pt-sub">${fl ? 'La oferta termina en' : 'Los precios suben'}</span>
       ${fl ? '' : `<span class="pt-fase">${esc(g.name)}</span>`}
     </div>
     <div class="pt-clock">${reloj}</div>
     ${fl ? '<div class="pt-vuelve">Después vuelve a</div>' : ''}
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
/* El pulso. Cada pocos segundos se pregunta lo mínimo —¿hay venta flash?, ¿ya
   cerraron?— y solo si cambió se recarga el catálogo entero.

   Va aparte del refresco lento y NO se salta aunque el vendedor esté a medio
   escribir un nombre: las dos cosas que consulta le cambian el número que va a
   decir en voz alta. Antes había que refrescar a mano para ver el precio nuevo, y
   un teléfono que no cierra el navegador en todo el día se quedaba con el de la
   mañana. */
async function pulso() {
  if (!API.token || !CATALOG) return;
  try {
    const e = await API.get('/api/estado');
    const cambioCierre = !!e.ventas_cerradas !== !!CATALOG.ventas_cerradas;
    const cambioFlash = !!e.flash_manual !== !!CATALOG.flash_manual;
    if (!cambioCierre && !cambioFlash) return;
    const c = await API.get('/api/catalog');
    CATALOG = c;
    if (cambioCierre) {
      if (aplicarCierre()) toast('El organizador cerr\u00f3 las ventas');
      return;
    }
    renderTypes(); renderPhaseTimer();
    if (GROUP_SIZE) {
      // el tipo elegido guarda su precio: hay que releerlo del catálogo nuevo o la
      // barra seguiría enseñando el de antes
      if (GROUP_TYPE) GROUP_TYPE = tiposDeGrupo().find(t => t.id === GROUP_TYPE.id) || null;
      renderGroupPriceBar();
    }
    toast(c.flash_manual ? '\u26a1 Empez\u00f3 la venta flash: precios nuevos'
                         : 'Termin\u00f3 la venta flash: precios normales');
  } catch (_) { /* se reintenta en el siguiente tick */ }
}
setInterval(pulso, 5000);
// al volver a la pantalla se pregunta ya, sin esperar el tick: el teléfono estuvo
// dormido en el bolsillo y ahí es justo cuando el precio pudo haber cambiado
document.addEventListener('visibilitychange', () => { if (!document.hidden) pulso(); });
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
let GROUP_TYPE = null;      // el tipo del grupo: Externo, VIP o Ultra VIP

// El tipo se elige ANTES de escribir los diez nombres. Los grupos se piden en las
// tres categorías —"vamos 10 en VIP con botella"— y antes salían todos como
// Externo: se vendía uno y se generaba otro.
function tiposDeGrupo() {
  return (CATALOG.group && CATALOG.group.tipos) || [];
}

function enterGroupMode(size) {
  if (!CATALOG.group) {
    toast('El precio de grupo aún no está configurado. Pídele al admin que lo defina.');
    return;
  }
  const tipos = tiposDeGrupo();
  GROUP_SIZE = size;
  GROUP_REP_IDX = null;
  GROUP_RESULT = null;
  // con un solo tipo disponible no hay nada que elegir: se entra directo
  GROUP_TYPE = GROUP_TYPE && tipos.some(t => t.id === GROUP_TYPE.id)
    ? GROUP_TYPE : (tipos.length === 1 ? tipos[0] : null);
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
  GROUP_SIZE = null; GROUP_REP_IDX = null; GROUP_RESULT = null; GROUP_TYPE = null;
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
  const tipos = tiposDeGrupo();
  const barra = $('#group-price-bar');
  // Todavía no eligió el tipo: en vez del precio, los tres botones.
  if (!GROUP_TYPE) {
    barra.innerHTML =
      `<div class="gp-line">¿De qué tipo es el grupo?</div>
       <div class="gt-ops">${tipos.map(t => {
         const enFlash = t.normal_cents && t.normal_cents > t.price_cents;
         return `<button type="button" class="gt-op" data-gt="${t.id}">
           <span class="gt-n">${esc(t.name)}</span>
           <span class="gt-p">${enFlash
             ? `<span class="f-antes">${fmtMoney(t.normal_cents / 100)}</span> ${fmtMoney(t.price_cents / 100)}`
             : fmtMoney(t.price_cents / 100)}</span></button>`;
       }).join('')}</div>
       <div class="gp-save">Los diez llevan el mismo tipo. Uno se lleva la botella.</div>`;
    $$('.gt-op').forEach(b => b.onclick = () => {
      GROUP_TYPE = tipos.find(t => String(t.id) === b.dataset.gt);
      renderGroupPriceBar(); renderGroupNames(); aplicarCierre();
    });
    return;
  }
  const p = GROUP_TYPE.price_cents;
  const enFlash = GROUP_TYPE.normal_cents && GROUP_TYPE.normal_cents > p;
  barra.innerHTML = `
    <div class="gp-line">Grupo de ${GROUP_SIZE} \u00b7 ${esc(GROUP_TYPE.name)}
      <button type="button" class="gt-cambiar" id="gt-cambiar">cambiar</button></div>
    <div class="gp-price">${enFlash
      ? `<span class="f-antes">${fmtMoney(GROUP_TYPE.normal_cents / 100)}</span> ${fmtMoney(p / 100)}`
      : fmtMoney(p / 100)} <span class="gp-cu">c/u</span></div>
    <div class="gp-save">Total ${fmtMoney(p * GROUP_SIZE / 100)} \u00b7 marca con ★ quién recoge la botella en la barra</div>`;
  const c = $('#gt-cambiar');
  if (c) c.onclick = () => { GROUP_TYPE = null; renderGroupPriceBar(); renderGroupNames(); aplicarCierre(); };
}

// cada integrante va en su propia tarjeta (borde + ficha numerada), para que
// se vean claramente separados y nunca se pierda de vista a cuál boleto
// corresponde cada nombre.
function renderGroupNames() {
  const box = $('#group-names');
  box.innerHTML = '';
  // Sin tipo elegido no se piden nombres: escribir diez y descubrir después que
  // faltaba elegir sería tirar el trabajo, y el botón de generar no sabría qué
  // boleto crear.
  const bg = $('#btn-generate-group');
  if (!GROUP_TYPE) { if (bg) bg.classList.add('hidden'); return; }
  if (bg && !(CATALOG && CATALOG.ventas_cerradas)) bg.classList.remove('hidden');
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
      rep.className = 'repbtn'; rep.type = 'button';
      rep.title = 'Este recoge la botella en la barra';
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
        if (await downloadTicket(r.tickets[Number(b.dataset.idx)], CATALOG)) {
          // marca el botón como "ya descargado" (check + relleno), para que el
          // vendedor sepa de un vistazo cuáles boletos del grupo le faltan
          b.innerHTML = CHECK_ICON;
          b.classList.add('grabbed');
          b.title = 'Ya descargado · toca para volver a descargarlo';
        }
      } finally { b.disabled = false; }
    });
  });
  const totalFinal = r.tickets.reduce((s, t) => s + t.price, 0);
  $('#group-result-bar').classList.remove('hidden');
  $('#group-result-bar').classList.add('done');
  $('#group-result-bar').innerHTML = `
    <div class="gp-line">¡Listo! Grupo de ${r.size} generado ✓</div>
    <div class="gp-price">${fmtMoney(totalFinal)} <span style="font-size:12px;color:var(--cream-45);font-weight:600">monto final</span></div>
    <div class="gp-save">El boleto de ${esc(r.representative || 'el representante')} lleva la ★: con ese recoge la botella en la barra</div>`;
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
      type_id: GROUP_TYPE ? GROUP_TYPE.id : null,
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
    try { bajo = await downloadTicket(r.ticket, CATALOG); } catch (_) {}
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
          <div class="u-meta">${esc(ticketTypeLabel(t))} \u00b7 ${precioConTachado(t)}${etiquetaFlash(t)}</div>
        </div>
        <button class="u-dl" id="solo-dl">${DL_ICON}<span>Descargar</span></button>
      </div>
    </div>`;
  if (bajoAutomatico) DOWNLOADED.add(t.id);
  const b = $('#solo-dl');
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (await downloadTicket(t, CATALOG)) {
        DOWNLOADED.add(t.id);
        toast('Boleto descargado otra vez');
      }
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

/* El precio de un boleto de venta flash: el de antes tachado y el cobrado. Se
   escribe una sola vez porque aparece en tres sitios —el último boleto, el
   historial y el boleto que se descarga— y si cada uno lo arma por su cuenta,
   tarde o temprano uno se queda sin el tachado y el vendedor no sabe cuál creer. */
function precioConTachado(t) {
  if (!(t.normal_price > t.price)) return fmtMoney(t.price);
  return `<span class="f-antes">${fmtMoney(t.normal_price)}</span> ${fmtMoney(t.price)}`;
}
function etiquetaFlash(t) {
  return t.normal_price > t.price
    ? `<span class="f-flash">\u26a1 ${esc(t.phase_name || 'Venta flash')}</span>` : '';
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
          <div class="tmeta">${esc(t.type_name)} · ${esc(fmtDate(t.created_at))}${etiquetaFlash(t)}</div>
        </div>
        <div class="tprice">${precioConTachado(t)}</div>`;
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
            if (await downloadTicket(t, CATALOG)) {
              toast('Boleto descargado');
              DOWNLOADED.add(t.id);
              b.innerHTML = CHECK_ICON;
              b.classList.add('grabbed');
              b.title = 'Ya descargado · toca para volver a descargarlo';
            }
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
  try { if (await downloadTicket(LAST_TICKET, CATALOG)) toast('Boleto descargado ✓'); }
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
   VIP, por ejemplo), su tarjeta se marca PRÓXIMAMENTE en vez de mentir con uno viejo. */
function precioDe(incluye, excluye = []) {
  const hay = (CATALOG && CATALOG.types || []).filter(t => {
    const n = (t.name || '').toLowerCase().replace(/\s+/g, '');
    return incluye.some(k => n.includes(k)) && !excluye.some(k => n.includes(k));
  });
  if (!hay.length) return '';
  return [...new Set(hay.map(t => '$' + (t.price_cents / 100).toFixed(0)))].join(' · ');
}

/* Cada nivel es una TARJETA con su propio color: gris el general, ámbar el VIP,
   oro el Ultra. Los beneficios van en pastillas, no en párrafo: el ojo los cuenta
   sin leerlos, y de un vistazo se ve que el VIP trae el doble que el de abajo.
   Eso es lo que vende — una lista corrida de puntos no deja ver la diferencia. */
function tarjeta(clase, titulo, precio, arrastra, perks) {
  const proximo = !precio;
  return `<div class="tk ${clase}${proximo ? ' proximo' : ''}">
    <div class="tk-top">
      <div class="tk-n">${titulo}</div>
      ${proximo ? '<div class="tk-soon">Próximamente</div>'
                : `<div class="tk-p">${precio}</div>`}
    </div>
    ${arrastra ? `<div class="tk-mas">${arrastra}</div>` : ''}
    <div class="tk-perks">${perks.map(x => `<span>${x}</span>`).join('')}</div>
  </div>`;
}

function paso(n, texto) {
  return `<div class="g-item"><div class="g-n">${n}</div><div class="g-tit">${texto}</div></div>`;
}
function duda(preg, resp) {
  return `<details class="faq"><summary>${preg}</summary><div>${resp}</div></details>`;
}

function panelBoletos() {
  return tarjeta('gen', 'UADY / Externo', precioDe(['uady', 'externo']), '',
           ['Barra libre toda la noche', 'Aguas locas', 'Shots', 'Sin fichas ni límite']) +
         tarjeta('vip', 'VIP', precioDe(['vip'], ['ultra']), 'Todo lo anterior, más:',
           ['Sin fila para entrar', '2ª barra solo VIP', 'Botellas exclusivas',
            'Coca sin límite', 'Shot de bienvenida', 'Pulsera VIP']) +
         tarjeta('ultra', 'Ultra VIP', precioDe(['ultra']), 'Todo lo del VIP, más:',
           ['Zona propia', '3ª barra solo tuya', 'Botellas top', 'Margaritas y palomas']);
}

function panelVender() {
  return `<div class="guia">
    ${paso(1, 'Escribe el <b>nombre</b> de quien te compra')}
    ${paso(2, 'Toca el <b>tipo</b> de boleto')}
    ${paso(3, 'Dale a <b>GENERAR</b> — se descarga solo')}
    ${paso(4, '<b>Mándaselo por WhatsApp</b>. Esa imagen es su boleto')}
  </div>`;
}

function panelDudas() {
  const conFac = (CATALOG && CATALOG.types || [])
    .filter(t => t.needs_faculty).map(t => esc(t.name));
  return duda('¿Qué es el reloj de arriba?',
         'Los días que faltan para que <b>suban los precios</b>. Enséñaselo: <i>"cómpralo hoy, que el martes sube"</i>.') +
    (conFac.length ? duda('¿Cuándo pido la facultad?',
         `Solo con <b>${conFac.join(' o ')}</b>. El sistema te la pide solo.`) : '') +
    duda('¿Cómo hago un grupo de 10?',
         '<b>1.</b> Toca <b>Armar grupo de 10</b>.<br>' +
         '<b>2.</b> Escribe los <b>diez nombres</b>, uno por persona.<br>' +
         '<b>3.</b> Toca la <b>★</b> junto a uno: ese es el representante.<br>' +
         '<b>4.</b> Genera. Salen los diez boletos de un jalón.') +
    duda('¿Para qué es la ★ del grupo?',
         'Marca <b>quién recoge la botella</b>. Su boleto sale con la estrella dorada: ' +
         'el día de la fiesta él va a la barra, la enseña y ahí se la entregan.<br><br>' +
         'Los otros nueve boletos no la traen, así que <b>nadie más puede reclamarla</b>. ' +
         'Por eso el sistema no te deja generar el grupo hasta que marques a uno — y ' +
         'conviene que sea alguien que <b>sí vaya a ir</b>.<br><br>' +
         'El grupo <b>no</b> tiene descuento: los diez pagan precio normal y el beneficio es la botella.') +
    duda('Se me borró un boleto',
         'En <b>Ver mi historial</b> están todos. Búscalo por nombre y descárgalo otra vez.') +
    duda('¿Cuándo me pagan?',
         'Cobras el boleto completo. En el corte entregas y ahí se te descuenta tu comisión. Todo queda con fecha.') +
    duda('Se cayó el internet a media venta',
         'Dale a <b>GENERAR</b> otra vez sin miedo: el sistema sabe que es la misma venta y <b>no la duplica</b>.');
}

/* Pestañas en vez de acordeones apilados: se ve TODO lo disponible de un golpe y
   se llega a cualquier cosa en un toque. Un acordeón esconde lo que tiene y obliga
   a abrir y cerrar hasta encontrar. */
const GUIA_TABS = [
  { id: 'bol', t: 'Boletos', fn: panelBoletos },
  { id: 'ven', t: 'Vender',  fn: panelVender },
  { id: 'dud', t: 'Dudas',   fn: panelDudas },
];

function pintaGuia(sel) {
  $('#gu-body').innerHTML = (GUIA_TABS.find(x => x.id === sel) || GUIA_TABS[0]).fn();
  $$('#gu-tabs .gu-tab').forEach(b => b.classList.toggle('on', b.dataset.g === sel));
}

function mostrarAyuda() {
  modal(`<div class="h1" style="font-size:19px">Guía rápida</div>
    <div class="gu-tabs mt12" id="gu-tabs">
      ${GUIA_TABS.map((x, i) =>
        `<button class="gu-tab${i ? '' : ' on'}" data-g="${x.id}">${x.t}</button>`).join('')}
    </div>
    <div id="gu-body" class="mt12"></div>
    <button class="btn mt16" onclick="closeModal()">Entendido</button>`);
  $('#gu-tabs').addEventListener('click', e => {
    const b = e.target.closest('.gu-tab');
    if (b) pintaGuia(b.dataset.g);
  });
  pintaGuia('bol');
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
  // El tour es de un vistazo, no un manual: dice QUÉ hace el botón y qué hace la
  // estrella, en un renglón. Lo demás vive en el "?", que se lee cuando hace falta.
  { sel: '#btn-group-10', txt: '¿Van <b>10 juntos</b>? Aquí. Marca <b>★</b> a uno: ese recoge la botella.' },
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
