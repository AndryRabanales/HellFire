/* OnFire — panel de administración */
API.init('onfire_admin_token');

let EV = null;              // datos del evento para render de boletos
let SELECTED_TYPE = null;
let CACHE = { sellers: [], types: [], faculties: [] };

function show(view) {
  $('#view-login').classList.toggle('hidden', view !== 'login');
  $('#view-panel').classList.toggle('hidden', view !== 'panel');
}

function guard(e) {
  if (e.data && e.data._unauthorized) {
    API.setToken(null); show('login'); toast('Tu sesión terminó'); return true;
  }
  return false;
}

/* ---------------- login ---------------- */
async function login() {
  $('#lg-err').textContent = '';
  try {
    const r = await API.post('/api/admin/login', {
      username: $('#lg-user').value.trim(), password: $('#lg-pass').value,
    });
    API.setToken(r.token);
    await enter(r.username);
  } catch (e) { $('#lg-err').textContent = e.message; }
}

let ME_ID = null;   // id del admin con sesión (para saber qué es "mío")
async function enter(name) {
  EV = await API.get('/api/catalog');
  try { ME_ID = (await API.get('/api/me')).admin_id ?? null; } catch (_) {}
  $('#who').textContent = name;
  $('#av').textContent = (EV.event_name || 'O')[0];
  $('#lg-name').textContent = EV.event_name;
  show('panel');
  openTab('resumen');
}

/* ---------------- tabs ---------------- */
/* Un error de JavaScript ya no se queda callado. Un tropiezo en una pantalla dejaba
   botones sin función y secciones vacías, y desde fuera parecía que "no funciona"
   sin ninguna pista de por qué. */
window.addEventListener('error', e => {
  console.error('fallo en pantalla:', e.error || e.message);
  if (typeof toast === 'function') toast('Algo falló en la pantalla: ' + (e.message || ''));
});

const loaders = {
  resumen: loadSummary, boletos: loadTicketsTab, movimientos: loadMovements,
  vendedores: loadSellers, ranking: loadRanking, rendimiento: loadRendimiento,
  grupos: loadGroups, gastos: loadExpenses,
  colideres: loadColideres, cortesias: loadCortesias,
  catalogos: loadCatalogs, ajustes: loadAjustes,
};

let currentTab = 'resumen';
function openTab(name) {
  currentTab = name;
  $$('#tabs .tab').forEach(t => t.classList.toggle('sel', t.dataset.tab === name));
  $$('section[id^="tab-"]').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + name));
  loaders[name]().catch(e => { if (!guard(e)) toast(e.message); });
  startLive();
}
$('#tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab');
  if (t) openTab(t.dataset.tab);
});

/* ---------------- actualización en vivo (sin recargar la página) ----------------
   Cada pocos segundos re-consulta la pestaña visible y actualiza solo si algo cambió
   (nuevos boletos, ingresos, anulaciones). Se pausa si la pestaña del navegador no
   está activa, para no gastar de más. */
let liveTimer = null;
const LIVE = { resumen: loadSummary, boletos: loadTicketsTable,
               movimientos: loadMovements, vendedores: loadSellers,
               cortesias: loadCortesias, ranking: loadRanking,
               // Catálogos se mira solo por la venta flash: si otro admin la prende
               // desde su teléfono, esta pantalla no puede seguir diciendo "apagada"
               // y ofrecer un botón que hace lo contrario de lo que se lee.
               catalogos: loadFlash };
function startLive() {
  stopLive();
  const fn = LIVE[currentTab];
  if (!fn) return;
  liveTimer = setInterval(() => {
    if (document.hidden) return;
    fn(true).catch(() => {});   // true = silencioso (solo actualiza si cambió)
  }, 4000);
}
function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
document.addEventListener('visibilitychange', () => { if (!document.hidden) startLive(); });

/* ---------------- modal ---------------- */
function modal(html) {
  $('#modal').innerHTML = html;
  $('#modal-bg').classList.remove('hidden');
}
function closeModal() { $('#modal-bg').classList.add('hidden'); }
$('#modal-bg').addEventListener('click', e => { if (e.target.id === 'modal-bg') closeModal(); });

function confirmModal({ title, body, okLabel, danger, withReason }) {
  return new Promise(resolve => {
    modal(`
      <div class="h1" style="font-size:18px">${title}</div>
      <div class="muted mt8" style="font-size:13px;line-height:1.5">${body}</div>
      ${withReason ? '<div class="label mt12">Motivo</div><input class="input" id="cm-reason" placeholder="Ej. pago no recibido">' : ''}
      <div class="err mt8" id="cm-err"></div>
      <div class="row mt16">
        <button class="btn ghost grow" id="cm-no">Cancelar</button>
        <button class="btn ${danger ? 'danger' : ''} grow" id="cm-yes">${okLabel || 'Confirmar'}</button>
      </div>`);
    $('#cm-no').onclick = () => { closeModal(); resolve(null); };
    $('#cm-yes').onclick = () => {
      if (withReason) {
        const reason = $('#cm-reason').value.trim();
        if (!reason) { $('#cm-err').textContent = 'El motivo es obligatorio'; return; }
        closeModal(); resolve({ reason });
      } else { closeModal(); resolve({}); }
    };
  });
}

/* ---------------- resumen ---------------- */
let _sigSummary = '';
async function loadSummary(silent) {
  const s = await API.get('/api/admin/summary');
  const sig = JSON.stringify(s);
  if (silent && sig === _sigSummary) return;   // nada cambió → no re-dibujar
  _sigSummary = sig;
  aplicarColider(s.soy_colider);
  // la guía del colíder, una sola vez: se la pone el servidor, así que cambiar de
  // teléfono no se la repite y cerrar el panel a medias sí
  if (s.soy_colider && s.tutorial_pendiente && !$('#tour')) setTimeout(tourColider, 700);
  // los precios y la fase que viene salen del catálogo: se pide una vez, para que el
  // "?" pueda decir cuándo suben en vez de mandarlo a preguntar
  if (s.soy_colider && !GUIA_CAT) API.get('/api/catalog').then(c => { GUIA_CAT = c; }).catch(() => {});
  $('#sum-stats').innerHTML = `
    <div class="stat"><div class="sk">Boletos vendidos</div><div class="sv">${s.total_tickets}</div></div>
    <div class="stat"><div class="sk">Monto total</div><div class="sv">${fmtMoney(s.total)}</div></div>
    <div class="stat"><div class="sk">Cobrado a vendedores</div><div class="sv">${fmtMoney(s.collected)} <small>de ${fmtMoney(s.total)}</small></div></div>
    <div class="stat"><div class="sk">Ya ingresaron</div><div class="sv">${s.entered} <small>de ${s.total_tickets}</small></div></div>`;
  // desglose de cobranza por admin
  $('#sum-by-admin').innerHTML = (s.by_admin || []).map(a => {
    const falta = a.sold - a.collected;
    const estado = a.sold <= 0
      ? '<span class="muted">sin ventas</span>'
      : (falta <= 0 ? '<span class="badge active">al día</span>'
                    : `<span class="badge used">falta ${fmtMoney(falta)}</span>`);
    return `<div style="padding:9px 0;border-bottom:1px solid rgba(255,120,40,.1)">
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px">
        <div style="font:700 13px Manrope">${esc(a.admin)}</div>
        <div>${estado}</div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:3px">cobró <b style="color:var(--cream)">${fmtMoney(a.collected)}</b> de <b>${fmtMoney(a.sold)}</b></div>
    </div>`;
  }).join('') || '<div class="muted">Sin datos aún</div>';
}

/* ------------------------------------------------ el interruptor de la venta flash

   Vive en Catálogos, junto a los precios: es un precio, no un reporte. Prenderla
   tiene que ser un toque, no inventar una fase con la fecha de hoy. El precio NO se escribe cada vez: cada fase guarda el
   suyo, así que el botón cobra el flash DE LA FASE QUE ESTÉ CORRIENDO —se prende en
   Fase 1 y sale el de Fase 1, se prende en Fase 4 y sale el de Fase 4—, y apagar y
   volver a prender no lo mueve. La tabla enseña eso ANTES de prender. */
let _flashSig = null;
async function loadFlash(silent) {
  if (document.body.classList.contains('es-colider')) return;
  let e;
  try { e = await API.get('/api/admin/flash'); }
  catch (err) { return; }   // un colíder no lo ve: su 401 no debe romper el resumen
  const sig = JSON.stringify(e);
  if (silent && sig === _flashSig) return;
  _flashSig = sig;
  renderFlash(e);
}

function renderFlash(e) {
  const card = $('#fl-card');
  if (!card) return;
  card.classList.toggle('flash-on', !!e.activa);
  const listos = (e.filas || []).filter(f => f.listo);
  $('#fl-estado').innerHTML = e.activa
    ? `<b style="color:#f3d27a">ACTIVA ahora mismo</b> · ${listos.length} tipo(s) con descuento`
    : (listos.length
        ? 'Apagada · los precios de abajo se aplican en cuanto la prendas'
        : 'Apagada · primero escribe a cuánto queda cada boleto');
  const btn = $('#fl-toggle');
  btn.textContent = e.activa ? 'TERMINAR VENTA FLASH' : '⚡ PRENDER VENTA FLASH';
  btn.className = e.activa ? 'btn danger' : 'btn';
  btn.style.width = 'auto';
  btn.disabled = !e.activa && !listos.length;
  btn.onclick = async () => {
    $('#fl-err').textContent = '';
    btn.disabled = true;
    try { renderFlash(await API.post('/api/admin/flash', { activa: !e.activa })); }
    catch (err) { $('#fl-err').textContent = err.message || 'No se pudo'; btn.disabled = false; }
  };
  // La tabla es el "antes de prender": en qué fase va cada tipo, a cuánto se vende
  // hoy y a cuánto quedaría. Con la flash encendida el precio de flash es el que se
  // está cobrando, así que se marca al revés.
  $('#fl-tabla').innerHTML = (e.filas || []).map(f => `
    <div class="fl-row${f.listo ? '' : ' sin'}">
      <div class="fl-t">${esc(f.type_name)}
        <span class="fl-fase">${f.phase_name ? esc(f.phase_name)
          : 'precio de hoy · aún no arranca ninguna fase'}</span></div>
      <div class="fl-p">
        <span class="${e.activa && f.listo ? 'fl-tachado' : 'fl-normal'}">${fmtMoney(f.normal)}</span>
        ${f.listo ? `<span class="fl-flash">${fmtMoney(f.flash)}</span>
                     <span class="fl-ahorro">-${fmtMoney(f.ahorro)}</span>` : ''}
      </div>
      <input class="input fl-in" type="number" min="0" step="1"
             data-tid="${f.type_id}" value="${f.flash != null ? f.flash : ''}"
             placeholder="$ flash">
    </div>`).join('');
  $$('#fl-tabla .fl-in').forEach(inp => {
    inp.onchange = async () => {
      $('#fl-err').textContent = '';
      try {
        renderFlash(await API.put('/api/admin/flash',
          { precios: { [inp.dataset.tid]: inp.value.trim() } }));
      } catch (err) {
        $('#fl-err').textContent = err.message || 'No se pudo guardar';
        loadFlash();
      }
    };
  });
}

/* El panel visto por un colíder: se le quitan de encima las pestañas que no le
   tocan. Esconder botones no es la seguridad —esa está en el servidor, que le
   responde 401 a todo lo que no le corresponde— pero un panel lleno de puertas
   cerradas invita a empujarlas. */
let _coliderAplicado = null;
function aplicarColider(esCo) {
  if (_coliderAplicado === !!esCo) return;
  _coliderAplicado = !!esCo;
  document.body.classList.toggle('es-colider', !!esCo);
  // Se ESCONDE, no se borra: si en la misma pestaña entra después un admin, tiene que
  // recuperar su panel completo sin recargar. Borrar nodos deja el panel mutilado.
  const VEDADAS = ['grupos', 'gastos', 'catalogos', 'ajustes', 'cortesias'];
  VEDADAS.forEach(t => {
    const b = document.querySelector(`#tabs .tab[data-tab="${t}"]`);
    if (b) b.classList.toggle('hidden', esCo);
  });
  const mio = document.querySelector('#tabs .tab[data-tab="colideres"]');
  if (mio) mio.textContent = esCo ? 'Mi grupo' : 'Colíderes';
  const scan = document.querySelector('a[href="/scan"]');   // escanear quema boletos
  if (scan) scan.classList.toggle('hidden', esCo);
  const card = $('#sum-by-admin');
  if (card && card.closest('.card')) card.closest('.card').classList.toggle('hidden', esCo);
  // El colíder no prende ni apaga la venta flash: le cambiaría el precio a TODO el
  // evento, no solo a su grupo. El servidor ya se lo niega; aquí se le quita de la
  // vista para que no lo intente.
  const fl = $('#fl-card');
  if (fl) fl.classList.toggle('hidden', esCo);
  // el "?" es para el colíder: la ayuda está escrita para quien maneja un grupo
  const ay = $('#btn-ayuda-cl');
  if (ay) ay.classList.toggle('hidden', !esCo);
  // El colíder ve SOLO sus propios movimientos; decirle "todo lo que pasa en el
  // sistema" lo dejaría creyendo que el registro está incompleto o roto.
  MV_QUIEN = 'todos'; _sigMoves = '';   // si cambia quién entra, el filtro arranca limpio
  const mvi = $('#mv-intro');
  if (mvi) mvi.textContent = esCo
    ? 'Lo que tú has hecho: anulaciones, cobros, altas y bajas de tu grupo. El organizador también lo ve.'
    : 'Todo lo que pasa en el sistema. Lo ven todos los administradores.';
  if (esCo && VEDADAS.includes(currentTab)) openTab('resumen');
}

/* ---------------- la guía del colíder, en el "?" ----------------
   La del tour son cinco renglones para arrancar. Esta es para consultarla: lo que
   pregunta un colíder a media semana —de dónde sale mi 20%, a quién le entrego, qué
   pasa si mi vendedor no paga, cuándo suben los precios—. Se lee en partes para no
   soltarle un muro de texto. */
const GUIA_CL = [
  { id: 'gente', t: 'Tu equipo', fn: guiaEquipo },
  { id: 'corte', t: 'Tu 20%',    fn: guiaCorte },
  { id: 'prec',  t: 'Precios',   fn: guiaPrecios },
  { id: 'dud',   t: 'Dudas',     fn: guiaDudasCL },
];
let GUIA_CAT = null;   // el catálogo, para poder decir la próxima fase y su fecha

function bloqueG(t, txt) {
  return `<div class="gu-b"><div class="gu-t">${t}</div><div class="gu-x">${txt}</div></div>`;
}

function guiaEquipo() {
  return bloqueG('Darles de alta',
      'En <b>Vendedores → + Crear</b>. Sale un código de 5 dígitos: ese es con el que '
      + 'entra a vender. Cópialo y mándaselo; no se vuelve a mostrar solo.')
    + bloqueG('Cobrarles',
      'En su fila, <b>Cuenta</b>. Escribes cuánto de su deuda está cubriendo y queda '
      + 'registrado con fecha. Tu gente entrega el <b>100%</b> de lo que vendió: '
      + 'no se queda comisión.')
    + bloqueG('Pagarles',
      'En esa misma cuenta hay un bloque verde para darles su parte, con el atajo del '
      + '10%. Sale de <b>tu</b> comisión y queda anotado, así nadie discute después '
      + 'quién cobró cuánto.')
    + bloqueG('Anular y dar de baja',
      'Puedes <b>anular boletos</b> de tu gente y <b>darlos de baja</b> cuando ya no '
      + 'estén. Solo dentro de tu grupo, y queda firmado con tu nombre.')
    + bloqueG('Lo que NO puedes',
      'Cambiar precios, poner porcentajes, cambiarles el nombre o el código, '
      + 'escanear en la puerta, ni ver a vendedores de otro grupo.');
}

function guiaCorte() {
  return bloqueG('De dónde sale',
      'Es el <b>20%</b> de todo lo que junta tu grupo: lo que vendas tú y lo que '
      + 'vendan los tuyos, todo junto.')
    + bloqueG('Cuándo crece',
      'Cuando <b>COBRAS</b>, no cuando venden. Un boleto vendido y no pagado todavía '
      + 'no te genera nada; en cuanto entra el dinero, entra tu parte.')
    + bloqueG('A quién le entregas',
      'Al <b>organizador y a nadie más</b>. Tú juntas el dinero de tu gente, te '
      + 'quedas tu 20% y le entregas el resto. Ningún otro colíder ni admin te cobra.')
    + bloqueG('Repartir a los tuyos',
      'Lo decides tú. Lo que les des sale de tu 20%, y el panel te dice cuánto ya '
      + 'repartiste y cuánto te queda. No te deja dar más de lo que llevas ganado.')
    + bloqueG('Si ya te habían cortado antes',
      'Lo que cobraste como vendedor —con tu 10% de entonces— ya pagó lo suyo y no '
      + 'vuelve a contar para el 20%. De ahí en adelante, todo cuenta.');
}

function guiaPrecios() {
  const t = (GUIA_CAT && GUIA_CAT.types) || [];
  const hoy = t.filter(x => x.price_cents > 0)
    .map(x => `${esc(x.name)} <b>${fmtMoney(x.price_cents / 100)}</b>${
      x.normal_cents > x.price_cents ? ` <s>${fmtMoney(x.normal_cents / 100)}</s>` : ''}`)
    .join(' · ') || 'Todavía sin precios cargados.';
  // la fase que viene: la fecha más cercana entre todos los tipos
  const conFase = t.filter(x => x.next_phase);
  let prox = 'No hay otra fase programada: los precios se quedan como están.';
  if (conFase.length) {
    const f = conFase.map(x => x.next_phase.starts_on).sort()[0];
    const nombre = conFase.find(x => x.next_phase.starts_on === f).next_phase.name;
    const suben = conFase.filter(x => x.next_phase.starts_on === f)
      .map(x => `${esc(x.name)} <b>${fmtMoney(x.next_phase.price_cents / 100)}</b>`).join(' · ');
    const dias = Math.max(0, Math.round((new Date(f + 'T00:00:00') - new Date()) / 86400000));
    prox = `<b>${esc(nombre)}</b> arranca el <b>${esc(fechaCorta(f))}</b>`
         + (dias ? ` · faltan ${dias} día${dias === 1 ? '' : 's'}` : ' · <b>hoy</b>')
         + `<div style="margin-top:5px">Sube a: ${suben}</div>`;
  }
  const flash = (GUIA_CAT && GUIA_CAT.flash_manual);
  return bloqueG('Hoy se vende a', hoy)
    + bloqueG('La próxima fase', prox)
    + bloqueG('Venta flash', flash
      ? '<b style="color:#f3d27a">Está prendida ahora.</b> Se apaga cuando el '
        + 'organizador quiera: no hay hora fija. Aprovéchala mientras dure.'
      : 'Cuando el organizador la prende, los precios bajan al instante en el '
        + 'teléfono de todos y el boleto sale con el precio anterior tachado. '
        + 'No tienes que hacer nada.')
    + bloqueG('Un boleto no cambia de precio',
      'Cada boleto congela lo que costó al generarse. Si mañana suben los precios, '
      + 'el que ya vendiste sigue valiendo lo mismo y tu cuenta no se mueve.');
}

function guiaDudasCL() {
  return bloqueG('«Mi vendedor no me ha pagado»',
      'Su boleto ya cuenta como vendido y su cuenta lo marca en rojo. Tu 20% de ese '
      + 'dinero no existe hasta que él te pague — por eso conviene cobrar seguido.')
    + bloqueG('«Cobré de más o me equivoqué»',
      'En su cuenta puedes borrar el pago mal capturado, y el reparto también se '
      + 'deshace. Todo queda anotado en Movimientos, así que el rastro no se pierde.')
    + bloqueG('«¿Puedo ver quién le vendió a quién?»',
      'Sí. En <b>Boletos</b> están todos los de tu grupo con el nombre del comprador, '
      + 'y desde la cuenta de cada vendedor puedes ver los suyos.')
    + bloqueG('«Se me perdió el código de alguien»',
      'Está en <b>Vendedores</b>, en su fila. Si crees que se filtró, pídele al '
      + 'organizador que se lo cambie: sus boletos no se pierden.')
    + bloqueG('«¿Me pueden bajar el 20%?»',
      'No. El sistema no acepta menos de 20 para un colíder. Solo se puede subir.');
}

function mostrarAyudaCL() {
  modal(`<div class="h1" style="font-size:19px">Cómo funciona tu grupo</div>
    <div class="gu-tabs mt12" id="gu-tabs">
      ${GUIA_CL.map((x, i) =>
        `<button class="gu-tab${i ? '' : ' on'}" data-g="${x.id}">${x.t}</button>`).join('')}
    </div>
    <div id="gu-body" class="mt12 rd-scroll"></div>
    <button class="btn mt16" onclick="closeModal()">Entendido</button>`);
  $('#gu-tabs').addEventListener('click', e => {
    const b = e.target.closest('.gu-tab');
    if (b) pintaGuiaCL(b.dataset.g);
  });
  pintaGuiaCL('gente');
}

function pintaGuiaCL(sel) {
  $('#gu-body').innerHTML = (GUIA_CL.find(x => x.id === sel) || GUIA_CL[0]).fn();
  $$('#gu-tabs .gu-tab').forEach(b => b.classList.toggle('on', b.dataset.g === sel));
}

document.addEventListener('click', e => {
  if (e.target && e.target.id === 'btn-ayuda-cl') mostrarAyudaCL();
});

/* "hace 2 días" se lee de un vistazo; una fecha hay que restarla mentalmente. */
function haceCuanto(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d)) return '';
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 2) return 'ahorita';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const dias = Math.round(h / 24);
  return dias === 1 ? 'ayer' : `hace ${dias} días`;
}

/* ---------------- la guía del colíder (una sola vez) ----------------
   Igual que la del vendedor: se oscurece la pantalla, se ilumina de lo que se está
   hablando y al lado va una frase. No es un manual —son cinco renglones— y lo que
   explica es lo único que él necesita saber para arrancar: dónde da de alta a su
   gente, dónde les cobra, y de dónde sale su 20%. */
const TOUR_CL = [
  { sel: '#tabs .tab[data-tab="vendedores"]',
    txt: 'Aquí das de alta a <b>tu gente</b> y les generas su código.' },
  { sel: '#btn-sl-create', tab: 'vendedores',
    txt: 'Con <b>+ Crear</b>. El código que sale es con el que entra a vender.' },
  { sel: '#sl-body', tab: 'vendedores',
    txt: 'En <b>Cuenta</b> le cobras lo que vendió. Tu gente entrega el <b>100%</b>: no se queda comisión.' },
  { sel: '#tabs .tab[data-tab="colideres"]',
    txt: 'Aquí est\u00e1 <b>tu grupo</b>: lo que vendiste t\u00fa, lo de tu gente y tu corte.' },
  { sel: '#cl-lista', tab: 'colideres',
    txt: 'Tu corte es el <b>20%</b> de lo que junta el grupo. Sube cuando <b>cobras</b>, '
       + 'no cuando ellos venden. De ah\u00ed sale lo que les pagues.' },
];

function cerrarTourCL(marcar) {
  const c = $('#tour');
  if (c) c.remove();
  document.body.style.overflow = '';
  startLive();                       // se reanuda el refresco que se pausó
  if (marcar) API.post('/api/admin/tutorial-visto').catch(() => {});
}

async function tourColider(i = 0) {
  if (i >= TOUR_CL.length) return cerrarTourCL(true);
  // El panel se refresca solo cada 4 s. Con la guía encima, ese refresco volvía a
  // dibujar la lista de abajo y el recuadro iluminado quedaba señalando un elemento
  // que ya no existía: la pantalla se veía trabada. Se pausa mientras dure la guía.
  stopLive();
  const paso = TOUR_CL[i];
  // el paso puede vivir en otra pestaña: se abre y se espera a que pinte
  if (paso.tab && currentTab !== paso.tab) {
    openTab(paso.tab);
    await new Promise(r => setTimeout(r, 900));
  }
  const el = $(paso.sel);
  if (!el || el.offsetParent === null) return tourColider(i + 1);
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
  c.querySelector('.tr-foco').style.cssText =
    `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;

  const ultimo = i === TOUR_CL.length - 1;
  const globo = c.querySelector('.tr-globo');
  globo.innerHTML = `<div class="tr-num">${i + 1} de ${TOUR_CL.length}</div>
    <div class="tr-txt">${paso.txt}</div>
    <div class="tr-pie">
      <div class="tr-dots">${TOUR_CL.map((_, k) =>
        `<span class="tr-dot${k <= i ? ' on' : ''}"></span>`).join('')}</div>
      <button class="btn sm" id="tr-next" style="width:auto;padding:11px 20px">
        ${ultimo ? 'Listo' : 'Siguiente \u203a'}</button>
    </div>
    ${ultimo ? '' : '<button class="tr-skip" id="tr-skip">Saltar gu\u00eda</button>'}`;
  // una salida siempre a la vista: si algo se atora, nadie se queda encerrado
  const sk = $('#tr-skip');
  if (sk) sk.onclick = () => cerrarTourCL(true);
  const alto = globo.offsetHeight || 150;
  const cabeAbajo = r.bottom + 16 + alto < window.innerHeight;
  globo.className = 'tr-globo ' + (cabeAbajo ? 'abajo' : 'arriba');
  globo.style.top = cabeAbajo ? (r.bottom + 16) + 'px'
                              : Math.max(10, r.top - 16 - alto) + 'px';
  const g = globo.getBoundingClientRect();
  const cx = Math.min(Math.max(r.left + r.width / 2, g.left + 22), g.right - 22);
  globo.style.setProperty('--pico', (cx - g.left) + 'px');
  $('#tr-next').onclick = () => ultimo ? cerrarTourCL(true) : tourColider(i + 1);
}

/* ---------------- colíderes: el grupo, partido en dos ----------------
   Un solo número por grupo no sirve para decidir nada: si un colíder trae 200 mil,
   importa muchísimo si los vendió él o su equipo. Por eso van las dos mitades
   siempre visibles y el total abajo, no al revés. */
function bloqueCL(t, n, monto, extra) {
  return `<div style="flex:1;min-width:130px;background:rgba(255,255,255,.03);
      border:1px solid rgba(255,120,40,.13);border-radius:12px;padding:11px 12px">
    <div class="muted" style="font-size:10.5px;letter-spacing:.08em;text-transform:uppercase">${t}</div>
    <div style="font:800 19px Manrope;color:var(--cream);margin-top:3px">${fmtMoney(monto)}</div>
    <div class="muted" style="font-size:11.5px;margin-top:2px">${n} boleto${n === 1 ? '' : 's'}${extra ? ' · ' + extra : ''}</div>
  </div>`;
}

/* Con seis colíderes, una tarjeta enorme por cada uno convierte la pestaña en un
   pasillo. En la lista va lo que se mira a diario —cuánto trae el grupo y en qué va
   su corte— y el detalle completo, con su gente, se abre en su ventana. */
let CL_GRUPOS = [];

async function loadColideres() {
  const r = await API.get('/api/admin/grupos');
  // de mayor a menor: con seis grupos, el orden alfabético no dice nada
  CL_GRUPOS = (r.grupos || []).slice().sort((a, b) => b.total.monto - a.total.monto);
  if (!CL_GRUPOS.length) {
    $('#cl-lista').innerHTML = `<div class="card"><div class="label">Sin colíderes</div>
      <div class="muted mt8">Todavía no hay ninguno. Se crean desde <b style="color:var(--cream)">Ajustes → Administradores del panel</b>, eligiendo «Colíder».</div></div>`;
    return;
  }
  const tope = Math.max(1, ...CL_GRUPOS.map(g => g.total.monto));
  $('#cl-lista').innerHTML = CL_GRUPOS.map((g, i) => {
    const pctEl = g.total.monto ? Math.round(100 * g.propio.monto / g.total.monto) : 0;
    const activos = (g.miembros || []).filter(m => m.boletos > 0).length;
    return `
    <div class="cl-fila" data-g="${i}">
      <div class="cl-top">
        <div class="cl-nom">${esc(g.nombre)}
          <span>${activos} de ${g.miembros.length} vendiendo · ${g.total.boletos} boleto(s)</span></div>
        <div class="cl-monto">${fmtMoney(g.total.monto)}
          <small>${g.pct}% de la venta</small></div>
      </div>
      <div class="cl-bar" title="Naranja: lo que vendió él · gris: su equipo">
        <span class="el" style="width:${(g.total.monto ? g.propio.monto / g.total.monto : 0) * 100}%"></span>
        <span class="eq" style="width:${(g.total.monto ? g.equipo.monto / g.total.monto : 0) * 100}%"></span>
        <span class="resto" style="width:${100 - (g.total.monto / tope * 100)}%"></span>
      </div>
      <div class="cl-chips">
        ${g.ultimo_acceso ? `<span title="Última vez que entró al panel">entró ${esc(haceCuanto(g.ultimo_acceso))}</span>`
                          : '<span class="rojo">nunca ha entrado</span>'}
        <span>Él ${pctEl}%</span>
        <span>Equipo ${100 - pctEl}%</span>
        <span class="oro">Su corte ${g.comision_pct}% · ${fmtMoney(g.comision_ganada)}</span>
        ${g.le_queda > 0.005 ? `<span class="verde">Por repartir ${fmtMoney(g.le_queda)}</span>` : ''}
        <span class="ver">ver grupo ›</span>
      </div>
    </div>`;
  }).join('');
  $$('#cl-lista .cl-fila').forEach(f => {
    f.onclick = () => verColider(CL_GRUPOS[Number(f.dataset.g)]);
  });
}

/* La ventana del grupo: su corte, en qué va el reparto, y su gente uno por uno.
   Desde cada nombre se abre su cuenta, que es donde se le cobra y se le paga. */
function verColider(g) {
  if (!g) return;
  const venden = (g.miembros || []).filter(m => m.boletos > 0);
  const ceros = (g.miembros || []).filter(m => !m.boletos);
  const tope = Math.max(1, ...venden.map(m => m.monto));
  const pctEl = g.total.monto ? Math.round(100 * g.propio.monto / g.total.monto) : 0;
  modal(`
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px">
      <div style="min-width:0">
        <div class="h1" style="font-size:18px;line-height:1.2">${esc(g.nombre)}</div>
        <div class="muted" style="font-size:11.5px;margin-top:2px">Colíder ·
          ${g.miembros.length} en su equipo · ${g.pct}% de toda la venta</div>
        <div style="font:600 10.5px Manrope;margin-top:3px;color:${g.ultimo_acceso ? '#7ee0a0' : '#ff8a8a'}">
          ${g.ultimo_acceso ? '● Ya entró al panel · ' + esc(haceCuanto(g.ultimo_acceso))
                            : '● Todavía no entra al panel'}</div>
      </div>
      <div style="text-align:right">
        <div style="font:800 21px 'Space Grotesk';color:var(--cream)">${fmtMoney(g.total.monto)}</div>
        <div class="muted" style="font-size:10px">${g.total.boletos} boleto(s)</div>
      </div>
    </div>

    <div class="rd-dos mt16">
      <div><i>Vendió él</i><b>${fmtMoney(g.propio.monto)}</b>
        <span>${g.propio.boletos} boleto(s) · ${pctEl}%</span></div>
      <div><i>Vendió su equipo</i><b>${fmtMoney(g.equipo.monto)}</b>
        <span>${g.equipo.boletos} boleto(s) · ${100 - pctEl}%</span></div>
    </div>
    <div class="rd-split">
      <span class="rd-el" style="width:${pctEl}%"></span>
      <span class="rd-eq2" style="width:${100 - pctEl}%"></span>
    </div>

    <div class="cl-corte mt16">
      <div class="cl-ct">Su corte · ${g.comision_pct}% del grupo</div>
      <div class="cl-cg">
        <div><i>Ya juntó el grupo</i><b>${fmtMoney(g.comision_base)}</b></div>
        <div class="gana"><i>Le toca a él</i><b>${fmtMoney(g.comision_ganada)}</b></div>
        <div><i>Te entrega</i><b>${fmtMoney(g.entrega_al_admin)}</b></div>
      </div>
      <div class="cl-reparto">
        <span>Repartió a su equipo <b>${fmtMoney(g.repartido)}</b></span>
        <span class="cl-queda">Le quedan <b>${fmtMoney(g.le_queda)}</b></span>
      </div>
      ${g.ya_cortado > 0.005 ? `<div class="cl-antes">
        No entran ${fmtMoney(g.ya_cortado)} que ya se cortaron antes de que fuera
        colíder: ese dinero ya pagó su comisión.</div>` : ''}
      ${(g.repartos || []).length ? `
      <details class="cl-reps">
        <summary>Ver a quién le pagó (${g.repartos.length})</summary>
        <div>${g.repartos.map(p => `
          <div class="cl-rep">
            <span>${esc(p.name)}</span>
            <em>${esc(String(p.created_at).slice(5, 16))}</em>
            <b>${fmtMoney(p.amount)}</b>
          </div>`).join('')}</div>
      </details>` : ''}
    </div>

    <div class="label mt16" style="margin-bottom:6px">Su gente</div>
    <div class="rd-scroll">
      ${venden.length ? `<div class="rd-eq" style="border:none;padding-top:0">${venden.map(m => `
        <div class="rd-m cl-m" data-id="${m.id}" data-n="${esc(m.name)}" data-t="${m.monto}">
          <span class="rd-mn">${m.es_lider ? '<b class="rd-est">★</b> ' : ''}${esc(m.name)}
            <u>${m.ultima ? 'vendió ' + esc(haceCuanto(m.ultima)) : ''}</u></span>
          <span class="rd-mb"><i style="width:${Math.round(m.monto / tope * 100)}%"></i></span>
          <span class="rd-mv">${fmtMoney(m.monto)}<em>${m.boletos}</em></span>
        </div>`).join('')}</div>`
        : '<div class="muted" style="font-size:12px">Nadie del grupo ha vendido todavía.</div>'}
      ${ceros.length ? `<div class="rd-cerosbox">
        <div class="rd-cerost">${ceros.length} sin vender</div>
        <div>${ceros.map(m => esc(m.name)).join(' · ')}</div></div>` : ''}
    </div>
    <div class="muted" style="font-size:10.5px;margin-top:8px">Toca a cualquiera para
      abrir su cuenta: ahí se le cobra y se le paga.</div>
    <button class="btn mt16" onclick="closeModal()">Cerrar</button>`);
  $$('#modal .cl-m').forEach(f => {
    f.onclick = () => paySeller({ id: Number(f.dataset.id), name: f.dataset.n,
                                  total: Number(f.dataset.t) });
  });
}

/* ---------------- cortesías: los invitados del día del evento ----------------
   Aparte de la venta a propósito. Lo que se pregunta aquí no es cuánto entró, sino
   quién ya llegó — y eso, mezclado entre cientos de boletos vendidos, no se ve. */
let _ctFiltro = '', _sigCort = '';
async function loadCortesias(silent) {
  const r = await API.get('/api/admin/cortesias');
  const q = (($('#ct-q') && $('#ct-q').value) || '').trim().toLowerCase();
  const sig = JSON.stringify([_ctFiltro, q, r.cortesias.map(c => [c.id, c.used_at])]);
  if (silent && sig === _sigCort) return;
  _sigCort = sig;
  // Tres contadores en una tira, no tres tarjetas: en el celular las tarjetas se
  // apilan y hay que deslizar antes de ver al primer invitado.
  $('#ct-stats').innerHTML = [
    ['Invitados', r.total, 'var(--cream)'],
    ['Entraron', r.entraron, 'var(--ok,#7ee2a8)'],
    ['Faltan', r.faltan, 'var(--ember)'],
    ...(r.anuladas ? [['Anuladas', r.anuladas, 'var(--danger)']] : []),
  ].map(([t, n, c]) => `<div style="flex:1;min-width:88px;padding:8px 11px;border-radius:11px;
      background:rgba(255,255,255,.03);border:1px solid rgba(255,120,40,.14)">
      <div class="muted" style="font-size:9.5px;letter-spacing:.08em;text-transform:uppercase">${t}</div>
      <div style="font:800 19px 'Space Grotesk';color:${c};margin-top:1px">${n}</div>
    </div>`).join('');
  const vistos = r.cortesias
    .filter(c => !_ctFiltro || (_ctFiltro === 'si' ? c.entro : !c.entro))
    .filter(c => !q || c.buyer_name.toLowerCase().includes(q));
  const cont = $('#ct-list');
  cont.innerHTML = '';
  if (!vistos.length) {
    cont.innerHTML = '<div class="muted" style="padding:14px;font-size:12px">Ningún invitado coincide.</div>';
    return;
  }
  vistos.forEach(c => {
    const fila = document.createElement('div');
    fila.className = 'row';
    fila.style.cssText = 'justify-content:space-between;align-items:center;gap:8px;'
      + 'padding:8px 11px;border-radius:11px;'
      + (c.anulada
          ? 'background:rgba(255,255,255,.02);opacity:.62;border:1px dashed rgba(232,112,106,.35)'
          : 'background:rgba(255,255,255,.03);border:1px solid '
            + (c.entro ? 'rgba(126,226,168,.28)' : 'rgba(255,120,40,.13)'));
    const nota = c.anulada
      ? (c.void_reason ? ' · ' + esc(c.void_reason) : '')
      : (c.entro ? ' · entró ' + esc((c.used_at || '').slice(11, 16)) + ' h' : '');
    fila.innerHTML = `<div style="min-width:0;flex:1">
        <div class="clip" style="font:700 13px Manrope;color:var(--cream)${
          c.anulada ? ';text-decoration:line-through' : ''}">${esc(c.buyer_name)}</div>
        <div style="font-size:10px;margin-top:1px;color:${tonoDe(c).tinta}${
          c.anulada ? ';text-decoration:line-through' : ''}">${
          estrellaDe(c)}${esc(c.type_name)}<span class="muted" style="text-decoration:none">${nota}</span></div>
      </div>
      <span class="badge ${c.anulada ? 'void' : (c.entro ? 'active' : 'used')}" style="flex:none">${
        c.anulada ? 'Anulada' : (c.entro ? 'Entró' : 'Falta')}</span>`;
    // Una cortesía anulada ya no se descarga ni se vuelve a anular: se queda a la
    // vista, tachada, como constancia de que se le quitó la entrada.
    if (!c.anulada) {
      // Descargar su boleto desde aquí: es donde están los invitados, y a alguno
      // siempre hay que reenviárselo porque lo borró o cambió de teléfono.
      const dl = document.createElement('button');
      dl.className = 'iconbtn'; dl.style.flex = 'none';
      dl.title = 'Descargar su boleto'; dl.innerHTML = DL_ICON;
      dl.onclick = async () => {
        dl.disabled = true;
        try { await downloadTicket(c, EV); } catch (e) { toast(e.message); }
        finally { dl.disabled = false; }
      };
      fila.appendChild(dl);
      // Quitarle la entrada: con 100 cortesías repartidas, que una se filtre o que
      // alguien ya no vaya es cuestión de tiempo.
      const an = document.createElement('button');
      an.className = 'iconbtn'; an.textContent = '✕'; an.style.flex = 'none';
      an.title = 'Quitarle la entrada';
      an.style.color = 'var(--danger)';
      an.style.borderColor = 'rgba(232,112,106,.5)';
      an.style.background = 'rgba(232,112,106,.08)';
      an.onclick = () => anularCortesia(c);
      fila.appendChild(an);
    }
    cont.appendChild(fila);
  });
}

async function anularCortesia(c) {
  const r = await confirmModal({
    title: 'Quitarle la entrada', danger: true, okLabel: 'Anular la cortesía',
    body: `<b style="color:var(--cream)">${esc(c.buyer_name)}</b> · ${esc(c.type_name)}
           <br><br>Su QR deja de servir en la puerta al instante. Se queda en esta lista
           <b>tachado</b>, para que conste que se le quitó.${c.entro
             ? '<br><br><b style="color:var(--danger)">Ojo: esta persona YA entró a la fiesta.</b>' : ''}`,
    withReason: true,
  });
  if (!r) return;
  try {
    await API.post(`/api/admin/tickets/${c.id}/void`, { reason: r.reason });
    toast('Cortesía de ' + c.buyer_name + ' anulada');
    _sigCort = ''; loadCortesias();
  } catch (e) { if (!guard(e)) toast(e.message); }
}
document.addEventListener('input', e => {
  if (e.target && e.target.id === 'ct-q') { _sigCort = ''; loadCortesias(); }
});
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('.ct-f');
  if (!b) return;
  _ctFiltro = b.dataset.f;
  $$('.ct-f').forEach(o => o.classList.toggle('sel', o === b));
  _sigCort = ''; loadCortesias();
});

/* ---------------- boletos ---------------- */
async function refreshFilterSources() {
  // allSettled y no all: si una de las tres falla, las otras dos igual se llenan.
  // Con all, un tropiezo en cualquiera dejaba los TRES desplegables vacíos.
  const res = await Promise.allSettled([
    API.get('/api/admin/sellers'), API.get('/api/admin/ticket-types'), API.get('/api/admin/faculties'),
  ]);
  const dato = (i, llave) => res[i].status === 'fulfilled'
    ? (res[i].value[llave] || []) : CACHE[llave];   // la que falla conserva lo que ya había
  CACHE = { sellers: dato(0, 'sellers'), types: dato(1, 'types'), faculties: dato(2, 'faculties') };
  const sl = { sellers: CACHE.sellers }, tt = { types: CACHE.types }, fc = { faculties: CACHE.faculties };
  $('#fl-seller').innerHTML = '<option value="">Vendedor: todos</option>' +
    sl.sellers.map(s => `<option value="${s.id}">${esc(s.name)}${s.deleted ? ' (eliminado)' : ''}</option>`).join('');
  // "Cortesía" va como un tipo más aunque no lo sea: es como se busca. Solo aparece
  // aquí, en el panel del dueño — los vendedores nunca ven un boleto de invitado.
  $('#fl-type').innerHTML = '<option value="">Tipo: todos</option>' +
    tt.types.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('') +
    '<option value="__cortesia__">Cortesía</option>';
  $('#fl-faculty').innerHTML = '<option value="">Facultad: todas</option>' +
    fc.faculties.map(f => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('');
  populateAdminFilters(sl.sellers);
}

// llena los selects "Admin: todos" (en Boletos y Vendedores) con los admins que
// tienen vendedores, más "Sin asignar" si hay vendedores sin dueño
function populateAdminFilters(sellers) {
  const names = [...new Set(sellers.filter(s => s.owner_admin_name).map(s => s.owner_admin_name))].sort();
  const hasNone = sellers.some(s => !s.owner_admin_name);
  const opts = '<option value="">Admin: todos</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    (hasNone ? '<option value="__none__">Sin asignar</option>' : '');
  ['#fl-admin', '#sl-filter-admin'].forEach(sel => {
    const el = $(sel); if (!el) return;
    const cur = el.value; el.innerHTML = opts; el.value = cur;
  });
}

function filterQS() {
  const p = new URLSearchParams();
  const map = { q: '#fl-q', admin: '#fl-admin', seller_id: '#fl-seller', type: '#fl-type', faculty: '#fl-faculty' };
  for (const [k, sel] of Object.entries(map)) {
    const v = $(sel).value.trim();
    if (v) p.set(k, v);
  }
  return p.toString();
}

async function loadTicketsTab() {
  // Se llenan SIEMPRE. Antes se saltaba este paso "si ya hay vendedores en CACHE",
  // pero CACHE también lo llena la pestaña Vendedores —y la actualización en vivo,
  // sola—. Bastaba con haber pasado por Vendedores una vez para que al abrir Boletos
  // los tres desplegables se quedaran con una sola opción: "todos". El botón se veía
  // roto sin estarlo: nunca le habían puesto qué mostrar.
  await refreshFilterSources();
  await loadTicketsTable();
}

let _sigTickets = '';
async function loadTicketsTable(silent) {
  const qs = filterQS();
  const r = await API.get('/api/admin/tickets' + (qs ? '?' + qs : ''));
  // firma con lo que puede cambiar en vivo: folios, estado y hora de ingreso
  const sig = qs + '|' + r.tickets.map(t => t.folio + t.status + (t.used_at || '')).join(',');
  if (silent && sig === _sigTickets) return;   // sin cambios → no re-dibujar (evita parpadeo)
  _sigTickets = sig;
  $('#bt-count').textContent = r.tickets.length + ' boleto(s)';
  const body = $('#bt-body');
  body.innerHTML = '';
  r.tickets.forEach(t => {
    const tr = document.createElement('tr');
    if (t.status === 'void') tr.className = 'void';
    const estado = t.status === 'void'
      ? '<span class="badge void">ANULADO</span>'
      : t.status === 'used'
        ? `<span class="badge used">INGRESÓ</span>${t.used_at ? `<div class="muted" style="font-size:9px;margin-top:3px">${esc(t.used_at.slice(11, 16))} h</div>` : ''}`
        : '<span class="badge active">ACTIVO</span>';
    tr.innerHTML = `
      <td data-label="Folio" style="font-family:'Space Grotesk';color:var(--ember-soft)">${esc(t.folio)}</td>
      <td data-label="Comprador" class="strike cell-name"><span class="clip" title="${esc(t.buyer_name)}">${esc(t.buyer_name)}</span></td>
      <td data-label="Facultad">${esc(t.faculty_name)}</td>
      <td data-label="Tipo">${esc(t.type_name)}${t.es_cortesia
          ? `<div style="font-size:9px;color:${tonoDe(t).tinta};margin-top:2px">${
              estrellaDe(t)}CORTESÍA</div>` : ''}</td>
      <td data-label="Precio" class="strike" style="font-family:'Space Grotesk'">${t.es_cortesia
          ? `<span style="color:${tonoDe(t).tinta}">Cortesía</span>`
          : (t.normal_price > t.price
              ? `<span style="color:var(--cream-45);text-decoration:line-through;font-size:11px">${
                  fmtMoney(t.normal_price)}</span> <b>${fmtMoney(t.price)}</b>
                 <div style="font-size:9px;color:#f3d27a;margin-top:2px">⚡ ${esc(t.phase_name || 'FLASH')}</div>`
              : fmtMoney(t.price))}</td>
      <td data-label="Vendedor">${esc(t.seller_name)} <span class="muted">(${esc(t.seller_code)})</span>${t.owner_admin_name ? `<div class="muted" style="font-size:9px;margin-top:2px">Admin: ${esc(t.owner_admin_name)}</div>` : ''}</td>
      <td data-label="Fecha" class="muted">${esc(t.created_at)}</td>
      <td data-label="Estado">${estado}</td>`;
    const td = document.createElement('td');
    td.setAttribute('data-label', '');
    td.style.whiteSpace = 'nowrap';
    if (t.status !== 'void') {
      const dl = document.createElement('button');
      dl.className = 'iconbtn'; dl.title = 'Descargar boleto'; dl.innerHTML = DL_ICON;
      dl.onclick = async () => { dl.disabled = true; try { await downloadTicket(t, EV); } finally { dl.disabled = false; } };
      td.appendChild(dl);
      // la tachita aparece SOLO si el servidor dice que este admin puede anularlo
      if (t.can_void) {
        const vd = document.createElement('button');
        vd.className = 'iconbtn'; vd.textContent = '✕'; vd.style.marginLeft = '6px';
        vd.title = 'Anular boleto';
        vd.style.color = 'var(--danger)'; vd.style.borderColor = 'rgba(232,112,106,.5)'; vd.style.background = 'rgba(232,112,106,.08)';
        vd.onclick = () => voidTicket(t);
        td.appendChild(vd);
      }
    }
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

async function voidTicket(t) {
  // RF-56: confirmación + motivo obligatorio
  const r = await confirmModal({
    title: 'Anular boleto ' + t.folio,
    body: `<b style="color:var(--cream)">${esc(t.buyer_name)}</b> · ${esc(t.type_name)} · ${fmtMoney(t.price)}<br>
           Vendió: ${esc(t.seller_name)}.<br><br>El boleto quedará marcado como ANULADO y dejará de contar
           en su cuenta.`,
    okLabel: 'Anular', danger: true, withReason: true,
  });
  if (!r) return;
  try {
    await API.post(`/api/admin/tickets/${t.id}/void`, { reason: r.reason });
    toast('Boleto ' + t.folio + ' anulado');
    loadTicketsTable();
  } catch (e) { if (!guard(e)) toast(e.message); }
}

let _flTimer = null;
['#fl-q'].forEach(s => $(s).addEventListener('input', () => {
  clearTimeout(_flTimer); _flTimer = setTimeout(loadTicketsTable, 300);
}));
['#fl-admin', '#fl-seller', '#fl-type', '#fl-faculty']
  .forEach(s => $(s).addEventListener('change', loadTicketsTable));

$('#btn-export').addEventListener('click', async () => {
  // RF-93: la exportación respeta los filtros; se descarga con la sesión en el header
  const qs = filterQS();
  try {
    const res = await fetch('/api/admin/export' + (qs ? '?' + qs : ''),
      { headers: { Authorization: 'Bearer ' + API.token } });
    if (!res.ok) throw new Error('No se pudo exportar');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const cd = res.headers.get('Content-Disposition') || '';
    a.download = (cd.match(/filename="?([^";]+)/) || [])[1] || 'boletos.xlsx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
    toast('Excel exportado ✓ (quedó registrado en auditoría)');
  } catch (e) { toast(e.message); }
});

/* ---------------- grupos (5/10) ---------------- */
let _sigGrupos = '';
let GR_FILTER = '';   // '' = todos, '5', '10'
let GR_ALL = [];      // último resultado del servidor, para filtrar sin re-pedir

function renderGroupFilterCounts() {
  $$('#gr-filter button').forEach(b => {
    const label = b.dataset.size === '' ? 'General' : `Grupos de ${b.dataset.size}`;
    const count = b.dataset.size === ''
      ? GR_ALL.length : GR_ALL.filter(g => String(g.size) === b.dataset.size).length;
    b.textContent = `${label} (${count})`;
    b.classList.toggle('sel', b.dataset.size === GR_FILTER);
  });
}

async function loadGroups(silent) {
  const r = await API.get('/api/admin/groups');
  const sig = JSON.stringify(r.groups.map(g => [g.id, g.names.length, g.representative]));
  if (silent && sig === _sigGrupos) return;
  _sigGrupos = sig;
  GR_ALL = r.groups;
  renderGroupFilterCounts();
  const list = $('#gr-list');
  const shown = GR_FILTER ? GR_ALL.filter(g => String(g.size) === GR_FILTER) : GR_ALL;
  if (!GR_ALL.length) {
    list.innerHTML = '<div class="muted" style="padding:16px 0">Aún no se ha generado ningún grupo.</div>';
    return;
  }
  if (!shown.length) {
    list.innerHTML = `<div class="muted" style="padding:16px 0">Sin grupos de ${esc(GR_FILTER)} todavía.</div>`;
    return;
  }
  // "Grupo N de 10 · Danniree": N cuenta cada grupo de ESE tamaño que hizo ESE vendedor,
  // en el orden en que los fue generando (1º, 2º…), para identificarlos sin ambigüedad.
  // Se numera sobre TODOS los grupos (no solo los filtrados), para que el número no
  // cambie según el filtro activo.
  const seen = {}, seqOf = {};
  [...GR_ALL].sort((a, b) => a.id - b.id).forEach(g => {
    const key = g.seller_name + '|' + g.size;
    seen[key] = (seen[key] || 0) + 1;
    seqOf[g.id] = seen[key];
  });
  list.innerHTML = shown.map(g => {
    const adminLine = g.owner_admin_name
      ? ` · Admin: <b style="color:var(--ember-soft)">${esc(g.owner_admin_name)}</b>` : '';
    const repLine = g.representative
      ? `<div class="mt8" style="background:rgba(126,226,168,.08);border:1px solid rgba(126,226,168,.32);
           border-radius:10px;padding:8px 12px;font:700 12px Manrope;color:#7ee2a8;line-height:1.4">
           ★ Representante (botella): ${esc(g.representative)}</div>`
      : '';
    const members = g.names.map((nm, i) => `
      <div style="font:600 12.5px Manrope;color:var(--cream-60);padding:4px 0;line-height:1.3">
        <span class="muted" style="font-size:10px">${i + 1}.</span> ${esc(nm)}${nm === g.representative ? ' <span style="color:#f3d27a">★</span>' : ''}
      </div>`).join('');
    return `<div class="card">
      <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:6px">
        <div>
          <div style="font:800 15px Manrope">Grupo ${seqOf[g.id]} de ${g.size}</div>
          <div class="muted" style="font-size:11px;margin-top:2px">Vendedor: <b style="color:var(--cream)">${esc(g.seller_name)}</b>${adminLine}</div>
        </div>
        <div class="muted" style="font-size:10px;text-align:right;white-space:nowrap">${esc(g.created_at)}</div>
      </div>
      ${repLine}
      <div class="mt10" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:0 14px;border-top:1px solid rgba(255,120,40,.14);padding-top:10px">
        ${members}
      </div>
    </div>`;
  }).join('');
}

$$('#gr-filter button').forEach(b => {
  b.addEventListener('click', () => {
    GR_FILTER = b.dataset.size;
    _sigGrupos = '';   // fuerza el re-render aunque los datos no hayan cambiado
    loadGroups();
  });
});

/* ---------------- gastos de la fiesta ---------------- */
let _sigGastos = '';
async function loadExpenses(silent) {
  const [g, sum] = await Promise.all([
    API.get('/api/admin/expenses'),
    API.get('/api/admin/summary').catch(() => null),
  ]);
  const sig = JSON.stringify([g.total, g.paid, g.pending, g.expenses.map(e => [e.id, e.name, e.amount, e.account, e.status, e.paid])]);
  if (silent && sig === _sigGastos) return;
  _sigGastos = sig;
  // tarjetas: pendiente (lo que se debe) destacado, pagado, total, y ganancia neta
  const vendido = sum ? sum.total : 0;
  const neta = vendido - g.total;
  $('#gx-stats').innerHTML = `
    <div class="stat" style="border-color:rgba(232,112,106,.4)">
      <div class="sk">Se debe (pendiente)</div>
      <div class="sv" style="color:var(--danger)">${fmtMoney(g.pending)}</div></div>
    <div class="stat"><div class="sk">Ya pagado</div><div class="sv">${fmtMoney(g.paid)}</div>
      <div class="muted" style="font-size:9px;margin-top:2px">incluye adelantos</div></div>
    <div class="stat"><div class="sk">Total de gastos</div><div class="sv">${fmtMoney(g.total)}</div></div>
    <div class="stat"><div class="sk">Ganancia neta</div>
      <div class="sv" style="color:${neta >= 0 ? 'var(--ok)' : 'var(--danger)'}">${fmtMoney(neta)}</div>
      <div class="muted" style="font-size:9px;margin-top:2px">vendido ${fmtMoney(vendido)} − gastos ${fmtMoney(g.total)}</div></div>`;
  // desglose por cuenta (quién puso cuánto)
  const bac = $('#gx-byaccount-card');
  if (g.by_account.length) {
    bac.style.display = 'block';   // es un <details>, no un div
    $('#gx-byaccount').innerHTML = g.by_account.map(a => `
      <div class="row" style="justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,120,40,.1)">
        <div style="font:700 13px Manrope;min-width:100px">${esc(a.account)}</div>
        <div class="muted" style="font-size:12px">lleva puesto <b style="color:var(--cream)">${fmtMoney(a.paid)}</b> de ${fmtMoney(a.total)}</div>
        <div>${a.pending > 0 ? `<span class="badge used">debe ${fmtMoney(a.pending)}</span>` : '<span class="badge active">al día</span>'}</div>
      </div>`).join('');
  } else bac.style.display = 'none';
  // tabla de gastos
  const body = $('#gx-body');
  body.innerHTML = '';
  if (!g.expenses.length) { body.innerHTML = '<tr><td colspan="5" class="muted" style="padding:16px">Aún no hay gastos. Agrega el primero arriba.</td></tr>'; return; }
  g.expenses.forEach(e => {
    const tr = document.createElement('tr');
    const pagado = e.status === 'pagado';
    // el estado deja de ser sí/no: casi todo se va pagando en adelantos, y lo que
    // hay que ver de un vistazo es cuánto falta, no una etiqueta que diga "pendiente"
    // igual para el que no se ha tocado que para el que ya lleva el 80%
    const estado = pagado
      ? '<span class="badge active">Pagado</span>'
      : (e.paid > 0
          ? `<span class="badge used">Falta ${fmtMoney(e.pending)}</span>
             <div class="muted" style="font-size:9.5px;margin-top:3px">abonado ${fmtMoney(e.paid)} de ${fmtMoney(e.amount)}</div>`
          : '<span class="badge used">Pendiente</span>');
    tr.innerHTML = `
      <td data-label="Gasto" class="cell-name"><span class="clip" title="${esc(e.name)}">${esc(e.name)}</span></td>
      <td data-label="Monto" style="font-family:'Space Grotesk';font-weight:700">${fmtMoney(e.amount)}</td>
      <td data-label="Cuenta">${e.account ? esc(e.account) : '<span class="muted">—</span>'}</td>
      <td data-label="Estado">${estado}</td>`;
    const td = document.createElement('td');
    td.setAttribute('data-label', '');
    const mk = (label, fn, cls) => {
      const b = document.createElement('button');
      b.className = 'btn sm ' + (cls || 'ghost');
      b.style.width = 'auto'; b.style.marginRight = '6px'; b.style.marginBottom = '4px';
      b.textContent = label; b.onclick = fn;
      td.appendChild(b);
    };
    if (!pagado) mk('Abonar', () => abonarGasto(e), '');
    mk(pagado ? 'Marcar pendiente' : 'Ya se pagó todo',
       () => setExpenseStatus(e, pagado ? 'pendiente' : 'pagado'), 'ghost');
    mk('Editar', () => editExpense(e));
    mk('Eliminar', () => deleteExpense(e), 'danger');
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

async function setExpenseStatus(e, status) {
  try { await API.put('/api/admin/expenses/' + e.id, { status }); loadExpenses(); }
  catch (err) { if (!guard(err)) toast(err.message); }
}
/* Un adelanto. Casi ningún gasto grande se paga de un golpe: del local de $15,000
   se entregan $3,000 y el resto después. Sin esto había que mentirle al sistema
   —marcarlo pagado o dejarlo en cero— y la cuenta de cuánto se debe dejaba de
   servir justo cuando más se ocupa. */
function abonarGasto(e) {
  modal(`<div class="h1" style="font-size:18px">Abonar a ${esc(e.name)}</div>
    <div class="muted mt8">Van <b style="color:var(--cream)">${fmtMoney(e.paid)}</b> de ${fmtMoney(e.amount)}.
      Falta <b style="color:var(--danger)">${fmtMoney(e.pending)}</b>.</div>
    <div class="label mt16">¿Cuánto entregaste ahora?</div>
    <input class="input" id="ab-amount" type="number" min="0" step="0.01" inputmode="decimal"
           placeholder="$" style="font-size:18px">
    <div class="row mt8" style="gap:6px;flex-wrap:wrap">
      <button class="btn sm ghost" id="ab-todo" style="width:auto;flex:none;padding:9px 13px">
        Todo lo que falta (${fmtMoney(e.pending)})</button>
    </div>
    <div class="err mt8" id="ab-err"></div>
    <div class="row mt16">
      <button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
      <button class="btn grow" id="ab-ok">Registrar abono</button>
    </div>`);
  $('#ab-todo').onclick = () => { $('#ab-amount').value = e.pending; };
  $('#ab-amount').focus();
  $('#ab-ok').onclick = async () => {
    const v = parseFloat($('#ab-amount').value);
    if (!(v > 0)) { $('#ab-err').textContent = 'Escribe cuánto entregaste'; return; }
    try {
      await API.post(`/api/admin/expenses/${e.id}/abono`, { amount: v });
      closeModal(); toast(`Abono de ${fmtMoney(v)} registrado`); loadExpenses();
    } catch (err) { if (!guard(err)) $('#ab-err').textContent = err.message; }
  };
}

function editExpense(e) {
  modal(`<div class="h1" style="font-size:18px">Editar gasto</div>
    <div class="label mt12">Nombre</div><input class="input" id="ex-name" value="${esc(e.name)}">
    <div class="label mt12">Monto ($)</div><input class="input" id="ex-amount" type="number" min="0" value="${e.amount}">
    <div class="label mt12">Quién paga</div><input class="input" id="ex-account" value="${esc(e.account)}" placeholder="Opcional">
    <label class="muted row mt12" style="gap:6px"><input type="checkbox" id="ex-paid" ${e.status === 'pagado' ? 'checked' : ''}>Ya pagado</label>
    <div class="err mt8" id="ex-err"></div>
    <div class="row mt16"><button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
    <button class="btn grow" id="ex-save">Guardar</button></div>`);
  $('#ex-save').onclick = async () => {
    try {
      await API.put('/api/admin/expenses/' + e.id, {
        name: $('#ex-name').value.trim(), amount: parseFloat($('#ex-amount').value) || 0,
        account: $('#ex-account').value.trim(), status: $('#ex-paid').checked ? 'pagado' : 'pendiente',
      });
      closeModal(); toast('Gasto actualizado'); loadExpenses();
    } catch (err) { if (!guard(err)) $('#ex-err').textContent = err.message; }
  };
}
function deleteExpense(e) {
  modal(`<div class="h1" style="font-size:18px">¿Eliminar gasto?</div>
    <div class="muted mt8">Se eliminará "${esc(e.name)}" (${fmtMoney(e.amount)}).</div>
    <div class="row mt16"><button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
    <button class="btn danger grow" id="dx-yes">Eliminar</button></div>`);
  $('#dx-yes').onclick = async () => {
    try { await API.del('/api/admin/expenses/' + e.id); closeModal(); loadExpenses(); }
    catch (err) { if (!guard(err)) toast(err.message); }
  };
}
$('#btn-gx-create').addEventListener('click', async () => {
  $('#gx-err').textContent = '';
  const name = $('#gx-name').value.trim();
  if (!name) { $('#gx-err').textContent = 'Escribe el nombre del gasto'; return; }
  try {
    await API.post('/api/admin/expenses', {
      name, amount: parseFloat($('#gx-amount').value) || 0,
      account: $('#gx-account').value.trim(), status: $('#gx-paid').checked ? 'pagado' : 'pendiente',
    });
    $('#gx-name').value = ''; $('#gx-amount').value = ''; $('#gx-account').value = ''; $('#gx-paid').checked = false;
    loadExpenses();
  } catch (e) { if (!guard(e)) $('#gx-err').textContent = e.message; }
});

/* ---------------- movimientos (feed para todos los admins) ---------------- */
const MV_ICON = { generacion: '🎟', anulacion: '✕', vendedor_creado: '👤', vendedor_eliminado: '✂',
                  usuarios: '👤', precio: '$', catalogo: '📋', ajustes: '⚙', exportacion: '⬇',
                  inicializacion: '⚡', pago: '💰', gasto: '🧾' };
const MV_COLOR = { anulacion: 'rgba(232,112,106,.5)', vendedor_eliminado: 'rgba(232,112,106,.5)',
                   generacion: 'rgba(126,226,168,.4)', vendedor_creado: 'rgba(126,226,168,.4)' };
let _sigMoves = '';
/* Dos vistas del mismo registro. Mezclado, lo que hacen seis colíderes queda
   enterrado entre los cambios de precio y los cobros del organizador, y es
   justamente lo que hay que poder repasar: quién anuló, quién dio de baja a quién.
   MV_QUIEN: 'todos' | 'colideres' | el usuario de un colíder en concreto. */
let MV_QUIEN = 'todos';
let _mvColideres = [];

function pintarFiltroMoves() {
  const cont = $('#mv-filtro');
  if (!cont) return;
  if (!_mvColideres.length) { cont.innerHTML = ''; return; }   // sin colíderes no hay nada que separar
  const enGrupo = MV_QUIEN !== 'todos';
  const chip = (v, txt) =>
    `<button class="mv-f${MV_QUIEN === v ? ' sel' : ''}" data-q="${esc(v)}">${esc(txt)}</button>`;
  cont.innerHTML =
    `<div class="mv-fila">${chip('todos', 'Todo el sistema')}` +
    `${chip('colideres', 'Mis colíderes')}</div>` +
    (enGrupo && _mvColideres.length > 1
      ? `<div class="mv-fila mv-sub">${chip('colideres', 'Todos')}` +
        _mvColideres.map(u => chip(u, u)).join('') + `</div>`
      : '');
}

async function loadMovements(silent) {
  const r = await API.get('/api/admin/audit?quien=' + encodeURIComponent(MV_QUIEN));
  const sig = MV_QUIEN + '|' + (r.log.length ? r.log[0].id + '-' + r.log.length : '0');
  if (silent && sig === _sigMoves) return;
  _sigMoves = sig;
  _mvColideres = r.colideres || [];
  pintarFiltroMoves();
  const vacio = MV_QUIEN === 'todos'
    ? 'Sin movimientos aún'
    : 'Sin movimientos todavía por aquí';
  // La marca de "colíder" solo sirve cuando están mezclados. Dentro de la vista de
  // colíderes todos lo son y repetirlo en cada renglón es ruido.
  const marcar = MV_QUIEN === 'todos' && !_coliderAplicado;
  $('#mv-list').innerHTML = r.log.map(l => `
    <div class="trow${marcar && l.es_colider ? ' mv-cl' : ''}" style="${MV_COLOR[l.action] ? 'border-color:' + MV_COLOR[l.action] : ''}">
      <div class="avatar" style="font-size:13px">${MV_ICON[l.action] || '·'}</div>
      <div class="tmain">
        <div style="font:600 12.5px Manrope;color:var(--cream);white-space:normal">${esc(l.detail)}</div>
        <div class="tmeta">${esc(l.actor)}${marcar && l.es_colider ? ' <span class="mv-tag">colíder</span>' : ''} · ${esc(l.created_at)}</div>
      </div>
    </div>`).join('') || `<div class="muted">${vacio}</div>`;
  const mvi = $('#mv-intro');
  if (mvi && !_coliderAplicado) {
    mvi.textContent = MV_QUIEN === 'todos'
      ? 'Todo lo que pasa en el sistema. Lo ven todos los administradores.'
      : (MV_QUIEN === 'colideres'
          ? 'Lo que han hecho tus colíderes: anulaciones, altas y bajas de su propia gente.'
          : 'Todo lo que ha hecho ' + MV_QUIEN + ' dentro de su grupo.');
  }
}

document.addEventListener('click', ev => {
  const b = ev.target.closest('#mv-filtro .mv-f');
  if (!b) return;
  MV_QUIEN = b.dataset.q;
  _sigMoves = '';
  pintarFiltroMoves();
  loadMovements();
});

/* ---------------- vendedores ---------------- */
let _sigSellers = '';
/* ---------------- quién está trabajando ----------------
   Tres cubetas, y el orden importa: nunca entró → entró pero no ha vendido → vendiendo.
   Un vendedor que no ha vendido no dice nada por sí solo; lo que decide es si
   llegó a abrir la app. Se toca cada cubeta para ver solo a esos. */
function estadoVendedor(s) {
  if (!s.ultimo_ingreso && !s.tutorial_seen) return 'nuevo';
  return s.tickets > 0 ? 'vendiendo' : 'entro';
}

let _filtroAct = '';
function pintaActividad(sellers) {
  const vivos = sellers.filter(s => !s.deleted);
  const n = e => vivos.filter(s => estadoVendedor(s) === e).length;
  const cubetas = [
    { k: 'vendiendo', t: 'Vendiendo', c: 'var(--ok, #34d399)', d: 'ya generaron boletos' },
    { k: 'entro', t: 'Entraron, sin vender', c: '#f3d27a', d: 'abrieron la app pero no han vendido' },
    { k: 'nuevo', t: 'Nunca han entrado', c: 'var(--danger)', d: 'jamás abrieron la boletera' },
  ];
  $('#sl-activity').innerHTML = cubetas.map(b => `
    <button class="btn sm ghost sl-act${_filtroAct === b.k ? ' sel' : ''}" data-act="${b.k}" title="${b.d}"
      style="width:auto;flex:none;padding:9px 13px;text-align:left">
      <span style="font:800 17px 'Space Grotesk';color:${b.c}">${n(b.k)}</span>
      <span style="font-size:11px;margin-left:6px">${b.t}</span>
    </button>`).join('') +
    `<div class="muted" style="font-size:10.5px;align-self:center;margin-left:2px">
       de ${vivos.length} · toca para filtrar</div>`;
  $$('.sl-act').forEach(b => b.onclick = () => {
    _filtroAct = _filtroAct === b.dataset.act ? '' : b.dataset.act;
    _sigSellers = ''; loadSellers();
  });
}

async function loadSellers(silent) {
  const r = await API.get('/api/admin/sellers');
  populateAdminFilters(r.sellers);
  const fa = ($('#sl-filter-admin') && $('#sl-filter-admin').value) || '';
  // con 30 vendedores, buscar por nombre o código es lo que se usa a diario
  const q = (($('#sl-q') && $('#sl-q').value) || '').trim().toLowerCase();
  const sig = JSON.stringify([fa, q, ...r.sellers.map(s => [s.id, s.name, s.code, s.active, s.deleted, s.tickets, s.total, s.paid])]);
  if (silent && sig === _sigSellers) return;
  _sigSellers = sig;
  CACHE.sellers = r.sellers;
  pintaActividad(r.sellers);
  const body = $('#sl-body');
  body.innerHTML = '';
  // filtro por admin (cliente): "" todos, "__none__" sin asignar, o el nombre
  const shown = r.sellers
    .filter(s => !fa || (fa === '__none__' ? !s.owner_admin_name : s.owner_admin_name === fa))
    .filter(s => !q || s.name.toLowerCase().includes(q) || (s.code || '').includes(q))
    .filter(s => !_filtroAct || (!s.deleted && estadoVendedor(s) === _filtroAct));
  $('#sl-count').textContent = `${shown.length} vendedor(es)`;
  if (!shown.length) { body.innerHTML = '<tr><td colspan="7" class="muted" style="padding:16px">Ningún vendedor coincide</td></tr>'; return; }
  shown.forEach(s => {
    const tr = document.createElement('tr');
    if (s.deleted) tr.style.opacity = '.45';
    // en cada fila: quién es el admin de este vendedor (texto simple, claro)
    const adminLine = `<div class="muted" style="font-size:10px;margin-top:3px">Admin: <b style="color:var(--ember-soft)">${esc(s.owner_admin_name || 'sin asignar')}</b></div>`;
    const est = estadoVendedor(s);
    const marca = s.deleted ? '' : (est === 'nuevo'
      ? '<div style="font-size:9.5px;color:var(--danger);margin-top:2px">● nunca ha entrado</div>'
      : (est === 'entro'
          ? `<div style="font-size:9.5px;color:#f3d27a;margin-top:2px" title="Entró ${esc(s.ultimo_ingreso || '')}">● entró, sin vender</div>`
          : ''));
    // faltante = vendido - pagado. Cuando es 0 (y vendió), COMPLETADO.
    const falta = s.total - s.paid;
    const faltante = s.total <= 0
      ? '<span class="muted">—</span>'
      : (falta <= 0
          ? '<span class="badge active">COMPLETADO</span>'
          : `<b style="font-family:'Space Grotesk';color:var(--danger)">${fmtMoney(falta)}</b>`);
    tr.innerHTML = `
      <td data-label="Vendedor" class="cell-name" style="font-weight:700"><span class="clip" title="${esc(s.name)}">${esc(s.name)}</span>${marca}${adminLine}</td>
      <td data-label="Código">${s.deleted ? '<span class="muted">—</span>'
          : s.code ? `<span class="codechip">${esc(s.code)}</span>`
          : '<span class="muted" style="font-size:10px" title="Solo su admin puede verlo">🔒 privado</span>'}</td>
      <td data-label="Vendido"><b style="font-family:'Space Grotesk'">${fmtMoney(s.total)}</b><div class="muted" style="font-size:9px;margin-top:2px">${s.tickets} boleto(s)</div></td>
      <td data-label="Pagado" style="font-family:'Space Grotesk';font-weight:700">${fmtMoney(s.paid)}</td>
      <td data-label="Faltante">${faltante}</td>
      <td data-label="Estado">${s.deleted ? '<span class="badge void">Eliminado</span>'
          : s.active ? '<span class="badge active">Activo</span>'
          : '<span class="badge used">Desactivado</span>'}</td>`;
    const td = document.createElement('td');
    td.setAttribute('data-label', '');
    // lo decide el servidor: incluye a los del equipo de un colíder, que son tuyos
    // hacia abajo aunque figuren con otro dueño
    const mine = s.can_manage;
    if (!s.deleted && mine) {
      // Con 30 vendedores, cuatro botones por fila es un muro. La acción del día a
      // día es COBRAR; editar, desactivar y eliminar casi no se usan, así que se
      // guardan detrás de los tres puntos.
      const cuenta = document.createElement('button');
      cuenta.className = 'btn sm';
      cuenta.style.cssText = 'width:auto;margin-right:6px';
      cuenta.textContent = 'Cuenta';
      cuenta.onclick = () => paySeller(s);
      td.appendChild(cuenta);
      const mas = document.createElement('button');
      mas.className = 'btn sm ghost';
      mas.style.cssText = 'width:auto;padding:9px 12px';
      mas.textContent = '\u22ef';
      mas.title = 'Más opciones';
      mas.onclick = () => menuVendedor(s);
      td.appendChild(mas);
    } else if (!s.deleted) {
      td.innerHTML = `<span class="muted" style="font-size:10px">solo ${esc(s.owner_admin_name || 'su admin')} puede modificarlo</span>`;
    }
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

/* registrar cuánto dinero ha entregado el vendedor a su admin */
/* Cuenta del vendedor: cuánto debe, cada entrega que ha hecho y su comisión.
   El admin captura el ABONO (lo que se le baja de la deuda) y de ahí sale sola la
   comisión que el vendedor se queda y el efectivo que debe entregar. Cada pago
   queda con fecha, para poder demostrarle después cómo fue pagando. */
async function paySeller(s) {
  if (s.total <= 0) {
    modal(`<div class="h1" style="font-size:18px">Cuenta de ${esc(s.name)}</div>
      <div class="muted mt12" style="line-height:1.5">Este vendedor <b style="color:var(--cream)">aún no ha vendido nada</b> ($0), así que no hay pago que registrar.</div>
      <button class="btn mt16" onclick="closeModal()">Entendido</button>`);
    return;
  }
  let c;
  try { c = await API.get(`/api/admin/sellers/${s.id}/payments`); }
  catch (e) { if (!guard(e)) toast(e.message); return; }
  pintaCuenta(s, c);
}

function pintaCuenta(s, c) {
  // Lo que de verdad importa: de lo que vendió, una parte se la queda de comisión y
  // el RESTO es el efectivo que debe entregar. Se dice con palabras, no con cuatro
  // números sueltos que hay que interpretar.
  const comisionTotal = c.sold * c.commission_pct / 100;
  const debeEntregar = c.sold - comisionTotal;
  const faltaEntregar = debeEntregar - c.cash_total;
  const avance = c.sold > 0 ? Math.round(c.settled_amount / c.sold * 100) : 0;

  // Con cortes semanales durante ~2 meses son muchos pagos. En pantalla solo se
  // muestran los últimos: lo que se necesita al momento de cobrar es el saldo y
  // los movimientos recientes. El historial COMPLETO está en la descarga.
  const TOPE = 4;
  const verTodos = c._verTodos === true;
  const visibles = verTodos ? c.payments : c.payments.slice(0, TOPE);
  const ocultos = c.payments.length - visibles.length;
  const filas = c.payments.length ? visibles.map(p => `
    <div style="padding:10px 0;border-bottom:1px solid rgba(255,120,40,.12)">
      <div class="row" style="justify-content:space-between;align-items:baseline;gap:8px">
        <div><span style="font:700 10px 'Space Grotesk';letter-spacing:.08em;color:var(--ember-dim);
          border:1px solid rgba(255,120,40,.3);border-radius:5px;padding:2px 5px">PAGO ${p.n}</span>
          <b style="font:800 16px 'Space Grotesk';color:var(--cream);margin-left:6px">${fmtMoney(p.cash)}</b>
          <span class="muted" style="font-size:11px"> entregados</span></div>
        <div class="muted" style="font-size:10px">${fmtDate(p.created_at)}</div>
      </div>
      <div class="row" style="justify-content:space-between;align-items:baseline;gap:8px;margin-top:3px">
        <div class="muted" style="font-size:11.5px">
          ${p.balance_after > 0.005
            ? `Le quedaban <b style="color:var(--danger)">${fmtMoney(p.balance_after)}</b>`
            : '<b style="color:var(--ok)">Qued\u00f3 a mano</b>'}
          ${p.note ? ' \u00b7 ' + esc(p.note) : ''}</div>
        ${c.can_edit ? `<button class="linkout" style="font-size:10px;padding:0" data-del="${p.id}">borrar</button>` : ''}
      </div>
    </div>`).join('') +
    (ocultos > 0 ? `<button class="btn sm ghost mt12" id="pg-mas" style="width:100%">Ver los ${ocultos} pagos anteriores</button>` : '')
    : '<div class="muted" style="font-size:12px;padding:12px 0">Todav\u00eda no ha entregado nada.</div>';

  modal(`<div class="h1" style="font-size:18px">Cuenta de ${esc(s.name)}</div>

    <div class="card mt12" style="background:rgba(255,110,30,.07)">
      <div class="row" style="justify-content:space-between;align-items:baseline">
        <div class="muted" style="font-size:12px">Boletos vendidos</div>
        <div style="font:800 20px 'Space Grotesk';color:var(--cream)">${c.sold_tickets || 0}</div>
      </div>
      <div class="row" style="justify-content:space-between;align-items:baseline;margin-top:7px">
        <div class="muted" style="font-size:12px">Vendi\u00f3 en boletos</div>
        <div style="font:800 20px 'Space Grotesk';color:var(--cream)">${fmtMoney(c.sold)}</div>
      </div>
      <!-- En un grupo el vendedor no se queda un porcentaje al entregar: el colíder
           reparte de su comisión. Enseñarle "0%" ahí lo hace ver como si no ganara
           nada; lo que importa es cuánto YA LE PAGARON. -->
      ${c.en_grupo ? `
      <div class="row" style="justify-content:space-between;align-items:baseline;margin-top:7px">
        <div class="muted" style="font-size:12px">Ya le pagaron</div>
        <div style="font:800 20px 'Space Grotesk';color:${c.recibido > 0 ? '#7ee0a0' : 'var(--cream-45)'}">${fmtMoney(c.recibido)}</div>
      </div>` : `
      <div class="row" style="justify-content:space-between;align-items:baseline;margin-top:7px">
        <div class="muted" style="font-size:12px;display:flex;align-items:center;gap:7px;flex-wrap:wrap">
          <span>Se queda de comisi\u00f3n</span>${c.can_commission
            ? `<button id="cta-com" class="btn sm ghost" style="width:auto;flex:none;padding:5px 11px;font-size:12px;
                 border-color:rgba(243,210,122,.5);color:#f3d27a">${c.commission_pct}% \u25be</button>`
            : `<b style="color:var(--cream)">${c.commission_pct}%</b>`}</div>
        <div style="font:700 15px 'Space Grotesk';color:#f3d27a">\u2212 ${fmtMoney(comisionTotal)}</div>
      </div>`}
      <!-- Los porcentajes de un toque, plegados. Se abren solo cuando se van a usar,
           así la cuenta se sigue leyendo igual de limpia que antes. -->
      <div id="cta-com-box" class="row" style="display:none;gap:5px;flex-wrap:wrap;margin-top:8px">
        ${[0, 10, 15, 20, 25].map(n => `<button class="btn sm ghost cta-pct${
          n === c.commission_pct ? ' sel' : ''}" data-pct="${n}"
          style="width:auto;flex:none;padding:7px 11px;font-size:11.5px">${n}%</button>`).join('')}
        <button class="btn sm ghost cta-pct" data-pct="" style="width:auto;flex:none;padding:7px 11px;font-size:11.5px"
          title="Volver a la comisi\u00f3n general del sistema">General</button>
        <button class="btn sm ghost" id="cta-otro" style="width:auto;flex:none;padding:7px 11px;font-size:11.5px"
          title="Escribir cualquier porcentaje">Otro…</button>
      </div>
      <!-- Para el porcentaje que no está en los atajos: 30, 12.5, el que sea. -->
      <div id="cta-otro-box" class="row" style="display:none;gap:6px;align-items:center;margin-top:8px">
        <input class="input" id="cta-otro-val" type="number" min="0" max="100" step="0.5"
          inputmode="decimal" placeholder="%" style="width:92px;padding:8px;font-size:13px">
        <button class="btn sm" id="cta-otro-ok" style="width:auto;flex:none;padding:8px 13px;font-size:12px">Aplicar</button>
      </div>
      <div style="border-top:1px solid rgba(255,120,40,.25);margin:10px 0 8px"></div>
      <div class="row" style="justify-content:space-between;align-items:baseline">
        <div style="font:700 12.5px Manrope;color:var(--cream)">Debe entregarte en total</div>
        <div style="font:800 22px 'Space Grotesk';color:var(--ember)">${fmtMoney(debeEntregar)}</div>
      </div>
    </div>

    <div class="card mt8" style="border-color:${faltaEntregar > 0.005 ? 'rgba(232,112,106,.4)' : 'rgba(126,226,168,.45)'}">
      <div class="row" style="justify-content:space-between;align-items:baseline">
        <div class="muted" style="font-size:12px">Ya te entreg\u00f3</div>
        <div style="font:800 18px 'Space Grotesk';color:var(--cream)">${fmtMoney(c.cash_total)}</div>
      </div>
      <div class="row" style="justify-content:space-between;align-items:baseline;margin-top:7px">
        <div style="font:700 12.5px Manrope;color:${faltaEntregar > 0.005 ? 'var(--danger)' : 'var(--ok)'}">
          ${faltaEntregar > 0.005 ? 'Le falta entregarte' : 'Cuenta saldada \u2713'}</div>
        <div style="font:800 20px 'Space Grotesk';color:${faltaEntregar > 0.005 ? 'var(--danger)' : 'var(--ok)'}">
          ${fmtMoney(Math.max(0, faltaEntregar))}</div>
      </div>
      <div style="height:7px;border-radius:99px;background:rgba(255,255,255,.07);margin-top:11px;overflow:hidden">
        <div style="height:100%;width:${avance}%;border-radius:99px;background:linear-gradient(90deg,#ff8a3d,#e8480d)"></div>
      </div>
      <div class="muted" style="font-size:10.5px;margin-top:6px">${avance}% de su cuenta cubierto</div>
    </div>

    ${c.payments.length ? `
    <div class="row mt8" style="gap:7px">
      <button class="btn sm ghost grow" id="pg-dl" style="display:inline-flex;align-items:center;justify-content:center;gap:7px">${DL_ICON} Guardar imagen</button>
      <button class="btn sm ghost grow" id="pg-xls" style="display:inline-flex;align-items:center;justify-content:center;gap:7px">${DL_ICON} Excel</button>
    </div>
    <div class="muted" style="font-size:10.5px;margin-top:6px;text-align:center">
      Para mandarle su estado de cuenta si pregunta c\u00f3mo fue pagando
    </div>` : ''}

    <!-- Fuera del bloque de arriba a propósito: ese solo aparece cuando ya entregó
         dinero, y "a quién le vendió" se pregunta sobre todo del que TODAVÍA no ha
         entregado nada. -->
    ${c.sold_tickets ? `<button class="btn sm ghost mt8" id="pg-vertk" style="width:100%">
      \u25a4 Ver sus ${c.sold_tickets} boleto(s) \u00b7 a qui\u00e9n le vendi\u00f3</button>` : ''}

    <!-- El reparto: en un grupo el vendedor entrega el 100% y el colíder le paga de
         su comisión. Sin este botón el reparto se quedaba fuera del sistema y no
         había forma de comprobar a quién se le dio cuánto. -->
    ${c.en_grupo && c.can_edit ? `
    <div class="card mt12" style="border-color:rgba(126,224,160,.35)">
      <div class="row" style="justify-content:space-between;align-items:baseline">
        <div class="label" style="margin:0">Pagarle de tu comisión</div>
        <div style="font:800 17px 'Space Grotesk';color:#7ee0a0">${fmtMoney(c.recibido)}</div>
      </div>
      <div class="muted" style="font-size:10.5px;margin-top:2px">ya recibido en total</div>
      <div class="row mt8" style="gap:6px;flex-wrap:wrap">
        <button class="btn sm ghost tp-q" data-m="${(c.sold * 0.10).toFixed(2)}"
          style="width:auto;flex:none;padding:8px 12px;font-size:12px">10% de lo que vendió
          \u00b7 ${fmtMoney(c.sold * 0.10)}</button>
        <button class="btn sm ghost tp-q" data-m="${(c.cash_total * 0.10).toFixed(2)}"
          style="width:auto;flex:none;padding:8px 12px;font-size:12px">10% de lo que entregó
          \u00b7 ${fmtMoney(c.cash_total * 0.10)}</button>
      </div>
      <div class="row mt8" style="gap:7px;align-items:center">
        <input class="input" id="tp-monto" type="number" min="0" step="1" inputmode="decimal"
          placeholder="Otro monto ($)" style="flex:1;padding:11px">
        <button class="btn sm" id="tp-ok" style="width:auto;flex:none;padding:11px 16px">Pagar</button>
      </div>
      <div class="err mt8" id="tp-err"></div>
      ${(c.recibidos || []).length ? `<div class="tp-hist">${c.recibidos.map(p => `
        <div class="tp-row">
          <span>${esc(String(p.created_at).slice(0, 16))}${p.note ? ' \u00b7 ' + esc(p.note) : ''}</span>
          <b>${fmtMoney(p.amount)}</b>
          <button class="tp-del" data-id="${p.id}" title="Deshacer este pago">\u2715</button>
        </div>`).join('')}</div>` : ''}
    </div>` : ''}

    ${c.can_edit && c.balance > 0.005 ? `
    <div class="card mt12">
      <div class="label">Registrar una entrega</div>
      <div class="muted" style="margin-bottom:8px;font-size:11px">\u00bfCu\u00e1nto de su cuenta est\u00e1 cubriendo con este pago? La comisi\u00f3n y el efectivo salen solos.</div>
      <input class="input" id="pg-amount" type="number" min="0" max="${c.balance}" step="0.01" placeholder="Cubre de su cuenta ($)">
      <div class="row mt8" style="gap:6px;flex-wrap:wrap">
        <button class="btn sm ghost" id="pg-todo" style="width:auto">Liquida todo (${fmtMoney(c.balance)})</button>
      </div>
      <div class="muted mt12" style="font-size:11px;margin-bottom:6px">¿Qué corte es? Queda escrito en su estado de cuenta.</div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button class="btn sm ghost pg-tipo" data-nota="Corte semanal" style="width:auto">Semanal</button>
        <button class="btn sm ghost pg-tipo" data-nota="Corte del día" style="width:auto">Del día</button>
      </div>
      <input class="input mt8" id="pg-note" placeholder="o escríbelo tú…" maxlength="120">
      <div class="mt8" id="pg-calc" style="font:600 12px Manrope;color:var(--cream-60);line-height:1.7"></div>
      <div class="err mt8" id="pg-err"></div>
      <button class="btn mt12" id="pg-save">Registrar entrega</button>
    </div>` : (c.balance <= 0.005 ? '' :
      `<div class="muted mt12" style="font-size:11px">Solo ${esc(s.owner_admin_name || 'su admin')} puede registrar pagos de este vendedor.</div>`)}

    <div class="row mt16" style="justify-content:space-between;align-items:center">
      <div class="label" style="margin:0">Historial de pagos${c.payments.length ? ` (${c.payments.length})` : ''}</div>

    </div>
    <div class="scrolly" style="max-height:34dvh;overflow:auto">${filas}</div>
    <button class="btn ghost mt16" onclick="closeModal()">Cerrar</button>`);

  // ----- pagarle a alguien del grupo, de la comisión del colíder -----
  const tpOk = $('#tp-ok');
  if (tpOk) {
    const pagar = async (monto) => {
      $('#tp-err').textContent = '';
      if (!(monto > 0)) { $('#tp-err').textContent = 'Escribe cuánto le vas a dar'; return; }
      tpOk.disabled = true;
      try {
        const fresca = await API.post(`/api/admin/sellers/${s.id}/team-pay`, { amount: monto });
        toast(`Le pagaste ${fmtMoney(monto)} a ${s.name}`);
        pintaCuenta(s, fresca);
        loadSellers();
      } catch (e) { if (!guard(e)) $('#tp-err').textContent = e.message; }
      finally { tpOk.disabled = false; }
    };
    tpOk.onclick = () => pagar(parseFloat($('#tp-monto').value));
    $$('.tp-q').forEach(b => b.onclick = () => { $('#tp-monto').value = b.dataset.m; });
    $$('.tp-del').forEach(b => b.onclick = async () => {
      const ok = await confirmModal({ title: 'Deshacer este pago', danger: true,
        okLabel: 'Deshacer',
        body: 'Se quita del registro y vuelve a su comisión por repartir. Queda anotado en Movimientos.' });
      if (!ok) { pintaCuenta(s, c); return; }
      try {
        await API.del('/api/admin/team-pay/' + b.dataset.id);
        const fresca = await API.get(`/api/admin/sellers/${s.id}/payments`);
        toast('Pago deshecho');
        pintaCuenta(s, fresca);
      } catch (e) { if (!guard(e)) toast(e.message); }
    });
  }

  // cambiar la comisión sin salir de la cuenta: es donde se decide, viendo lo que
  // lleva vendido. Lo ya cobrado no se recalcula — cada pago guardó su porcentaje.
  const btnCom = $('#cta-com');
  if (btnCom) {
    const aplicaPct = async (valor) => {
      try {
        await API.put('/api/admin/sellers/' + s.id, { commission_pct: valor });
        const fresca = await API.get(`/api/admin/sellers/${s.id}/payments`);
        toast(valor === '' ? `${s.name} vuelve a la comisión general`
                           : `Comisión de ${s.name}: ${valor}%`);
        pintaCuenta(s, fresca);
        loadSellers();
      } catch (e) { if (!guard(e)) toast(e.message); }
    };
    btnCom.onclick = () => {
      const box = $('#cta-com-box');
      box.style.display = box.style.display === 'none' ? 'flex' : 'none';
      if (box.style.display === 'none') $('#cta-otro-box').style.display = 'none';
    };
    $$('.cta-pct').forEach(b => b.onclick = () => aplicaPct(b.dataset.pct));
    $('#cta-otro').onclick = () => {
      const caja = $('#cta-otro-box');
      caja.style.display = caja.style.display === 'none' ? 'flex' : 'none';
      if (caja.style.display !== 'none') $('#cta-otro-val').focus();
    };
    $('#cta-otro-ok').onclick = () => {
      const v = parseFloat($('#cta-otro-val').value);
      if (!(v >= 0 && v <= 100)) { toast('Escribe un porcentaje entre 0 y 100'); return; }
      aplicaPct(String(v));
    };
    $('#cta-otro-val').onkeydown = e => { if (e.key === 'Enter') $('#cta-otro-ok').click(); };
  }
  const amt = $('#pg-amount');
  if (amt) {
    const recalcular = () => {
      const v = parseFloat(amt.value || '0');
      if (!v || v <= 0) { $('#pg-calc').innerHTML = ''; return; }
      const com = Math.round(v * c.commission_pct) / 100;
      $('#pg-calc').innerHTML =
        `Se queda <b style="color:#f3d27a">${fmtMoney(com)}</b> de comisi\u00f3n<br>` +
        `<b style="color:var(--ember)">Debe darte ${fmtMoney(v - com)}</b> en efectivo<br>` +
        `Le quedar\u00eda debiendo <b style="color:var(--cream)">${fmtMoney(c.balance - v)}</b> de su cuenta`;
    };
    amt.addEventListener('input', recalcular);
    $('#pg-todo').onclick = () => { amt.value = c.balance; recalcular(); };
    // Marcar el tipo de corte sin teclear: es lo que se hace 30 veces al día.
    $$('.pg-tipo').forEach(b => b.onclick = () => {
      $('#pg-note').value = b.dataset.nota;
      $$('.pg-tipo').forEach(o => o.classList.toggle('sel', o === b));
    });
    $('#pg-save').onclick = async () => {
      const v = parseFloat(amt.value || '0');
      if (isNaN(v) || v <= 0) { $('#pg-err').textContent = 'Escribe cu\u00e1nto cubre'; return; }
      if (v > c.balance) { $('#pg-err').textContent = `Se pasa: solo debe ${fmtMoney(c.balance)}`; return; }
      try {
        const r = await API.post(`/api/admin/sellers/${s.id}/payments`,
          { amount: v, note: $('#pg-note').value.trim() });
        toast(r.balance <= 0.005 ? `${s.name}: cuenta SALDADA \u2713` : `Registrado \u00b7 le faltan ${fmtMoney(r.balance)}`);
        pintaCuenta(s, r);
        loadSellers();
      } catch (e) { if (!guard(e)) $('#pg-err').textContent = e.message; }
    };
  }
  const mas = $('#pg-mas');
  if (mas) mas.onclick = () => pintaCuenta(s, { ...c, _verTodos: true });
  // El "cuántos vendió" siempre lleva al "¿a quiénes?". Estaba a tres pasos —cerrar,
  // ir a Boletos, buscar su nombre en el filtro—; ahora es un botón desde su cuenta.
  const vertk = $('#pg-vertk');
  if (vertk) vertk.onclick = () => {
    closeModal();
    openTab('boletos');
    setTimeout(() => {
      const sel = $('#fl-seller');
      if (sel) { sel.value = String(s.id); loadTicketsTable(); }
      $('#fl-q') && ($('#fl-q').value = '');
    }, 400);
  };
  const dl = $('#pg-dl');
  if (dl) dl.onclick = () => descargarEstadoCuenta(s, c);
  const xls = $('#pg-xls');
  if (xls) xls.onclick = async () => {
    // se baja con la sesión en el header (nunca el token en la URL: quedaría
    // guardado en el historial del navegador y en los registros del servidor)
    try {
      const res = await fetch(`/api/admin/sellers/${s.id}/payments.xlsx`,
        { headers: { Authorization: 'Bearer ' + API.token } });
      if (!res.ok) throw new Error('No se pudo exportar');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      const cd = res.headers.get('Content-Disposition') || '';
      a.download = (cd.match(/filename="?([^";]+)/) || [])[1] || 'cuenta.xlsx';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    } catch (e) { if (!guard(e)) toast(e.message); }
  };
  $$('#modal [data-del]').forEach(b => {
    b.onclick = async () => {
      const ok = await confirmModal({ title: 'Borrar este pago',
        body: 'Se quita del historial y el saldo se recalcula. Queda registrado en Movimientos.',
        okLabel: 'Borrar', danger: true });
      if (!ok) { paySeller(s); return; }
      try {
        await API.del(`/api/admin/payments/${b.dataset.del}`);
        pintaCuenta(s, await API.get(`/api/admin/sellers/${s.id}/payments`));
        loadSellers();
      } catch (e) { if (!guard(e)) toast(e.message); }
    };
  });
}

/* Estado de cuenta como IMAGEN, para mandárselo al vendedor por WhatsApp cuando
   pregunte cómo fue pagando. Una imagen se ve igual en cualquier teléfono y no
   depende de que sepan abrir un Excel. */
async function descargarEstadoCuenta(s, c) {
  await document.fonts.ready;
  const W = 900, pad = 46;
  const filas = c.payments.length || 1;
  const H = 506 + filas * 96;   // 470 + el renglón de "Boletos vendidos" (36)
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');

  x.fillStyle = '#0b0503'; x.fillRect(0, 0, W, H);
  const g = x.createRadialGradient(W / 2, -60, 30, W / 2, 260, W);
  g.addColorStop(0, 'rgba(255,110,30,.20)'); g.addColorStop(1, 'rgba(255,110,30,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, 360);

  x.textAlign = 'left';
  x.fillStyle = '#ff7a2e'; x.font = '800 30px Cinzel, serif';
  x.fillText(EV && EV.event_name ? EV.event_name : 'HELLFIRE', pad, 62);
  x.fillStyle = 'rgba(255,150,80,.65)'; x.font = '600 13px "Space Grotesk", monospace';
  x.fillText('ESTADO DE CUENTA DEL VENDEDOR', pad, 86);
  x.fillStyle = '#f6f1e7'; x.font = '800 34px Manrope, sans-serif';
  x.fillText(s.name, pad, 134);

  const comisionTotal = c.sold * c.commission_pct / 100;
  const debeEntregar = c.sold - comisionTotal;
  const falta = debeEntregar - c.cash_total;

  let y = 186;
  const linea = (etq, val, color, grande) => {
    x.fillStyle = 'rgba(246,241,231,.6)'; x.font = '600 15px Manrope, sans-serif';
    x.fillText(etq, pad, y);
    x.textAlign = 'right';
    x.fillStyle = color; x.font = `800 ${grande ? 26 : 20}px "Space Grotesk", monospace`;
    x.fillText(val, W - pad, y + (grande ? 3 : 0));
    x.textAlign = 'left';
    y += grande ? 46 : 36;
  };
  // Su propio renglón, antes del dinero: es el número que el vendedor lleva en la
  // cabeza, y si el monto no le cuadra es lo primero contra lo que compara.
  linea('Boletos vendidos', String(c.sold_tickets || 0), '#f6f1e7');
  linea('Vendió en boletos', fmtMoney(c.sold), '#f6f1e7');
  // En un grupo la comisión no es de cada vendedor: es del colíder sobre el total.
  // Sin decirlo, un 0% en la ficha se lee como un error o como un castigo.
  linea(c.en_grupo ? 'Su comisión · la lleva su colíder'
                   : `Su comisión (${c.commission_pct}%)`,
        '− ' + fmtMoney(comisionTotal), '#f3d27a');
  x.strokeStyle = 'rgba(255,120,40,.3)'; x.lineWidth = 1;
  x.beginPath(); x.moveTo(pad, y - 22); x.lineTo(W - pad, y - 22); x.stroke();
  linea('Debe entregar en total', fmtMoney(debeEntregar), '#ff7a2e', true);
  linea('Ya entregó', fmtMoney(c.cash_total), '#f6f1e7');
  linea(falta > 0.005 ? 'Le falta entregar' : 'Cuenta saldada',
        fmtMoney(Math.max(0, falta)), falta > 0.005 ? '#e8706a' : '#7ee2a8', true);

  y += 12;
  x.fillStyle = 'rgba(255,150,80,.65)'; x.font = '600 13px "Space Grotesk", monospace';
  x.fillText('CÓMO FUE PAGANDO', pad, y); y += 30;

  if (!c.payments.length) {
    x.fillStyle = 'rgba(246,241,231,.45)'; x.font = '500 16px Manrope, sans-serif';
    x.fillText('Todavía no ha entregado nada.', pad, y);
  }
  // del más viejo al más nuevo: se lee como una historia
  [...c.payments].reverse().forEach((p, i) => {
    x.fillStyle = i % 2 ? 'rgba(255,255,255,.028)' : 'rgba(255,255,255,.05)';
    roundRect(x, pad, y - 4, W - pad * 2, 84, 14); x.fill();
    // El número de pago va primero: es la referencia con la que el vendedor
    // reclama ("el pago 3 no me lo contaste").
    x.fillStyle = 'rgba(255,150,80,.8)'; x.font = '700 12px "Space Grotesk", monospace';
    x.fillText(`PAGO ${p.n}`, pad + 18, y + 30);
    const wn = x.measureText(`PAGO ${p.n}`).width;
    x.fillStyle = '#f6f1e7'; x.font = '800 22px "Space Grotesk", monospace';
    x.fillText(fmtMoney(p.cash), pad + 28 + wn, y + 30);
    const w = pad + 28 + wn + x.measureText(fmtMoney(p.cash)).width;
    x.fillStyle = 'rgba(246,241,231,.5)'; x.font = '600 13px Manrope, sans-serif';
    x.fillText('en efectivo', w + 8, y + 30);
    x.textAlign = 'right';
    x.fillStyle = 'rgba(246,241,231,.55)'; x.font = '600 13px Manrope, sans-serif';
    x.fillText(p.created_at.slice(0, 16).replace('T', ' '), W - pad - 18, y + 28);
    x.textAlign = 'left';
    x.fillStyle = 'rgba(246,241,231,.6)'; x.font = '500 13.5px Manrope, sans-serif';
    x.fillText(`Cubrió ${fmtMoney(p.amount)} de su cuenta · comisión ${fmtMoney(p.commission)}` +
               `  ·  quedó debiendo ${fmtMoney(p.balance_after)}` +
               (p.note ? `  ·  ${p.note}` : ''), pad + 18, y + 58);
    y += 96;
  });

  x.fillStyle = 'rgba(246,241,231,.32)'; x.font = '500 12px Manrope, sans-serif';
  x.fillText('Generado el ' + new Date().toLocaleString('es-MX'), pad, H - 20);

  cv.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const slug = s.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'vendedor';
    a.download = 'cuenta_' + slug + '.png';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }, 'image/png');
  toast('Estado de cuenta descargado');
}

$('#sl-filter-admin').addEventListener('change', () => { _sigSellers = ''; loadSellers(); });
$('#sl-q').addEventListener('input', () => { _sigSellers = ''; loadSellers(); });

$('#btn-sl-create').addEventListener('click', async () => {
  const btn = $('#btn-sl-create');
  if (btn.disabled) return;   // evita doble-clic → vendedor duplicado
  $('#sl-err').textContent = '';
  const name = $('#sl-name').value.trim();
  if (!name) { $('#sl-err').textContent = 'Escribe el nombre'; return; }
  btn.disabled = true;
  try {
    let r;
    try {
      r = await API.post('/api/admin/sellers', { name });   // código siempre automático
    } catch (e) {
      // Nombre repetido: se avisa y se deja decidir, no se crea a ciegas. Con 30
      // vendedores, dos "Luis" hacen que al cobrar se abra la cuenta equivocada.
      if (!e.data || !e.data.duplicate) throw e;
      btn.disabled = false;
      const ok = await confirmModal({
        title: 'Ese nombre ya existe',
        body: `${esc(e.message)}<br><br>Si son dos personas distintas, ponles algo que
               las distinga (apellido, apodo). Si no, al cobrar vas a abrir la cuenta equivocada.`,
        okLabel: 'Crearlo de todos modos',
      });
      if (!ok) { $('#sl-err').textContent = ''; return; }
      btn.disabled = true;
      r = await API.post('/api/admin/sellers', { name, force: true });
    }
    $('#sl-name').value = '';
    modal(`<div class="h1" style="font-size:18px">Vendedor creado</div>
      <div class="muted mt8">Comparte su código de acceso. Es su identidad en el sistema:</div>
      <div style="text-align:center;margin:18px 0"><span class="codechip" style="font-size:30px;padding:12px 22px">${esc(r.code)}</span></div>
      <button class="btn" onclick="closeModal()">Listo</button>`);
    loadSellers();
  } catch (e) { if (!guard(e)) $('#sl-err').textContent = e.message; }
  finally { btn.disabled = false; }
});

/* Alta masiva: se pegan los nombres y salen todos con su código. Con 50 vendedores,
   capturarlos de uno en uno son 50 formularios y 50 códigos copiados a mano. */
$('#btn-sl-bulk').addEventListener('click', () => {
  modal(`<div class="h1" style="font-size:18px">Cargar varios vendedores</div>
    <div class="muted mt8" style="font-size:12px">Un nombre por línea. A cada uno se le asigna
      su código de 5 dígitos.</div>
    <textarea class="input mt12" id="bk-names" rows="8" placeholder="Ana Pérez
Luis Canul
María Chi" style="resize:vertical;line-height:1.6"></textarea>
    <div class="err mt8" id="bk-err"></div>
    <div class="row mt16"><button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
    <button class="btn grow" id="bk-go">Crear todos</button></div>`);
  $('#bk-go').onclick = async () => {
    const names = $('#bk-names').value;
    if (!names.trim()) { $('#bk-err').textContent = 'Pega al menos un nombre'; return; }
    $('#bk-go').disabled = true;
    try {
      const r = await API.post('/api/admin/sellers/bulk', { names });
      mostrarCodigos(r.creados, r.repetidos);
      loadSellers();
    } catch (e) { if (!guard(e)) $('#bk-err').textContent = e.message; }
    finally { $('#bk-go').disabled = false; }
  };
});

/* El resultado sirve para REPARTIR: nombre y código en una lista que se copia de un
   toque y se pega en WhatsApp. Sin esto habría que ir vendedor por vendedor
   apuntando su código a mano, que es justo lo que se quería evitar. */
function mostrarCodigos(creados, repetidos) {
  const texto = creados.map(c => `${c.name}: ${c.code}`).join('\n');
  modal(`<div class="h1" style="font-size:18px">${creados.length} vendedor(es) creados</div>
    ${repetidos.length ? `<div class="muted mt8" style="font-size:11.5px;color:var(--danger)">
      Ya existían y se omitieron: ${esc(repetidos.join(', '))}</div>` : ''}
    <div class="scrolly mt12" style="max-height:44dvh;overflow:auto">
      ${creados.map(c => `
        <div class="row" style="justify-content:space-between;gap:10px;padding:9px 2px;
          border-bottom:1px solid rgba(255,120,40,.12)">
          <div style="font:700 13px Manrope;min-width:0;overflow:hidden;
            text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</div>
          <span class="codechip">${esc(c.code)}</span>
        </div>`).join('')}
    </div>
    <button class="btn mt16" id="bk-copy">Copiar la lista</button>
    <button class="btn ghost mt8" onclick="closeModal()">Listo</button>`);
  $('#bk-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      toast('Lista copiada · pégala en WhatsApp');
    } catch (_) {
      // sin permiso de portapapeles (pasa en algunos navegadores): se muestra para
      // seleccionar a mano en vez de dejar al admin sin salida
      modal(`<div class="h1" style="font-size:17px">Copia la lista</div>
        <textarea class="input mt12" rows="10" style="line-height:1.6">${esc(texto)}</textarea>
        <button class="btn mt12" onclick="closeModal()">Listo</button>`);
    }
  };
}

/* Opciones que casi no se usan, fuera de la fila para que no estorben. */
function menuVendedor(s) {
  modal(`<div class="h1" style="font-size:17px">${esc(s.name)}</div>
    <div class="muted mt8" style="font-size:12px">Código ${s.code ? esc(s.code) : 'privado'} \u00b7 ${s.tickets} boleto(s) vendidos</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">
      <!-- El colíder da de baja a los suyos: él los dio de alta y sabe quién ya no
           está. Lo único que sigue siendo del organizador es cambiarles el nombre o
           el código, que es identidad y no debe moverse dentro del grupo. -->
      ${_coliderAplicado ? `<div class="muted" style="font-size:12px;line-height:1.5">
        Cambiarle el nombre o el código lo hace un administrador.</div>` : `
      <button class="btn ghost" id="mv-edit">Editar nombre</button>`}
      <button class="btn ghost" id="mv-toggle">${s.active ? 'Desactivar' : 'Reactivar'} su acceso</button>
      <button class="btn danger" id="mv-del">Eliminar vendedor</button>
      <button class="btn quiet" onclick="closeModal()">Cancelar</button>
    </div>`);
  // editar el nombre sigue siendo del organizador; dar de baja, no
  if (!_coliderAplicado) $('#mv-edit').onclick = () => editSeller(s);
  $('#mv-toggle').onclick = () => toggleSeller(s);
  $('#mv-del').onclick = () => deleteSeller(s);
}

async function editSeller(s) {
  // La comisión no es igual para todos: unos llevan 10%, otros 15 y otros nada.
  // Se lee la suya para poder mostrarla tal cual está.
  let cta = {};
  try { cta = await API.get(`/api/admin/sellers/${s.id}/payments`); } catch (_) {}
  const propia = cta.commission_propia === true;
  const general = cta.commission_general != null ? cta.commission_general : 10;
  modal(`<div class="h1" style="font-size:18px">Editar vendedor</div>
    <div class="label mt12">Nombre</div><input class="input" id="es-name" value="${esc(s.name)}">
    <div class="label mt12">Código de 5 dígitos</div>
    <input class="input" id="es-code" value="${esc(s.code)}" maxlength="5" inputmode="numeric">
    <div class="muted mt8">Si cambias el código, su sesión actual se cierra.</div>

    <div class="label mt16">Su comisión</div>
    ${cta.en_grupo ? `<div class="muted" style="font-size:11.5px;line-height:1.5;
      border:1px dashed rgba(243,210,122,.3);border-radius:10px;padding:9px 11px">
      Es del grupo de <b style="color:var(--cream)">${esc(s.owner_admin_name || 'su colíder')}</b>.
      Ahí la comisión la lleva el colíder sobre el total que junta el grupo, y él
      decide qué le da a su gente: por eso este vendedor entrega el 100%.</div>` : `
    <label class="row" style="gap:8px;cursor:pointer">
      <input type="checkbox" id="es-com-on" ${propia ? 'checked' : ''}>
      <span style="font:600 13px Manrope;color:var(--cream)">Ponerle un porcentaje distinto</span></label>
    <div id="es-com-box" style="${propia ? '' : 'display:none'}">
      <!-- Los de un toque. Subirle a alguien de 10 a 20 por cumplir su meta no
           debería obligar a teclear en un campo numérico en el celular, que es
           donde se hace esto casi siempre. El campo sigue ahí para cualquier otro. -->
      <div class="row mt8" style="gap:6px;flex-wrap:wrap">
        ${[0, 10, 15, 20, 25].map(n => `<button class="btn sm ghost es-com-q" data-pct="${n}"
          style="width:auto;padding:9px 14px;flex:none">${n}%</button>`).join('')}
      </div>
      <div class="row mt8" style="gap:8px;align-items:center">
        <input class="input" id="es-com" type="number" min="0" max="100" step="0.5"
          value="${propia ? cta.commission_pct : general}" style="width:110px">
        <span style="font:700 15px Manrope;color:var(--cream-60)">%</span>
      </div>
    </div>`}
    <div class="muted mt8" style="font-size:11px" id="es-com-hint"></div>
    <div class="err mt8" id="es-err"></div>
    <div class="row mt16">
      <button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
      <button class="btn grow" id="es-save">Guardar</button>
    </div>`);
  const sincroniza = () => {
    if (!$('#es-com-on')) return;   // en un grupo no hay porcentaje que ajustar
    const on = $('#es-com-on').checked;
    $('#es-com-box').style.display = on ? '' : 'none';
    const v = parseFloat($('#es-com').value);
    // el atajo que está puesto se marca, para ver de un vistazo en cuánto va
    $$('.es-com-q').forEach(b => b.classList.toggle('sel', on && parseFloat(b.dataset.pct) === v));
    $('#es-com-hint').innerHTML = !on
      ? `Usa la comisi\u00f3n general: <b>${general}%</b>`
      : (v > 0
          ? `De cada $100 que te entregue, se queda <b>$${v.toFixed(2)}</b>.
             Lo que ya le cobraste no cambia: cada pago guard\u00f3 el suyo.`
          : '<b style="color:var(--danger)">Sin comisi\u00f3n</b>: te entrega todo lo que venda');
  };
  $('#es-com-on').onchange = sincroniza;
  $('#es-com').oninput = sincroniza;
  $$('.es-com-q').forEach(b => b.onclick = () => {
    $('#es-com').value = b.dataset.pct; sincroniza();
  });
  sincroniza();
  $('#es-save').onclick = async () => {
    try {
      await API.put('/api/admin/sellers/' + s.id, {
        name: $('#es-name').value.trim(), code: $('#es-code').value.trim(),
        // "" devuelve al vendedor a la comisión general
        commission_pct: $('#es-com-on').checked ? $('#es-com').value : '',
      });
      closeModal(); toast('Vendedor actualizado'); loadSellers();
    } catch (e) { if (!guard(e)) $('#es-err').textContent = e.message; }
  };
}

async function toggleSeller(s) {
  if (s.active) {
    const ok = await confirmModal({
      title: 'Desactivar a ' + esc(s.name),
      body: 'Su código dejará de funcionar y su sesión se cerrará de inmediato. Su historial y boletos se conservan. Puedes reactivarlo cuando quieras.',
      okLabel: 'Desactivar', danger: true,
    });
    if (!ok) return;
  }
  try {
    await API.post(`/api/admin/sellers/${s.id}/toggle`);
    toast(s.active ? 'Vendedor desactivado, sesión cerrada' : 'Vendedor reactivado');
    loadSellers();
  } catch (e) { if (!guard(e)) toast(e.message); }
}

async function deleteSeller(s) {
  // RF-88: advertir cuántos boletos quedarán asociados
  const ok = await confirmModal({
    title: 'Eliminar a ' + esc(s.name),
    body: `Esta cuenta se eliminará y su código quedará libre.<br><br>
      <b style="color:var(--ember-soft)">${s.tickets_all} boleto(s)</b> que generó se conservarán
      marcados con su nombre; no se borran.`,
    okLabel: 'Eliminar cuenta', danger: true,
  });
  if (!ok) return;
  try {
    await API.del('/api/admin/sellers/' + s.id);
    toast('Cuenta eliminada; sus boletos se conservan');
    loadSellers();
  } catch (e) { if (!guard(e)) toast(e.message); }
}

/* ---------------- catálogos ---------------- */
// Fases GLOBALES: se agrupan las fases de todos los tipos por (fecha + nombre).
// Cada grupo es "una fase de venta" que sube todos los boletos a la vez.
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
               'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fechaCorta(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${MESES[m - 1]}`;
}
function diaAntes(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const f = new Date(y, m - 1, d - 1);
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
}

function renderPhases(types) {
  const groups = {};   // clave "fecha|nombre" -> {name, starts_on, byType:{id:price_cents}}
  types.forEach(t => (t.phases || []).forEach(p => {
    const key = p.starts_on + '|' + p.name;
    const g = (groups[key] = groups[key] || { name: p.name, starts_on: p.starts_on, byType: {} });
    g.byType[t.id] = p.price_cents;
    g.flashByType = g.flashByType || {};
    if (p.flash_price_cents) g.flashByType[t.id] = p.flash_price_cents;
  }));
  // El calendario se lee como tabla: cada fase con su DESDE y su HASTA. El "hasta"
  // no se guarda —lo marca el arranque de la siguiente— pero tener que restarle un
  // día de cabeza a ocho fechas es justo donde se cuela el error.
  const arr = Object.values(groups).sort((a, b) => a.starts_on < b.starts_on ? -1 : 1);
  const today = new Date().toLocaleDateString('en-CA');   // AAAA-MM-DD local
  const list = $('#ph-list');
  list.innerHTML = arr.length ? '' :
    '<div class="muted" style="font-size:12px">Sin fases todavía. Agrega la primera abajo.</div>';
  arr.forEach((g, i) => {
    const sig = arr[i + 1];                       // la fase que la termina
    const vigente = g.starts_on <= today && (!sig || sig.starts_on > today);
    // Cuántos días dura: hasta que arranca la siguiente. Se muestra porque un
    // calendario de 8 bloques no se puede verificar sumando fechas de cabeza.
    const dias = sig
      ? Math.round((new Date(sig.starts_on) - new Date(g.starts_on)) / 86400000)
      : null;
    const conFlash = Object.keys(g.flashByType || {}).length > 0;
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 11px;border-radius:11px;margin-bottom:6px;background:rgba(255,255,255,.03);border:1px solid '
      + (vigente ? 'var(--ember)' : 'rgba(255,120,40,.15)');
    const top = document.createElement('div');
    top.className = 'row'; top.style.justifyContent = 'space-between';
    top.innerHTML = `<div style="font:700 12px Manrope">${esc(g.name)}${conFlash
        ? ' <span style="color:#f3d27a;font-size:9px">⚡ CON FLASH</span>' : ''}${
        vigente ? ' <span style="color:var(--ember-soft);font-size:9px">● VIGENTE</span>' : ''}</div>
      <div class="muted" style="font-size:11px;text-align:right">${esc(fechaCorta(g.starts_on))}
        → ${sig ? esc(fechaCorta(diaAntes(sig.starts_on))) : 'el evento'}${
        dias ? `<div style="font-size:9.5px">${dias} día${dias === 1 ? '' : 's'}</div>` : ''}</div>`;
    // Editar va PRIMERO y borrar detrás de un "¿seguro?": la ✕ estaba sola y sin
    // aviso, así que quien quería cambiar un precio terminaba borrando la fase —y no
    // había forma de deshacerlo salvo teclearla otra vez completa.
    const ed = document.createElement('button');
    ed.className = 'btn sm ghost';
    ed.style.cssText = 'width:auto;flex:none;padding:5px 10px;font-size:11px;margin-left:auto;margin-right:6px';
    ed.textContent = 'Editar';
    ed.onclick = () => editarFase(g, types);
    top.appendChild(ed);
    const del = document.createElement('button');
    del.className = 'iconbtn'; del.style.cssText = 'width:26px;height:26px;font-size:11px';
    del.title = 'Eliminar fase'; del.textContent = '✕';
    del.onclick = async () => {
      const detalle = types.map(t => g.byType[t.id] != null
        ? `${esc(t.name)} ${fmtMoney(g.byType[t.id] / 100)}` : null).filter(Boolean).join(' · ');
      const ok = await confirmModal({
        title: `Eliminar ${g.name}`, danger: true, okLabel: 'Eliminar la fase',
        body: `Se borra la fase que arranca el <b style="color:var(--cream)">${esc(g.starts_on)}</b>
          con todos sus precios:<br><span class="muted">${detalle || 'sin precios'}</span>
          <br><br>Los boletos ya vendidos no cambian. Si solo quieres corregir un precio,
          usa <b style="color:var(--cream)">Editar</b>.`,
      });
      if (!ok) return;
      try {
        await API.del(`/api/admin/phases-all?name=${encodeURIComponent(g.name)}&starts_on=${encodeURIComponent(g.starts_on)}`);
        toast('Fase eliminada'); loadCatalogs();
      } catch (e) { if (!guard(e)) toast(e.message); }
    };
    top.appendChild(del);
    row.appendChild(top);
    const pr = document.createElement('div');
    pr.style.cssText = 'margin-top:5px;display:flex;gap:12px;flex-wrap:wrap';
    pr.innerHTML = types.map(t => {
      const c = g.byType[t.id];
      return `<span style="font:600 11px Manrope;color:var(--cream-60)">${esc(t.name)}${estrellaDe({ type_name: t.name, type_is_vip: t.is_vip }) ? ' ★' : ''}: <b style="color:var(--ember-soft)">${c != null ? fmtMoney(c / 100) : '—'}</b></span>`;
    }).join('');
    row.appendChild(pr);
    // El precio de venta flash DE ESTA FASE, a la vista. Es lo que se cobrará si el
    // botón está prendido mientras ella corre; sin esta línea había que esperar a que
    // llegara su fecha para poder verlo.
    if (conFlash) {
      const fl = document.createElement('div');
      fl.style.cssText = 'margin-top:5px;display:flex;gap:12px;flex-wrap:wrap;'
        + 'padding-top:5px;border-top:1px dashed rgba(243,210,122,.25)';
      fl.innerHTML = '<span style="font:700 10px Manrope;color:#f3d27a">⚡ EN VENTA FLASH</span>'
        + types.map(t => {
          const c = g.flashByType[t.id];
          if (c == null) return '';
          return `<span style="font:600 11px Manrope;color:var(--cream-60)">${esc(t.name)}: <b style="color:#f3d27a">${fmtMoney(c / 100)}</b></span>`;
        }).join('');
      row.appendChild(fl);
    }
    list.appendChild(row);
  });
  // formulario de alta: nombre + fecha + un precio por cada tipo
  const add = $('#ph-add');
  add.innerHTML = `
    <div class="row" style="gap:6px;flex-wrap:wrap;align-items:flex-end">
      <label style="font:600 10px Manrope;color:var(--cream-60);display:flex;flex-direction:column;gap:3px;flex:1;min-width:130px">Nombre de la fase
        <input class="input" id="ph-name" placeholder="ej. Fase 2" style="padding:9px;font-size:12px"></label>
      <label style="font:600 10px Manrope;color:var(--cream-60);display:flex;flex-direction:column;gap:3px">Arranca el
        <input class="input" id="ph-date" type="date" style="width:150px;padding:9px;font-size:12px"></label>
    </div>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px;align-items:flex-end">
      ${types.map(t => `<label style="font:600 10px Manrope;color:var(--cream-60);display:flex;flex-direction:column;gap:3px">${esc(t.name)}${estrellaDe({ type_name: t.name, type_is_vip: t.is_vip }) ? ' ★' : ''} — precio nuevo
        <input class="input" type="number" min="1" placeholder="$" data-ph-price="${t.id}" style="width:110px;padding:9px;font-size:12px"></label>`).join('')}
    </div>
    <!-- La venta flash NO es otra fase con otra fecha: es el precio al que queda ESTA
         fase cuando se prende el botón. Así no puede haber dos ofertas peleándose ni
         una encendida sin forma de apagarla. -->
    <div class="label" style="margin:14px 0 4px;color:#f3d27a">⚡ Precio en venta flash <span class="muted" style="font-weight:600">(opcional)</span></div>
    <div class="muted" style="font-size:10.5px;margin-bottom:7px;line-height:1.5">A cuánto queda cada boleto si prendes la venta flash mientras corre esta fase. Déjalo en blanco si esta fase no lleva oferta. <b>Ninguna fecha lo enciende: solo el botón de arriba.</b></div>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
      ${types.map(t => `<label style="font:600 10px Manrope;color:var(--cream-60);display:flex;flex-direction:column;gap:3px">${esc(t.name)} — en flash
        <input class="input" type="number" min="1" placeholder="—" data-ph-flash="${t.id}" style="width:110px;padding:9px;font-size:12px"></label>`).join('')}
    </div>
    <button class="btn sm mt12" id="btn-ph-create" style="width:100%">+ Crear fase</button>`;

  $('#btn-ph-create').onclick = async () => {
    const prices = {}, flash = {};
    types.forEach(t => {
      const v = add.querySelector(`[data-ph-price="${t.id}"]`).value.trim();
      if (v) prices[t.id] = parseFloat(v);
      const f = add.querySelector(`[data-ph-flash="${t.id}"]`).value.trim();
      if (f) flash[t.id] = parseFloat(f);
    });
    $('#ph-err').textContent = '';
    try {
      await API.post('/api/admin/phases-all',
        { name: $('#ph-name').value.trim(), starts_on: $('#ph-date').value, prices, flash });
      loadCatalogs();
    } catch (e) { if (!guard(e)) $('#ph-err').textContent = e.message; }
  };
}

/* Cambiar una fase que ya existe. El caso real: la fase se creó cuando el Ultra VIP
   todavía no tenía precio, y ahora hay que ponérselo sin volver a escribir las otras
   tres. En blanco = ese tipo no entra en la fase y se queda en su precio base. */
function editarFase(g, types) {
  modal(`<div class="h1" style="font-size:18px">Editar ${esc(g.name)}</div>
    <div class="muted mt8" style="font-size:12px">Los boletos ya generados no cambian de precio: cada uno congeló el suyo al venderse.</div>
    <div class="row mt16" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
      <label class="grow" style="font:600 11px Manrope;color:var(--cream-60);display:flex;flex-direction:column;gap:4px;min-width:140px">Nombre
        <input class="input" id="ef-name" value="${esc(g.name)}"></label>
      <label style="font:600 11px Manrope;color:var(--cream-60);display:flex;flex-direction:column;gap:4px">Arranca el
        <input class="input" id="ef-date" type="date" value="${esc(g.starts_on)}" style="width:165px"></label>
    </div>
    <div class="label mt16">Precios de esta fase</div>
    <div class="muted" style="font-size:11px;margin-bottom:8px">Deja en blanco el tipo que no entre en la fase.</div>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${types.map(t => `<label style="font:600 11px Manrope;color:var(--cream-60);display:flex;flex-direction:column;gap:4px;flex:1;min-width:110px">${esc(t.name)}${estrellaDe({ type_name: t.name, type_is_vip: t.is_vip }) ? ' ★' : ''}
        <input class="input ef-p" data-tid="${t.id}" type="number" min="0" step="1" inputmode="decimal"
          placeholder="—" value="${g.byType[t.id] != null ? g.byType[t.id] / 100 : ''}"></label>`).join('')}
    </div>
    <div class="label mt16" style="color:#f3d27a">⚡ Precio en venta flash <span class="muted" style="font-weight:600">(opcional)</span></div>
    <div class="muted" style="font-size:11px;margin-bottom:8px">A cuánto queda cada boleto si prendes la venta flash mientras corre esta fase. En blanco = esta fase no lleva oferta.</div>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${types.map(t => `<label style="font:600 11px Manrope;color:var(--cream-60);display:flex;flex-direction:column;gap:4px;flex:1;min-width:110px">${esc(t.name)}
        <input class="input ef-f" data-tid="${t.id}" type="number" min="0" step="1" inputmode="decimal"
          placeholder="—" value="${g.flashByType && g.flashByType[t.id] != null ? g.flashByType[t.id] / 100 : ''}"></label>`).join('')}
    </div>
    <div class="err mt8" id="ef-err"></div>
    <div class="row mt16">
      <button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
      <button class="btn grow" id="ef-save">Guardar cambios</button>
    </div>`);
  $('#ef-save').onclick = async () => {
    const prices = {}, flash = {};
    $$('.ef-p').forEach(i => { prices[i.dataset.tid] = i.value.trim(); });
    $$('.ef-f').forEach(i => { flash[i.dataset.tid] = i.value.trim(); });
    try {
      await API.put('/api/admin/phases-all', {
        orig_name: g.name, orig_starts_on: g.starts_on,
        name: $('#ef-name').value.trim(), starts_on: $('#ef-date').value, prices, flash,
      });
      closeModal(); toast('Fase actualizada'); loadCatalogs();
    } catch (e) { if (!guard(e)) $('#ef-err').textContent = e.message; }
  };
}

/* ---------------- rendimiento: cómo se está moviendo la venta ----------------

   La idea es dejar de investigar: en vez de abrir cinco pantallas y comparar de
   memoria, aquí está el promedio contra el que se mide cada quien y la observación
   ya escrita —siempre con su número al lado, para poder comprobarla—.

   Es una pantalla que SOLO LEE. No tiene un botón que cambie nada. */
let _sigRend = null;
async function loadRendimiento(silent) {
  let r;
  try { r = await API.get('/api/admin/rendimiento'); }
  catch (e) {
    // Antes se salía en silencio: si la primera carga fallaba —un 401 al entrar, la
    // señal que se cae— la pestaña se quedaba EN BLANCO sin decir por qué, y solo
    // se arreglaba recargando la página.
    if (guard(e)) return;
    const c = $('#rd-analisis');
    if (c && !RD_VEND.length) {
      c.innerHTML = `<div class="muted" style="font-size:12px">No se pudo cargar:
        ${esc(e.message || 'sin conexión')}.</div>
        <button class="btn sm mt8" id="rd-reintentar" style="width:auto">Reintentar</button>`;
      const b = $('#rd-reintentar');
      if (b) b.onclick = () => loadRendimiento();
    }
    return;
  }
  const sig = JSON.stringify(r);
  if (silent && sig === _sigRend) return;
  _sigRend = sig;
  // La lista y sus filtros se pintan PRIMERO y aparte. Estaban al final, así que
  // cualquier tropiezo en lo de arriba —una gráfica, un desglose— los dejaba sin
  // número y sin hacer nada, que es justo lo que pasó.
  RD_PROM = (r.totales || {}).prom_boletos || 0;
  RD_VEND = r.vendedores || [];
  try { pintarRendVendedores(); }
  catch (e) { console.error('lista de vendedores:', e); }

  const T = r.totales;
  // El acumulado siempre sube y por eso nunca preocupa: lo que dice si la venta se
  // movió es HOY y esta semana, así que van arriba con lo demás.
  $('#rd-stats').innerHTML = `
    <div class="rk-st"><i>Vendido</i><b>${fmtMoney(Math.round(T.monto))}</b></div>
    <div class="rk-st"><i>Boletos</i><b>${T.boletos}</b></div>
    <div class="rk-st"><i>Hoy</i><b>${T.hoy_boletos}<small>${fmtMoney(Math.round(T.hoy_monto))}</small></b></div>
    <div class="rk-st"><i>7 días</i><b>${T.sem_boletos}<small>${fmtMoney(Math.round(T.sem_monto))}</small></b></div>
    <div class="rk-st"><i>Vendiendo</i><b>${T.activos}<small>+${T.inactivos} en 0</small></b></div>
    <div class="rk-st"><i>Boleto prom.</i><b>${fmtMoney(Math.round(T.ticket_prom))}</b></div>`;

  // ----- la curva: cuánto se lleva acumulado, día a día -----
  try { pintarCurva(r.calendario || []); } catch (e) { console.error('la gráfica:', e); }

  // ----- el calendario, mes por mes -----
  // Un mes a la vez, con flechas. Los 97 días seguidos no cabían y obligaban a
  // deslizar; así se ve el mes en curso completo y se avanza al siguiente, que sale
  // apagado porque son días que todavía no pasan.
  RD_CAL = r.calendario || [];
  RD_EVENTO = r.evento;
  RD_FALTAN = r.dias_faltan;
  RD_MES = null;   // null = el mes de hoy
  try { pintarCalendario(); } catch (e) { console.error('el calendario:', e); }

  $('#rd-tipos').innerHTML = (r.por_tipo || []).map(t => `
    <div class="rd-tipo">
      <div class="rd-tn">${esc(t.nombre || '—')}</div>
      <div class="rd-tbar"><span style="width:${t.pct}%"></span></div>
      <div class="rd-tv">${t.boletos}<small>${fmtMoney(t.monto)}</small></div>
    </div>`).join('') || '<div class="muted" style="font-size:12px">Sin ventas todavía.</div>';

  // ----- por administrador -----
  // Al colíder no se le enseña: son los números del evento entero y de gente que no
  // es suya. Él ve su grupo y nada más, así que la sección ni aparece.
  const adms = r.por_admin || [];
  const cajaAdm = $('#rd-admins') && $('#rd-admins').closest('details');
  if (cajaAdm) cajaAdm.classList.toggle('hidden', !adms.length);
  $('#rd-nadm').textContent = adms.length ? ' · ' + adms.length : '';
  $('#rd-admins').innerHTML = adms.map(a => `
    <div class="rd-fila">
      <div class="rd-fn">${esc(a.admin)}
        <span class="rd-fsub">${a.vendedores} vendedor(es) · boleto prom. ${fmtMoney(Math.round(a.ticket_prom))}</span></div>
      <div class="rd-fv">${fmtMoney(Math.round(a.monto))}<small>${a.boletos} bol · ${a.pct}%</small></div>
    </div>`).join('') || '<div class="muted" style="font-size:12px">Sin datos.</div>';

  // ----- colíderes: lo suyo y lo de su equipo, siempre separado -----
  const cols = r.colideres || [];
  $('#rd-ncol').textContent = cols.length ? ' · ' + cols.length : '';
  RD_COLS = cols;
  $('#rd-colideres').innerHTML = cols.length ? cols.map((c, i) => `
    <div class="rd-fila rd-click" data-col="${i}">
      <div class="rd-fn">${esc(c.nombre)}
        <span class="rd-fsub">${c.equipo.activos} de ${c.equipo.vendedores} vendiendo${
          c.equipo.sin_vender ? ' · ' + c.equipo.sin_vender + ' en cero' : ''} · ver grupo ›</span></div>
      <div class="rd-fv">${fmtMoney(Math.round(c.total.monto))}<small>${c.total.boletos} bol · ${c.pct}%</small></div>
    </div>`).join('') : '<div class="muted" style="font-size:12px">No hay colíderes todavía.</div>';
  $$('#rd-colideres .rd-click').forEach(f => {
    f.onclick = () => verGrupo(RD_COLS[Number(f.dataset.col)]);
  });

  // ----- el tablero -----
  // Números, no párrafos. Lo que se quiere saber de un vistazo: a qué ritmo va, a
  // dónde llega el 31 de octubre, si subió o bajó, y qué falta por cobrar.
  const AN = r.analisis || {};
  const tend = AN.tendencia;
  const sinT = (tend === null || tend === undefined);
  const flecha = sinT ? '' : (tend > 0 ? '▲' : tend < 0 ? '▼' : '=');
  const tono = sinT ? '' : (tend > 0 ? 'bien' : tend < 0 ? 'mal' : '');
  $('#rd-analisis').innerHTML = `
    <div class="rd-tablero">
      <div class="rd-t">
        <i>Ritmo</i><b>${AN.ritmo_dia || 0}<u>/día</u></b>
        <span>${AN.sem_n || 0} en 7 días</span>
      </div>
      <div class="rd-t">
        <i>Proyección</i><b>${AN.proyeccion || 0}</b>
        <span>al 31 oct · hoy ${T.boletos}</span>
      </div>
      <div class="rd-t ${tono}">
        <i>Tendencia</i><b>${flecha} ${sinT ? '—' : Math.abs(tend) + '%'}</b>
        <span>vs semana pasada</span>
      </div>
      <div class="rd-t ${AN.pct_cobrar >= 50 ? 'mal' : ''}">
        <i>Por cobrar</i><b>${fmtMoney(Math.round(AN.por_cobrar || 0))}</b>
        <span>${AN.pct_cobrar || 0}% de lo vendido</span>
      </div>
    </div>
    <div class="rd-sem">
      <button type="button" class="rd-p critico" id="rd-ver-rojo">${AN.criticos} en rojo ›</button>
      <button type="button" class="rd-p atencion" id="rd-ver-ambar">${AN.atencion} por atender ›</button>
      <span class="rd-p bien">${AN.bien} bien</span>
      ${T.inactivos ? `<span class="rd-p neutro">${T.inactivos} sin vender</span>` : ''}
      <span class="rd-p neutro">top 3 = ${AN.pct_top3 || 0}%</span>
    </div>`;
  const vr = $('#rd-ver-rojo'), va = $('#rd-ver-ambar');
  if (vr) vr.onclick = () => verAlertas('critico');
  if (va) va.onclick = () => verAlertas('atencion');

}

/* El buscador: con muchos vendedores, encontrar a uno era deslizar hasta hallarlo.
   Filtra sobre lo ya cargado, sin volver a preguntarle al servidor. */
let RD_VEND = [], RD_PROM = 0, RD_EST = 'todos', RD_COLS = [], RD_VIS = [];
document.addEventListener('input', e => {
  if (e.target && e.target.id === 'rd-q') pintarRendVendedores();
});
// delegado a propósito: el filtro sigue funcionando aunque los botones se vuelvan a
// dibujar, y no depende de que alguien se acuerde de reconectarlos
document.addEventListener('click', e => {
  const b = e.target && e.target.closest && e.target.closest('#rd-filtros .rd-f');
  if (!b) return;
  RD_EST = b.dataset.est;
  pintarRendVendedores();
});

function inicialesDe(nombre) {
  const p = String(nombre || '?').trim().split(/\s+/);
  return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

/* La ficha de cada vendedor. Antes era una línea de texto corrido con tres datos
   pegados; ahora cada número va en su casilla, con su etiqueta encima, y el estado
   se ve por el color del borde antes de leer nada. */
function pintarRendVendedores() {
  const q = ($('#rd-q') && $('#rd-q').value || '').trim().toLowerCase();
  let vis = RD_VEND;
  if (RD_EST !== 'todos') vis = vis.filter(v => v.estado === RD_EST);
  if (q) vis = vis.filter(v => (v.name || '').toLowerCase().includes(q));
  // El estado marcado Y el número de cada filtro se ponen aquí, donde ya está la
  // lista: el bloque que los ponía vivía en el cargador y se perdió al reacomodar
  // esta pantalla —los botones quedaron sin cuenta y sin hacer nada—.
  $$('#rd-filtros .rd-f').forEach(b => {
    b.classList.toggle('sel', b.dataset.est === RD_EST);
    const n = b.dataset.est === 'todos' ? RD_VEND.length
      : RD_VEND.filter(v => v.estado === b.dataset.est).length;
    const c = b.querySelector('b');
    if (c) c.textContent = n;
  });
  const tope = Math.max(1, ...RD_VEND.map(v => v.monto));
  RD_VIS = vis;
  $('#rd-lista').innerHTML = vis.map((v, i) => `
    <div class="rd-v ${v.estado}" data-i="${i}">
      <span class="rd-estado"></span>
      <div>
        <div class="rd-vn">${esc(v.name)}</div>
        <span class="rd-vsub">${v.boletos} bol · ${fmtMoney(Math.round(v.ticket_prom))} c/u ·
          ${v.sin_vender === 0 ? 'hoy' : 'hace ' + v.sin_vender + 'd'}</span>
        <div class="rd-vbar"><i style="width:${Math.round(v.monto / tope * 100)}%"></i></div>
      </div>
      <div class="rd-vm">${fmtMoney(Math.round(v.monto))}
        <small>${(v.señales || []).length
          ? `<span class="rd-avisos ${v.estado}">▲ ${v.señales.length}</span>`
          : ''}${v.debe > 0.005
          ? '<span class="rd-debe">debe ' + fmtMoney(Math.round(v.debe)) + '</span>'
          : '<span class="rd-alcorriente" style="font-size:9.5px">al día</span>'}</small></div>
    </div>`).join('') || `<div class="muted" style="padding:14px 2px">${
      q ? 'Nadie con ese nombre.' : 'Nadie en este grupo.'}</div>`;
  $$('#rd-lista .rd-v').forEach(f => {
    f.onclick = () => verVendedor(RD_VIS[Number(f.dataset.i)]);
  });
}

/* Todas las alertas juntas, en una sola ventana. Antes había que abrir vendedor por
   vendedor para enterarse de quién trae qué; esto es la lista de pendientes del día:
   quién está parado, quién vende poco y quién debe dinero, con su número al lado. */
function verAlertas(quePrender) {
  const conAviso = RD_VEND.filter(v => (v.señales || []).length);
  const rojos = conAviso.filter(v => v.estado === 'critico');
  const ambar = conAviso.filter(v => v.estado === 'atencion');
  const bloque = (titulo, lista, clase) => !lista.length ? '' : `
    <div class="rd-alt">
      <div class="rd-altt ${clase}">${titulo} · ${lista.length}</div>
      ${lista.map(v => `
        <div class="rd-alv" data-n="${esc(v.name)}">
          <div class="rd-alnom">${esc(v.name)}
            <span>${v.boletos} bol · ${fmtMoney(Math.round(v.monto))}${
              v.debe > 0.005 ? ' · debe ' + fmtMoney(Math.round(v.debe)) : ''}</span></div>
          ${v.señales.map(x => `<div class="rd-sen ojo">▲ ${esc(x)}</div>`).join('')}
        </div>`).join('')}
    </div>`;
  modal(`
    <div class="h1" style="font-size:18px">Pendientes</div>
    <div class="muted" style="font-size:11.5px;margin-top:3px">
      ${conAviso.length} vendedor(es) con algo que atender. Toca a cualquiera para ver su ficha.</div>
    <!-- la lista desliza dentro de la ventana: si crece, el título y el botón de
         cerrar siguen a la vista en vez de irse fuera de la pantalla -->
    <div class="mt16 rd-scroll">
      ${quePrender === 'atencion' ? bloque('Por atender', ambar, 'amb') + bloque('En rojo', rojos, 'roj')
                                  : bloque('En rojo', rojos, 'roj') + bloque('Por atender', ambar, 'amb')}
      ${conAviso.length ? '' : '<div class="muted" style="font-size:12px">Nadie tiene alertas. Todo en orden.</div>'}
    </div>
    <button class="btn mt16" onclick="closeModal()">Cerrar</button>`);
  $$('#modal .rd-alv').forEach(f => {
    f.onclick = () => verVendedor(RD_VEND.find(v => v.name === f.dataset.n));
  });
}

/* El detalle de un vendedor, en su ventana. En la lista va una fila por persona
   —con 50 vendedores lo demás no cabe— y aquí adentro está todo lo suyo. */
function verVendedor(v) {
  if (!v) return;
  const ETQ = { critico: '🔴 Crítico', atencion: '🟡 Por atender', bien: '🟢 Bien' };
  modal(`
    <div class="row" style="gap:11px;align-items:center">
      <div class="rd-ini">${esc(inicialesDe(v.name))}</div>
      <div style="min-width:0">
        <div class="h1" style="font-size:17px;line-height:1.2">${esc(v.name)}</div>
        <div class="muted" style="font-size:11px;margin-top:2px">${ETQ[v.estado]} ·
          ${v.pct_monto}% de lo vendido</div>
      </div>
      <div style="margin-left:auto;text-align:right">
        <div style="font:800 20px 'Space Grotesk';color:var(--cream)">${fmtMoney(Math.round(v.monto))}</div>
        <div class="muted" style="font-size:10px">${v.boletos} boleto(s)</div>
      </div>
    </div>
    <div class="rd-chips">
      <div><i>Boleto promedio</i><b>${fmtMoney(Math.round(v.ticket_prom))}</b></div>
      <div><i>Ritmo</i><b>${v.ritmo}<span>/día</span></b></div>
      <div><i>vs promedio</i><b>${RD_PROM ? (v.boletos / RD_PROM).toFixed(1) : '—'}<span>×</span></b></div>
      <div><i>Días con venta</i><b>${v.dias_con_venta}</b></div>
      <div class="ancho"><i>Última venta</i><b>${v.sin_vender === 0 ? 'hoy'
        : 'hace ' + v.sin_vender + ' día(s)'}<span> · ${esc(v.ultima || '')}</span></b></div>
      <div class="ancho"><i>Falta entregar</i>${v.debe > 0.005
        ? `<b class="rd-debe">${fmtMoney(Math.round(v.debe))}</b>`
        : '<b class="rd-alcorriente">✓ al día</b>'}</div>
    </div>
    ${(v.buenas || []).map(x => `<div class="rd-sen buena">✓ ${esc(x)}</div>`).join('')}
    ${(v.señales || []).map(x => `<div class="rd-sen ojo">▲ ${esc(x)}</div>`).join('')}
    <button class="btn mt16" onclick="closeModal()">Cerrar</button>`);
}

/* La ventana del grupo de un colíder. En la lista solo va su renglón —con 50
   vendedores, meter el equipo entero de cada uno hacía la pantalla interminable— y
   aquí adentro está todo lo suyo: cuánto puso él, cuánto su gente, y la gráfica de
   quién trae qué dentro del grupo. */
function verGrupo(c) {
  if (!c) return;
  const venden = (c.miembros || []).filter(m => m.boletos > 0);
  const ceros = (c.miembros || []).filter(m => !m.boletos);
  const tope = Math.max(1, ...venden.map(m => m.monto));
  const pctEl = c.total.monto ? Math.round(100 * c.propio.monto / c.total.monto) : 0;
  modal(`
    <div class="h1" style="font-size:18px">Grupo de ${esc(c.nombre)}</div>
    <div class="muted" style="font-size:11.5px;margin-top:3px">
      ${c.equipo.activos} de ${c.equipo.vendedores} vendiendo · ${c.pct}% de todo lo vendido</div>

    <div class="rd-dos mt16">
      <div><i>Él vendió</i><b>${fmtMoney(Math.round(c.propio.monto))}</b>
        <span>${c.propio.boletos} boleto(s) · ${pctEl}% del grupo</span></div>
      <div><i>Su equipo</i><b>${fmtMoney(Math.round(c.equipo.monto))}</b>
        <span>${c.equipo.boletos} boleto(s) · ${100 - pctEl}% del grupo</span></div>
    </div>
    <div class="rd-split">
      <span class="rd-el" style="width:${pctEl}%"></span>
      <span class="rd-eq2" style="width:${100 - pctEl}%"></span>
    </div>

    <div class="label mt16" style="margin-bottom:6px">Quién trae qué en el grupo</div>
    ${venden.length ? `<div class="rd-eq" style="border:none;padding-top:0">${venden.map(m => `
      <div class="rd-m">
        <span class="rd-mn">${m.es_lider ? '<b class="rd-est">★</b> ' : ''}${esc(m.name)}</span>
        <span class="rd-mb"><i style="width:${Math.round(m.monto / tope * 100)}%"></i></span>
        <span class="rd-mv">${fmtMoney(Math.round(m.monto))}<em>${m.boletos}</em></span>
      </div>`).join('')}</div>`
      : '<div class="muted" style="font-size:12px">Nadie del grupo ha vendido todavía.</div>'}

    ${ceros.length ? `<div class="rd-cerosbox">
      <div class="rd-cerost">${ceros.length} sin vender</div>
      <div>${ceros.map(m => esc(m.name)).join(' · ')}</div></div>` : ''}

    <button class="btn mt16" onclick="closeModal()">Cerrar</button>`);
}

/* La gente del colíder. Antes salían todos en fila y los que no han vendido —que
   suelen ser la mayoría— se comían el bloque entero con una lista de ceros. Ahora
   arriba van los que venden, con su barra, y los de cero se resumen en una línea
   que se abre si de verdad se quieren ver. */
function bloqueEquipo(miembros) {
  const ms = miembros || [];
  if (!ms.length) return '';
  const venden = ms.filter(m => m.boletos > 0);
  const ceros = ms.filter(m => !m.boletos);
  const tope = Math.max(1, ...venden.map(m => m.monto));
  return `<div class="rd-eq">
    ${venden.map(m => `
      <div class="rd-m">
        <span class="rd-mn">${m.es_lider ? '<b class="rd-est">★</b> ' : ''}${esc(m.name)}</span>
        <span class="rd-mb"><i style="width:${Math.round(m.monto / tope * 100)}%"></i></span>
        <span class="rd-mv">${fmtMoney(Math.round(m.monto))}<em>${m.boletos}</em></span>
      </div>`).join('')}
    ${ceros.length ? `<details class="rd-ceros">
      <summary>${ceros.length} sin vender todavía</summary>
      <div>${ceros.map(m => esc(m.name)).join(' · ')}</div>
    </details>` : ''}
  </div>`;
}

/* La gráfica de la venta. Por día se ven los PICOS y los bajones —un día de 12 y
   otro de 0 no se distinguen en el acumulado, que solo sabe subir—; el acumulado
   queda como segunda vista para saber a dónde va el total. */
let RD_VISTA = 'dia';   // 'dia' | 'acum'
let RD_PTOS = [];

function pintarCurva(cal) {
  const cont = $('#rd-curva');
  if (!cont) return;
  const hoy = new Date().toLocaleDateString('en-CA');
  RD_PTOS = cal.filter(d => d.dia <= hoy);
  dibujarCurva();
}

function dibujarCurva() {
  const cont = $('#rd-curva');
  const pasados = RD_PTOS;
  if (!cont) return;
  if (pasados.length < 2) { cont.innerHTML = ''; return; }
  const porDia = RD_VISTA === 'dia';
  // por día se miran los últimos 30: más atrás los picos se aplastan y no se leen
  const base = porDia ? pasados.slice(-30) : pasados;
  let acum = 0;
  const total = pasados.reduce((a, d) => a + d.boletos, 0);
  const previos = porDia ? pasados.slice(0, -30).reduce((a, d) => a + d.boletos, 0) : 0;
  acum = previos;
  const pts = base.map(d => ({ dia: d.dia, n: d.boletos, y: porDia ? d.boletos : (acum += d.boletos) }));
  const W = 300, H = 104, PB = 16, PT = 10;
  const maxY = Math.max(1, ...pts.map(p => p.y));
  const minY = porDia ? 0 : Math.min(...pts.map(p => p.y));
  const x = i => (i / (pts.length - 1)) * W;
  const y = v => PT + (H - PT - PB) * (1 - (v - minY) / Math.max(1, maxY - minY));
  const linea = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const area = `${linea}L${W},${H - PB}L0,${H - PB}Z`;
  let pico = 0, valle = 0;
  pts.forEach((p, i) => { if (p.n > pts[pico].n) pico = i; if (p.n < pts[valle].n) valle = i; });
  const corto = d => d.slice(8) + ' ' + ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][Number(d.slice(5,7)) - 1];
  const n = pts.length;
  // la pendiente reciente: últimos 7 días contra los 7 anteriores
  const ult = pasados.slice(-7).reduce((a, d) => a + d.boletos, 0);
  const prev = pasados.slice(-14, -7).reduce((a, d) => a + d.boletos, 0);
  const sube = prev ? Math.round(100 * (ult - prev) / prev) : null;
  const hoyN = pasados[pasados.length - 1].boletos;
  cont.innerHTML = `
    <div class="rd-curva">
      <div class="rd-curva-top">
        <div>
          <b>${porDia ? hoyN : total}</b>
          <span>${porDia ? 'boletos hoy · ' + total + ' en total' : 'boletos acumulados'}</span>
        </div>
        <div class="rd-vistas">
          <button type="button" class="rd-vb ${porDia ? 'sel' : ''}" data-v="dia">Por día</button>
          <button type="button" class="rd-vb ${porDia ? '' : 'sel'}" data-v="acum">Acumulado</button>
        </div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="rd-svg">
        <defs>
          <linearGradient id="gcurva" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#ff7a4d" stop-opacity=".42"/>
            <stop offset="100%" stop-color="#ff7a4d" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#gcurva)"/>
        <path d="${linea}" fill="none" stroke="#ff8a4d" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        ${porDia ? `<circle cx="${x(pico).toFixed(1)}" cy="${y(pts[pico].y).toFixed(1)}" r="3.2"
              fill="#f3d27a" stroke="#2a0f06" stroke-width="1" vector-effect="non-scaling-stroke"/>` : ''}
        ${pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="1.5"
            fill="#ffb27a"/>`).join('')}
        <circle cx="${x(n - 1).toFixed(1)}" cy="${y(pts[n - 1].y).toFixed(1)}" r="3.4"
                fill="#fff" stroke="#ff7a4d" stroke-width="2" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="rd-curva-pie">
        <span>${corto(pts[0].dia)}</span>
        <span class="rd-pico">${porDia
          ? '▲ pico ' + corto(pts[pico].dia) + ' · ' + pts[pico].n + ' bol'
          : (sube === null ? '' : (sube >= 0 ? '▲ ' : '▼ ') + Math.abs(sube) + '% en 7 días')}</span>
        <span>${corto(pts[n - 1].dia)}</span>
      </div>
    </div>`;
  $$('#rd-curva .rd-vb').forEach(b => {
    b.onclick = () => { RD_VISTA = b.dataset.v; dibujarCurva(); };
  });
}

/* El calendario, un mes a la vez. */
let RD_CAL = [], RD_EVENTO = '', RD_FALTAN = 0, RD_MES = null;
const RD_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
                  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function pintarCalendario() {
  const cont = $('#rd-cal');
  if (!cont) return;
  if (!RD_CAL.length) {
    cont.innerHTML = '<div class="muted" style="font-size:12px">Todavía no hay ventas.</div>';
    $('#rd-cal-sub').textContent = '';
    return;
  }
  const meses = [...new Set(RD_CAL.map(d => d.dia.slice(0, 7)))].sort();
  const hoy = new Date().toLocaleDateString('en-CA');
  if (RD_MES === null) {
    const mHoy = hoy.slice(0, 7);
    RD_MES = meses.indexOf(mHoy);
    if (RD_MES < 0) RD_MES = meses.length - 1;      // si hoy quedó fuera, el último
  }
  RD_MES = Math.max(0, Math.min(meses.length - 1, RD_MES));
  const mes = meses[RD_MES];
  const dias = RD_CAL.filter(d => d.dia.slice(0, 7) === mes);
  const tope = Math.max(1, ...RD_CAL.map(d => d.boletos));
  const vendidos = dias.reduce((a, d) => a + d.boletos, 0);
  const dinero = dias.reduce((a, d) => a + d.monto, 0);
  // el hueco antes del día 1, para que cada día caiga bajo su letra
  const primerDia = new Date(dias[0].dia + 'T12:00:00');
  const hueco = (primerDia.getDay() + 6) % 7;        // lunes = 0
  const [aa, mm] = mes.split('-');
  $('#rd-cal-sub').textContent = `${vendidos} boleto(s) este mes · faltan ${RD_FALTAN} días`;
  cont.innerHTML = `
    <div class="rd-nav">
      <button type="button" class="rd-flecha" id="rd-ant" ${RD_MES === 0 ? 'disabled' : ''}>‹</button>
      <div class="rd-mtit">${RD_MESES[Number(mm) - 1]} <span>${aa}</span></div>
      <button type="button" class="rd-flecha" id="rd-sig" ${RD_MES === meses.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    <div class="rd-sem-l">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(x => `<span>${x}</span>`).join('')}</div>
    <div class="rd-grid">
      ${Array.from({ length: hueco }, () => '<span class="rd-hueco"></span>').join('')}
      ${dias.map(d => {
        const n = d.boletos;
        const nivel = n === 0 ? 0 : n >= tope * 0.75 ? 4 : n >= tope * 0.5 ? 3
          : n >= tope * 0.25 ? 2 : 1;
        const clases = ['rd-dia', 'n' + nivel];
        if (d.futuro) clases.push('fut');
        if (d.dia === hoy) clases.push('hoy');
        if (d.dia === RD_EVENTO) clases.push('ev');
        return `<span class="${clases.join(' ')}"
          title="${esc(d.dia)}: ${n} boleto(s)${n ? ' · ' + fmtMoney(d.monto) : ''}">
          <b>${Number(d.dia.slice(8))}</b>${n ? `<i>${n}</i>` : ''}</span>`;
      }).join('')}
    </div>
    <div class="rd-leyenda">
      <span>menos</span><i class="n0"></i><i class="n1"></i><i class="n2"></i><i class="n3"></i><i class="n4"></i><span>más</span>
      <span class="rd-lev"><i class="ev"></i> el evento</span>
      <span class="rd-lev" style="margin-left:auto">${fmtMoney(Math.round(dinero))} en el mes</span>
    </div>`;
  const a = $('#rd-ant'), sg = $('#rd-sig');
  if (a) a.onclick = () => { RD_MES--; pintarCalendario(); };
  if (sg) sg.onclick = () => { RD_MES++; pintarCalendario(); };
}

function mejorDia(dias) {
  return dias.reduce((a, b) => (b.boletos > a.boletos ? b : a), dias[0]);
}

/* ---------------- ranking: quién vende y quién no ----------------

   Sirve para dos cosas opuestas y por eso salen todos en la misma lista: premiar al
   de arriba y ver al que no ha movido un boleto. Un vendedor con cero que no
   apareciera en ninguna parte es justo el que se pasa por alto.

   Dos órdenes porque no miden lo mismo: quien coloca más boletos no siempre es quien
   más dinero trae —diez UADY son menos que dos Ultra VIP—. */
let RK_POR = 'boletos';
async function loadRanking(silent) {
  const r = await API.get('/api/admin/ranking?por=' + RK_POR);
  const sig = JSON.stringify(r);
  if (silent && sig === _sigRanking) return;
  _sigRanking = sig;
  $$('.rk-por').forEach(b => {
    b.classList.toggle('sel', b.dataset.por === RK_POR);
    b.onclick = () => { RK_POR = b.dataset.por; _sigRanking = null; loadRanking(); };
  });
  // Cuatro celdas iguales en rejilla, no cuatro tarjetas que se acomodan solas: con
  // flex la cuarta se caía a un renglón propio y dejaba un hueco a la mitad — feo en
  // pantalla y peor en una captura de teléfono.
  $('#rk-stats').innerHTML = `
    <div class="rk-st"><i>Vendiendo</i><b>${r.con_ventas}<small>/${r.total_vendedores}</small></b></div>
    <div class="rk-st"><i>Sin vender</i><b>${r.sin_ventas}</b></div>
    <div class="rk-st"><i>Boletos</i><b>${r.total_boletos}</b></div>
    <div class="rk-st"><i>Vendido</i><b>${fmtMoney(r.total_monto)}</b></div>`;

  const lista = $('#rk-list');
  lista.innerHTML = '';
  let yaSinVentas = false;
  r.vendedores.forEach(v => {
    // una línea que separa a los que venden de los que no: es la decisión que se va
    // a tomar mirando esta pantalla, así que se ve sin tener que contar
    if (!v.puesto && !yaSinVentas) {
      yaSinVentas = true;
      if (r.sin_ventas) {
        const sep = document.createElement('div');
        sep.style.cssText = 'margin:14px 0 8px;font:700 11px Manrope;color:var(--cream-45);'
          + 'letter-spacing:.5px;display:flex;align-items:center;gap:9px';
        sep.innerHTML = `SIN NINGUNA VENTA · ${r.sin_ventas}
          <span style="flex:1;height:1px;background:rgba(255,120,40,.18)"></span>`;
        lista.appendChild(sep);
      }
    }
    const medalla = v.puesto === 1 ? '🥇' : v.puesto === 2 ? '🥈' : v.puesto === 3 ? '🥉' : null;
    const podio = v.puesto && v.puesto <= 3;
    const row = document.createElement('div');
    row.className = 'rk-row' + (podio ? ' podio' : '') + (v.puesto ? '' : ' cero');
    const dato = RK_POR === 'dinero'
      ? `<b>${fmtMoney(v.monto)}</b><span class="rk-sec">${v.boletos} boleto${v.boletos === 1 ? '' : 's'}</span>`
      : `<b>${v.boletos}</b><span class="rk-sec">${fmtMoney(v.monto)}</span>`;
    row.innerHTML = `
      <div class="rk-pos">${medalla || (v.puesto ? v.puesto + 'º' : '—')}</div>
      <div class="rk-n">${esc(v.name)}${v.es_lider ? ' <span class="rk-tag">colíder</span>' : ''}
        <span class="rk-sub">${v.ultima ? 'última venta ' + esc(fechaCorta(String(v.ultima).slice(0, 10)))
          : 'no ha vendido nada'}</span></div>
      <div class="rk-d">${dato}</div>`;
    // se abre su cuenta desde aquí mismo: si vas a premiarlo o a darlo de baja, lo
    // primero que quieres ver es qué vendió y qué debe, sin ir a buscarlo a la lista
    row.onclick = () => paySeller({ id: v.id, name: v.name, total: v.monto });
    lista.appendChild(row);
  });
  if (!r.vendedores.length) lista.innerHTML = '<div class="muted">Todavía no hay vendedores.</div>';
}
let _sigRanking = null;

async function loadCatalogs() {
  loadFlash();
  const [tt, fc] = await Promise.all([
    API.get('/api/admin/ticket-types'), API.get('/api/admin/faculties'),
  ]);
  // ----- tipos de boleto: solo precio base + editar -----
  $('#tt-list').innerHTML = '';
  tt.types.forEach(t => {
    const box = document.createElement('div');
    box.className = 'row';
    box.style.cssText = 'justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,120,40,.1)';
    const tk = { type_name: t.name, type_is_vip: t.is_vip };
    box.innerHTML = `<div style="font:700 14px Manrope">${esc(t.name)}${
      estrellaDe(tk) ? ` <span style="color:${tonoDe(tk).tinta}">★</span>` : ''}
        ${t.active ? '' : ' <span class="muted">(desactivado)</span>'}
        <div class="muted" style="font-size:10px;margin-top:2px">${t.needs_faculty ? 'pide facultad' : 'sin facultad'}${t.sold ? ' \u00b7 ' + t.sold + ' vendidos' : ''}</div></div>
      <div style="font:700 14px 'Space Grotesk'">${fmtMoney(t.current_price_cents / 100)}
        ${t.current_phase ? `<span class="muted" style="font-size:10px"> · ${esc(t.current_phase)}</span>` : ''}</div>`;
    const eb = document.createElement('button');
    eb.className = 'btn sm ghost'; eb.style.width = 'auto'; eb.textContent = 'Editar';
    eb.onclick = () => editType(t);
    box.appendChild(eb);
    $('#tt-list').appendChild(box);
  });
  // ----- fases de venta globales -----
  renderPhases(tt.types);
  $('#fc-list').innerHTML = '';
  fc.faculties.forEach(f => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(255,120,40,.1)';
    row.innerHTML = `<div style="font:600 13px Manrope">${esc(f.name)}${f.active ? '' : ' <span class="muted">(desactivada)</span>'}</div>`;
    const btns = document.createElement('div'); btns.className = 'row';
    const eb = document.createElement('button');
    eb.className = 'btn sm ghost'; eb.style.width = 'auto'; eb.textContent = 'Renombrar';
    eb.onclick = async () => {
      modal(`<div class="h1" style="font-size:18px">Renombrar facultad</div>
        <input class="input mt12" id="ef-name" value="${esc(f.name)}">
        <div class="row mt16"><button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
        <button class="btn grow" id="ef-save">Guardar</button></div>`);
      $('#ef-save').onclick = async () => {
        try { await API.put('/api/admin/faculties/' + f.id, { name: $('#ef-name').value.trim() }); closeModal(); loadCatalogs(); }
        catch (e) { if (!guard(e)) toast(e.message); }
      };
    };
    const tb = document.createElement('button');
    tb.className = 'btn sm ' + (f.active ? 'danger' : 'ghost'); tb.style.width = 'auto';
    tb.textContent = f.active ? 'Desactivar' : 'Activar';
    tb.onclick = async () => {
      try { await API.put('/api/admin/faculties/' + f.id, { active: !f.active }); loadCatalogs(); }
      catch (e) { if (!guard(e)) toast(e.message); }
    };
    btns.append(eb, tb);
    row.appendChild(btns);
    $('#fc-list').appendChild(row);
  });
}

function editType(t) {
  // La facultad y el VIP se pueden corregir después de crear el tipo. El VIP no
  // estaba: si al crearlo se olvidaba la palomita —pasa, es una casilla chiquita
  // junto al botón— el tipo se quedaba sin categoría alta para siempre, sin estrella
  // y con la insignia sosa de un boleto general, cobrando precio de VIP.
  modal(`<div class="h1" style="font-size:18px">Editar · ${esc(t.name)}</div>
    <div class="muted" style="margin-top:4px">${esc(t.name)}${t.is_vip ? ' — VIP ★' : ''} · siempre disponible</div>
    <div class="label mt16">Precio ($)</div>
    <input class="input" id="et-price" type="number" min="1" value="${t.price_cents / 100}">
    <label class="row mt16" style="gap:8px;cursor:pointer">
      <input type="checkbox" id="et-vip" ${t.is_vip ? 'checked' : ''}>
      <span style="font:600 13px Manrope;color:var(--cream)">Categoría alta (VIP ★)</span></label>
    <div class="muted" style="font-size:11px;margin-top:4px">Le pone su estrella y su color en el boleto, en la puerta y en el panel. El Ultra VIP también la lleva.</div>
    <label class="row mt12" style="gap:8px;cursor:pointer">
      <input type="checkbox" id="et-fac" ${t.needs_faculty ? 'checked' : ''}>
      <span style="font:600 13px Manrope;color:var(--cream)">Pedir facultad al comprador</span></label>
    <div class="muted" style="font-size:11px;margin-top:4px">Solo los boletos UADY la llevan. Si la quitas, deja de preguntarse y deja de salir impresa en el boleto.</div>
    <label class="row mt12" style="gap:8px;cursor:pointer">
      <input type="checkbox" id="et-act" ${t.active ? 'checked' : ''}>
      <span style="font:600 13px Manrope;color:var(--cream)">A la venta</span></label>
    <div class="muted" style="font-size:11px;margin-top:4px">Si lo apagas, los vendedores dejan de verlo en su boletera: no sabrán que existe hasta que lo habilites. Los boletos ya vendidos de ese tipo no se tocan.</div>
    <div class="muted mt12">Los cambios solo aplican a boletos nuevos; los ya generados quedan como están.</div>
    <div class="err mt8" id="et-err"></div>
    <div class="row mt16"><button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
    <button class="btn grow" id="et-save">Guardar</button></div>
    <button class="btn danger mt12" id="et-del">Eliminar este tipo de boleto</button>`);
  // Borrar el tipo NO toca los boletos ya vendidos: cada boleto lleva su nombre y su
  // precio copiados desde que se generó. Vale la pena decirlo, porque lo natural es
  // temer que se caiga el historial.
  $('#et-del').onclick = async () => {
    const n = t.sold || 0;
    const ok = await confirmModal({
      title: 'Eliminar ' + t.name,
      body: n
        ? `Hay <b>${n} boleto(s)</b> vendidos de este tipo. <b style="color:var(--ok)">No se
           borran</b>: cada uno guarda su nombre y su precio desde que se gener\u00f3, as\u00ed
           que el historial, las cuentas y el esc\u00e1ner de la puerta siguen igual.<br><br>
           Lo que desaparece es la opci\u00f3n de vender m\u00e1s de este tipo.`
        : 'Nadie ha vendido boletos de este tipo. Desaparece del cat\u00e1logo y de la boletera.',
      okLabel: 'Eliminar', danger: true,
    });
    if (!ok) return;
    try {
      await API.del('/api/admin/ticket-types/' + t.id);
      closeModal(); toast(t.name + ' eliminado'); loadCatalogs();
    } catch (e) { if (!guard(e)) toast(e.message); }
  };
  $('#et-save').onclick = async () => {
    const price = parseFloat($('#et-price').value);
    if (!(price > 0)) { $('#et-err').textContent = 'Escribe un precio válido'; return; }
    try {
      // el resto de propiedades quedan intactas en el backend
      await API.put('/api/admin/ticket-types/' + t.id,
                    { price, needs_faculty: $('#et-fac').checked,
                      is_vip: $('#et-vip').checked,
                      active: $('#et-act').checked });
      closeModal(); toast('Guardado'); loadCatalogs();
    } catch (e) { if (!guard(e)) $('#et-err').textContent = e.message; }
  };
}

$('#btn-tt-create').addEventListener('click', async () => {
  $('#tt-err').textContent = '';
  try {
    await API.post('/api/admin/ticket-types', {
      name: $('#tt-name').value.trim(),
      price: parseFloat($('#tt-price').value),
      is_vip: $('#tt-vip').checked,
      needs_faculty: $('#tt-needfac').checked,
    });
    $('#tt-name').value = ''; $('#tt-price').value = '';
    $('#tt-vip').checked = false; $('#tt-needfac').checked = false;
    loadCatalogs();
  } catch (e) { if (!guard(e)) $('#tt-err').textContent = e.message; }
});

$('#btn-fc-create').addEventListener('click', async () => {
  $('#fc-err').textContent = '';
  try {
    await API.post('/api/admin/faculties', { name: $('#fc-name').value.trim() });
    $('#fc-name').value = '';
    loadCatalogs();
  } catch (e) { if (!guard(e)) $('#fc-err').textContent = e.message; }
});

/* ---------------- admins ---------------- */
async function loadAdmins() {
  const r = await API.get('/api/admin/admins');
  $('#ad-list').innerHTML = '';
  r.admins.forEach(a => {
    const row = document.createElement('div');
    row.className = 'trow';
    const esCo = (a.role || 'admin') === 'colider';
    row.innerHTML = `<div class="tmain"><div class="tbuyer">${esc(a.username)}${a.id === r.me ? ' <span class="muted">(tú)</span>' : ''}${esCo ? ' <span class="badge used">colíder</span>' : ''}</div>
      <div class="tmeta">creado ${esc(a.created_at)}</div></div>`;
    if (a.id !== r.me) {
      const b = document.createElement('button');
      b.className = 'btn sm danger'; b.style.width = 'auto'; b.textContent = 'Eliminar';
      b.onclick = async () => {
        const ok = await confirmModal({
          title: 'Eliminar administrador', danger: true, okLabel: 'Eliminar',
          body: `Se eliminará la cuenta <b style="color:var(--cream)">${esc(a.username)}</b> y se cerrará su sesión.`,
        });
        if (!ok) return;
        try { await API.del('/api/admin/admins/' + a.id); toast('Administrador eliminado'); loadAdmins(); }
        catch (e) { if (!guard(e)) toast(e.message); }
      };
      row.appendChild(b);
    }
    $('#ad-list').appendChild(row);
  });
}

$('#btn-ad-create').addEventListener('click', async () => {
  $('#ad-err').textContent = '';
  try {
    await API.post('/api/admin/admins', {
      username: $('#ad-user').value.trim(), password: $('#ad-pass').value,
    });
    $('#ad-user').value = ''; $('#ad-pass').value = '';
    toast('Administrador creado');
    loadAdmins();
  } catch (e) { if (!guard(e)) $('#ad-err').textContent = e.message; }
});

$('#btn-co-create').addEventListener('click', async () => {
  $('#co-err').textContent = '';
  const usuario = $('#co-user').value.trim();
  if (!usuario) { $('#co-err').textContent = 'Ponle un usuario'; return; }
  // Se pregunta antes: crear un colíder le abre el panel a alguien de fuera, y eso no
  // debería pasar por darle sin querer a un botón que está junto al de "Crear" admin.
  const suCodigo = $('#co-code').value.trim();
  if (suCodigo && !/^\d{5}$/.test(suCodigo)) {
    $('#co-err').textContent = 'El código son 5 dígitos'; return;
  }
  const ok = await confirmModal({
    title: 'Crear colíder', okLabel: 'Crear colíder',
    body: `<b style="color:var(--cream)">${esc(usuario)}</b> va a poder entrar a este panel.<br><br>
      Verá <b style="color:var(--cream)">solo lo de su grupo</b> y podrá crear vendedores y
      cobrarles. No podrá anular boletos, dar de baja vendedores, tocar precios ni ajustes,
      escanear en la puerta, ni borrar el sistema.` +
      (suCodigo ? `<br><br>Conserva su código <b style="color:var(--cream)">${esc(suCodigo)}</b>
        y todo lo que ya vendió con él, que pasa a contar como su venta personal.`
                : `<br><br>Se le abrirá un código de vendedor nuevo.`),
  });
  if (!ok) return;
  try {
    const r = await API.post('/api/admin/admins', {
      username: usuario, password: $('#co-pass').value, role: 'colider',
      seller_code: suCodigo,
    });
    $('#co-user').value = ''; $('#co-pass').value = ''; $('#co-code').value = '';
    // su código de vendedor solo se ve aquí, en este momento: hay que copiarlo ya.
    // Va con un solo botón: no hay nada que cancelar, ya está creado.
    modal(`<div class="h1" style="font-size:18px">Colíder creado</div>
      <div class="muted mt8">Ya puede entrar al panel con su usuario y contraseña.</div>
      <div class="label mt16">Su código de vendedor</div>
      <div class="muted" style="font-size:11.5px">${r.reusado
        ? 'El que ya tenía. Sigue igual: no hay que avisarle nada.'
        : 'Para lo que venda él en persona. No se vuelve a mostrar: cópialo ahora.'}</div>
      <div style="text-align:center;margin:14px 0"><span class="codechip" style="font-size:26px;padding:10px 18px;letter-spacing:.3em">${r.code}</span></div>
      <button class="btn mt8" onclick="closeModal()">Listo</button>`);
    loadAdmins();
  } catch (e) { if (!guard(e)) $('#co-err').textContent = e.message; }
});

/* ---------------- ajustes: un flyer por tipo de boleto ---------------- */
const FLYER_META = {
  uady: { label: 'Flyer UADY',
          sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                    faculty_name: 'Ingeniería', type_name: 'UADY', type_is_vip: 0,
                    price: 150, phase_name: 'Fase 1' } },
  externo: { label: 'Flyer Externo',
             sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                       faculty_name: '', type_name: 'Externo', type_is_vip: 0,
                       price: 175, phase_name: 'Fase 1' } },
  vip: { label: '★ Flyer VIP',
         sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                   faculty_name: '', type_name: 'VIP', type_is_vip: 1,
                   price: 500, phase_name: 'Fase 1' } },
  // Los tres de grupo son UN flyer por categoría, no uno por persona: al que le
  // toque la botella se le dibuja encima su etiqueta de representante, sobre este
  // mismo fondo. Por eso las muestras NO llevan es_representante.
  grupo10: { label: 'Flyer Grupo de 10',
             sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                       faculty_name: '', type_name: 'Externo', type_is_vip: 0,
                       price: 161, normal_price: 175, group_size: 10, phase_name: 'Fase 1' } },
  grupo10vip: { label: 'Flyer Grupo de 10 · VIP',
                sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                          faculty_name: '', type_name: 'VIP', type_is_vip: 1,
                          price: 300, normal_price: 350, group_size: 10,
                          phase_name: 'Venta Flash' } },
  grupo10ultra: { label: 'Flyer Grupo de 10 · Ultra VIP',
                  sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                            faculty_name: '', type_name: 'Ultra vip', type_is_vip: 1,
                            price: 550, normal_price: 900, group_size: 10,
                            phase_name: 'Venta Flash' } },
  ultravip: { label: '★ Flyer Ultra VIP',
              sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                        faculty_name: '', type_name: 'Ultra VIP', type_is_vip: 1,
                        price: 900, phase_name: 'Fase 1' } },
  cortesiaexterno: { label: 'Flyer Cortesía Externo',
                     sample: { folio: 'INV-0001', qr_payload: 'demo', buyer_name: 'Invitado Especial',
                               faculty_name: '', type_name: 'Externo', type_is_vip: 0,
                               price: 0, es_cortesia: true } },
  cortesiavip: { label: '★ Flyer Cortesía VIP',
                 sample: { folio: 'INV-0001', qr_payload: 'demo', buyer_name: 'Invitado Especial',
                           faculty_name: '', type_name: 'VIP', type_is_vip: 1,
                           price: 0, es_cortesia: true } },
  cortesiaultra: { label: '★ Flyer Cortesía Ultra VIP',
                   sample: { folio: 'INV-0001', qr_payload: 'demo', buyer_name: 'Invitado Especial',
                             faculty_name: '', type_name: 'Ultra VIP', type_is_vip: 1,
                             price: 0, es_cortesia: true } },
};
const FLYER_VARIANTS = ['uady', 'externo', 'vip', 'grupo10', 'ultravip',
                        'grupo10vip', 'grupo10ultra',
                        'cortesiaexterno', 'cortesiavip', 'cortesiaultra'];
// estado por variante: imagen, si es nueva (sin subir), posición, zoom y refs de UI
const FLY_ED = {};
for (const v of FLYER_VARIANTS) FLY_ED[v] = { img: null, isNew: false, focus: 0.5, scale: 1, file: null, ui: null };

function loadImg(src) {
  return new Promise(res => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = src;
  });
}

function buildFlyerEditor(variant) {
  const st = FLY_ED[variant];
  const meta = FLYER_META[variant];
  const root = document.createElement('div');
  root.style.cssText = 'border:1px solid var(--line);border-radius:14px;padding:12px'
    + (meta.hidden ? ';border-style:dashed' : '');
  root.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center">
      <div class="label" style="margin:0">${meta.label}</div>
      ${meta.hidden ? '<span class="muted" style="font-size:10px;border:1px solid var(--line);border-radius:20px;padding:2px 8px">oculto · no se vende</span>' : ''}
    </div>
    <input type="file" accept="image/png,image/jpeg,image/webp" class="input" style="padding:10px;font-size:12px;margin-top:8px" data-f="file">
    <div data-f="wrap" style="display:none">
      <div class="mt8" style="display:flex;justify-content:center;background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:12px;padding:10px">
        <canvas data-f="cv" style="width:150px;max-width:100%;border-radius:10px;box-shadow:0 10px 24px rgba(0,0,0,.6);cursor:grab"></canvas>
      </div>
      <div class="mt8">
        <div class="row" style="justify-content:space-between"><div class="label" style="margin:0">Posición</div><span class="muted" data-f="fv">centro</span></div>
        <input type="range" min="0" max="1" step="0.02" value="0.5" style="width:100%;accent-color:var(--ember)" data-f="focus">
      </div>
      <div class="mt8">
        <div class="row" style="justify-content:space-between"><div class="label" style="margin:0">Zoom</div><span class="muted" data-f="sv">1.0×</span></div>
        <input type="range" min="1" max="3" step="0.05" value="1" style="width:100%;accent-color:var(--ember)" data-f="scale">
      </div>
      <div class="row mt8" style="gap:6px">
        <button class="btn sm grow" data-f="save">Guardar</button>
        <button class="btn ghost sm" style="width:auto" data-f="reset">↺</button>
      </div>
      <div class="okmsg mt8" data-f="ok" style="font-size:11px"></div>
    </div>
    <div class="muted mt8" data-f="none" style="font-size:11px"></div>`;
  const q = k => root.querySelector(`[data-f="${k}"]`);
  st.ui = { wrap: q('wrap'), cv: q('cv'), focus: q('focus'), scale: q('scale'),
            fv: q('fv'), sv: q('sv'), ok: q('ok'), none: q('none'), file: q('file') };

  const sync = () => {
    st.ui.focus.value = st.focus; st.ui.scale.value = st.scale;
    st.ui.fv.textContent = st.focus < 0.34 ? 'arriba' : st.focus > 0.66 ? 'abajo' : 'centro';
    st.ui.sv.textContent = Number(st.scale).toFixed(1) + '×';
  };
  st.sync = sync;

  st.ui.file.addEventListener('change', async () => {
    const f = st.ui.file.files[0];
    if (!f) return;
    st.file = f;
    st.img = await loadImg(URL.createObjectURL(f));
    st.isNew = true;
    st.ui.none.textContent = ''; st.ui.ok.textContent = '';
    st.ui.wrap.style.display = 'block';
    renderFlyerPreview(variant);
  });
  st.ui.focus.addEventListener('input', () => { st.focus = parseFloat(st.ui.focus.value); sync(); renderFlyerPreview(variant); });
  st.ui.scale.addEventListener('input', () => { st.scale = parseFloat(st.ui.scale.value); sync(); renderFlyerPreview(variant); });
  q('reset').addEventListener('click', () => { st.focus = 0.5; st.scale = 1; sync(); renderFlyerPreview(variant); });

  // arrastrar la imagen para moverla verticalmente
  let dragging = false, startY = 0, startFocus = 0.5;
  const down = e => { dragging = true; startY = (e.touches ? e.touches[0].clientY : e.clientY); startFocus = st.focus; };
  const move = e => {
    if (!dragging) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const range = st.ui.cv.clientHeight * 0.8 || 260;
    st.focus = clamp(startFocus - (y - startY) / range, 0, 1);
    sync(); renderFlyerPreview(variant);
    e.preventDefault();
  };
  const up = () => { dragging = false; };
  st.ui.cv.addEventListener('mousedown', down); window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  st.ui.cv.addEventListener('touchstart', down, { passive: false }); st.ui.cv.addEventListener('touchmove', move, { passive: false }); st.ui.cv.addEventListener('touchend', up);

  q('save').addEventListener('click', async () => {
    const btn = q('save');
    btn.disabled = true;
    try {
      if (st.isNew) {
        const fd = new FormData();
        fd.append('flyer', st.file);
        fd.append('variant', variant);
        fd.append('flyer_focus', st.focus);
        fd.append('flyer_scale', st.scale);
        await API.post('/api/admin/flyer', fd);
        st.isNew = false;
        st.ui.ok.textContent = 'Guardado ✓ — los boletos ' + FLYER_META[variant].label.replace(/^★?\s*Flyer\s*/, '') + ' usarán este flyer';
      } else {
        await API.post('/api/admin/settings', {
          ['flyer_focus_' + variant]: st.focus, ['flyer_scale_' + variant]: st.scale,
        });
        st.ui.ok.textContent = 'Posición guardada ✓';
      }
      setTimeout(() => st.ui.ok.textContent = '', 3000);
      _flyerCache[variant] = undefined;   // que el boleto real recargue este flyer
      EV = await API.get('/api/catalog');
    } catch (e) { if (!guard(e)) toast(e.message); }
    finally { btn.disabled = false; }
  });
  return root;
}

// construir un editor por variante, una sola vez
(() => {
  const cont = $('#flyer-editors');
  for (const v of FLYER_VARIANTS) cont.appendChild(buildFlyerEditor(v));
})();

let _fpBusy = {};
async function renderFlyerPreview(variant) {
  if (_fpBusy[variant]) return;
  _fpBusy[variant] = true;
  // El candado TIENE que soltarse pase lo que pase. Sin el finally, un solo error
  // al dibujar —una fuente que no cargó, una imagen a medias— dejaba la bandera en
  // true para siempre: a partir de ahí ese flyer ya no se volvía a pintar, y mover
  // el zoom o cambiar la imagen no hacía nada. Se veía como "el botón no sirve".
  try {
    const st = FLY_ED[variant];
    const ev = { ...EV, ['flyer_focus_' + variant]: st.focus, ['flyer_scale_' + variant]: st.scale };
    const cv = await renderTicket(FLYER_META[variant].sample, ev, st.img);
    st.ui.cv.width = cv.width; st.ui.cv.height = cv.height;
    st.ui.cv.getContext('2d').drawImage(cv, 0, 0);
  } catch (e) {
    // y si falla, que se vea: un recuadro en blanco no dice nada
    const st = FLY_ED[variant];
    if (st && st.ui && st.ui.none)
      st.ui.none.textContent = 'No se pudo dibujar la vista previa. Recarga la página.';
    console.error('flyer', variant, e);
  } finally {
    _fpBusy[variant] = false;
  }
}

/* Ajustes ya no tiene pestaña de Admins al lado: la lista de administradores vive
   plegada al final de esta misma pestaña, así que se carga junto con lo demás. */
async function loadAjustes() {
  await Promise.all([loadSettings(), loadAdmins().catch(() => {})]);
}

/* Cerrar la boletera: se toca una sola vez, la noche de la fiesta, y con prisa.
   Por eso el botón dice qué va a pasar (no "Activado/Desactivado") y pide una
   confirmación explícita: apagarla por error deja a 30 vendedores sin poder vender. */
function pintaVentas(cerradas) {
  const est = $('#vt-estado'), btn = $('#btn-vt-toggle'), card = $('#vt-card');
  if (!btn) return;
  card.style.borderColor = cerradas ? 'rgba(232,112,106,.45)' : '';
  est.innerHTML = cerradas
    ? '<b style="color:var(--danger)">CERRADA</b> \u00b7 los vendedores no pueden generar boletos'
    : '<b style="color:var(--ok)">ABIERTA</b> \u00b7 los vendedores est\u00e1n vendiendo';
  btn.textContent = cerradas ? 'Reabrir las ventas' : 'Cerrar las ventas';
  btn.className = cerradas ? 'btn' : 'btn danger';
  btn.onclick = async () => {
    const ok = await confirmModal({
      title: cerradas ? 'Reabrir las ventas' : 'Cerrar las ventas',
      body: cerradas
        ? 'Los vendedores vuelven a poder generar boletos.'
        : `Los <b>30 vendedores</b> dejan de poder generar boletos al instante, para que
           puedas cortar cuentas sabiendo que el total ya no se mueve.<br><br>
           <b style="color:var(--ok)">El esc\u00e1ner de la puerta sigue funcionando</b>, y
           puedes reabrir cuando quieras.`,
      okLabel: cerradas ? 'Reabrir' : 'Cerrar ahora', danger: !cerradas,
    });
    if (!ok) return;
    try {
      const r = await API.post('/api/admin/ventas', { cerrar: !cerradas });
      pintaVentas(r.ventas_cerradas);
      toast(r.ventas_cerradas ? 'Ventas CERRADAS' : 'Ventas reabiertas');
    } catch (e) { if (!guard(e)) toast(e.message); }
  };
}

/* Clave del escáner de la puerta. Apagada, solo los admins pueden escanear; el día
   del evento se genera y se reparte al staff. Rotarla saca a quien tenga la vieja. */
function pintaPuerta(clave) {
  const hay = !!clave;
  $('#dc-estado').innerHTML = hay
    ? '<b style="color:var(--ok)">ENCENDIDA</b> \u00b7 el staff entra a /scan con esta clave'
    : '<b style="color:var(--cream-60)">APAGADA</b> \u00b7 solo t\u00fa puedes escanear (abre Esc\u00e1ner arriba)';
  $('#dc-clave').style.display = hay ? '' : 'none';
  if (hay) $('#dc-num').textContent = clave;
  $('#btn-dc-gen').textContent = hay ? 'Generar una clave nueva' : 'Generar clave para el staff';
  $('#btn-dc-off').style.display = hay ? '' : 'none';
  $('#btn-dc-gen').onclick = async () => {
    if (hay) {
      const ok = await confirmModal({
        title: 'Generar una clave nueva',
        body: 'La clave anterior deja de servir y el staff que la tenga queda fuera hasta que le pases la nueva.',
        okLabel: 'Generar', danger: true,
      });
      if (!ok) return;
    }
    try {
      const r = await API.post('/api/admin/door-code', { accion: 'generar' });
      pintaPuerta(r.door_code); toast('Clave lista: ' + r.door_code);
    } catch (e) { if (!guard(e)) toast(e.message); }
  };
  $('#btn-dc-off').onclick = async () => {
    const ok = await confirmModal({
      title: 'Apagar el esc\u00e1ner del staff',
      body: 'Las sesiones de puerta se cierran al instante. T\u00fa sigues pudiendo escanear con tu cuenta.',
      okLabel: 'Apagar', danger: true,
    });
    if (!ok) return;
    try {
      const r = await API.post('/api/admin/door-code', { accion: 'apagar' });
      pintaPuerta(''); toast('Esc\u00e1ner del staff apagado');
    } catch (e) { if (!guard(e)) toast(e.message); }
  };
}

/* Borrar todo desde el panel. La palabra escrita a mano es el candado: un "¿estás
   seguro?" se contesta que sí sin leer, escribir BORRAR TODO no. */
$('#btn-rs-go').addEventListener('click', async () => {
  const w = $('#rs-word').value.trim().toUpperCase();
  $('#rs-err').textContent = '';
  if (w !== 'BORRAR TODO') { $('#rs-err').textContent = 'Escribe exactamente: BORRAR TODO'; return; }
  const ok = await confirmModal({
    title: 'Borrar TODO el sistema',
    body: `Se van los boletos, los vendedores, los grupos, los gastos, las fases y los
           movimientos. <b style="color:var(--ok)">Se quedan</b> tus flyers, los precios, las
           facultades y tu código de invitados.<br><br>
           <b style="color:var(--danger)">Esto no se puede deshacer.</b>`,
    okLabel: 'Sí, borrar todo', danger: true,
  });
  if (!ok) return;
  try {
    const r = await API.post('/api/admin/reset', { confirmar: 'BORRAR TODO' });
    $('#rs-word').value = '';
    modal(`<div class="h1" style="font-size:18px">Sistema borrado</div>
      <div class="muted mt12" style="font-size:13px;line-height:1.6">
        Se borraron <b style="color:var(--cream)">${r.boletos}</b> boleto(s) y
        <b style="color:var(--cream)">${r.vendedores}</b> vendedor(es).<br><br>
        Se cerraron todas las sesiones —también la tuya—, así que vas a entrar otra vez.
        Después revisa los <b>precios</b> en Catálogos y vuelve a cargar las <b>fases</b>:
        el borrado no las repone.</div>
      <button class="btn mt16" onclick="closeModal();location.reload()">Entendido</button>`);
  } catch (e) { if (!guard(e)) $('#rs-err').textContent = e.message; }
});

async function loadSettings() {
  const s = await API.get('/api/admin/settings');
  pintaVentas(s.ventas_cerradas);
  pintaPuerta(s.door_code);
  $('#st-name').value = s.event_name;
  $('#st-subtitle').value = s.event_subtitle;
  $('#st-folio').value = s.folio_start || '1';
  $('#st-com').value = s.seller_commission_pct != null ? s.seller_commission_pct : 10;
  for (const v of FLYER_VARIANTS) {
    const st = FLY_ED[v];
    st.focus = parseFloat(s['flyer_focus_' + v]) || 0.5;
    st.scale = parseFloat(s['flyer_scale_' + v]) || 1;
    st.isNew = false;
    st.sync();
    // Antes, sin imagen propia el bloque entero se escondía: se apretaba la variante
    // y no aparecía nada, ni el boleto. Ahora siempre se dibuja —con su imagen si la
    // hay, y si no con el diseño pelón— para poder ver cómo va a salir.
    st.img = s['flyer_' + v] ? await loadImg('/flyer?v=' + v + '&ts=' + Date.now()) : null;
    st.ui.none.textContent = st.img ? '' : 'Sin imagen propia todavía: así se ve el boleto sin flyer.';
    st.ui.wrap.style.display = 'block';
    renderFlyerPreview(v);
  }
}

$('#btn-st-save').addEventListener('click', async () => {
  try {
    await API.post('/api/admin/settings', {
      event_name: $('#st-name').value, event_subtitle: $('#st-subtitle').value,
      folio_start: parseInt($('#st-folio').value, 10) || 1,
      seller_commission_pct: $('#st-com').value,
    });
    $('#st-ok').textContent = 'Ajustes guardados ✓';
    setTimeout(() => $('#st-ok').textContent = '', 2500);
    EV = await API.get('/api/catalog');
  } catch (e) { if (!guard(e)) toast(e.message); }
});

/* ---------------- arranque ---------------- */
$('#btn-login').addEventListener('click', login);
$('#lg-pass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('#btn-logout').addEventListener('click', async () => {
  try { await API.post('/api/logout'); } catch (_) {}
  API.setToken(null); show('login');
});

(async function boot() {
  API.get('/api/event').then(ev => {
    $('#lg-name').textContent = ev.event_name;
    $('#lg-sub').textContent = (ev.event_subtitle || '').toUpperCase();
  }).catch(() => {});
  try {
    if (API.token) {
      const me = await API.get('/api/me');
      if (me.role === 'admin') return enter(me.name);
      API.setToken(null);
    }
  } catch (_) { API.setToken(null); }
  show('login');
})();
