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
const loaders = {
  resumen: loadSummary, boletos: loadTicketsTab, movimientos: loadMovements,
  generar: loadGenerar, ranking: loadRanking, vendedores: loadSellers,
  catalogos: loadCatalogs, admins: loadAdmins, ajustes: loadSettings,
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
const LIVE = { resumen: loadSummary, boletos: loadTicketsTable, ranking: loadRanking,
               movimientos: loadMovements, vendedores: loadSellers };
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
    return `<div class="row" style="justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,120,40,.1)">
      <div style="font:700 13px Manrope;min-width:120px">${esc(a.admin)}</div>
      <div class="muted" style="font-size:12px">cobró <b style="color:var(--cream)">${fmtMoney(a.collected)}</b> de <b>${fmtMoney(a.sold)}</b></div>
      <div>${estado}</div></div>`;
  }).join('') || '<div class="muted">Sin datos aún</div>';
}

/* ---------------- boletos ---------------- */
async function refreshFilterSources() {
  const [sl, tt, fc] = await Promise.all([
    API.get('/api/admin/sellers'), API.get('/api/admin/ticket-types'), API.get('/api/admin/faculties'),
  ]);
  CACHE = { sellers: sl.sellers, types: tt.types, faculties: fc.faculties };
  $('#fl-seller').innerHTML = '<option value="">Vendedor: todos</option>' +
    sl.sellers.map(s => `<option value="${s.id}">${esc(s.name)}${s.deleted ? ' (eliminado)' : ''}</option>`).join('');
  $('#fl-type').innerHTML = '<option value="">Tipo: todos</option>' +
    tt.types.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
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
  if (!CACHE.sellers.length) await refreshFilterSources();
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
      <td style="font-family:'Space Grotesk';color:var(--ember-soft)">${esc(t.folio)}</td>
      <td class="strike">${esc(t.buyer_name)}</td>
      <td>${esc(t.faculty_name)}</td>
      <td>${esc(t.type_name)}</td>
      <td class="strike" style="font-family:'Space Grotesk'">${fmtMoney(t.price)}</td>
      <td>${esc(t.seller_name)} <span class="muted">(${esc(t.seller_code)})</span>${t.owner_admin_name ? `<div class="muted" style="font-size:9px;margin-top:2px">Admin: ${esc(t.owner_admin_name)}</div>` : ''}</td>
      <td class="muted">${esc(t.created_at)}</td>
      <td>${estado}</td>`;
    const td = document.createElement('td');
    td.style.whiteSpace = 'nowrap';
    // solo el admin dueño del vendedor puede anular sus boletos
    const mine = t.owner_admin_id == null || t.owner_admin_id === ME_ID;
    if (t.status !== 'void') {
      const dl = document.createElement('button');
      dl.className = 'iconbtn'; dl.title = 'Descargar boleto'; dl.textContent = '⬇';
      dl.onclick = async () => { dl.disabled = true; try { await downloadTicket(t, EV); } finally { dl.disabled = false; } };
      td.appendChild(dl);
      // la tachita SIEMPRE se muestra; deshabilitada si no eres el admin del vendedor
      const vd = document.createElement('button');
      vd.className = 'iconbtn'; vd.textContent = '✕'; vd.style.marginLeft = '6px';
      if (mine) {
        vd.title = 'Anular boleto';
        vd.style.color = 'var(--danger)'; vd.style.borderColor = 'rgba(232,112,106,.5)'; vd.style.background = 'rgba(232,112,106,.08)';
        vd.onclick = () => voidTicket(t);
      } else {
        vd.disabled = true;
        vd.title = `Solo ${t.owner_admin_name || 'su admin'} puede anular este boleto`;
        vd.style.opacity = '.3'; vd.style.cursor = 'not-allowed';
      }
      td.appendChild(vd);
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
           para el ranking.`,
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

/* ---------------- generar (admin) ---------------- */
async function loadGenerar() {
  EV = await API.get('/api/catalog');
  $('#g-faculty').innerHTML = '<option value="" disabled selected>Elige facultad…</option>' +
    EV.faculties.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  renderGTypes();
}

function renderGTypes() {
  const box = $('#g-types');
  box.innerHTML = '';
  EV.types.forEach(t => {
    const el = document.createElement('div');
    el.className = 'typeopt' + (SELECTED_TYPE === t.id ? ' sel' : '');
    el.innerHTML = `<div class="tname">${esc(t.name)}</div><div class="tprice">${fmtMoney(t.price_cents / 100)}</div>`;
    el.onclick = () => { SELECTED_TYPE = t.id; renderGTypes(); };
    box.appendChild(el);
  });
}

$('#btn-g-generate').addEventListener('click', async () => {
  const buyer = $('#g-buyer').value.trim();
  $('#g-err').textContent = '';
  if (buyer.length < 3) { $('#g-err').textContent = 'Escribe el nombre del comprador'; return; }
  if (!$('#g-faculty').value) { $('#g-err').textContent = 'Elige la facultad'; return; }
  if (!SELECTED_TYPE) { $('#g-err').textContent = 'Elige el tipo de boleto'; return; }
  try {
    const r = await API.post('/api/tickets', {
      buyer_name: buyer, faculty_id: Number($('#g-faculty').value), type_id: SELECTED_TYPE,
    });
    $('#g-buyer').value = ''; $('#g-faculty').selectedIndex = 0; SELECTED_TYPE = null; renderGTypes();
    toast('Boleto ' + r.ticket.folio + ' generado, descargando…');
    await downloadTicket(r.ticket, EV);
  } catch (e) { if (!guard(e)) $('#g-err').textContent = e.message; }
});

/* ---------------- ranking ---------------- */
let _sigRanking = '';
async function loadRanking(silent) {
  const r = await API.get('/api/admin/ranking');
  const sig = r.ranking.map(s => s.position + s.name).join(',');
  if (silent && sig === _sigRanking) return;
  _sigRanking = sig;
  $('#rk-body').innerHTML = r.ranking.map((s, i) => `
    <tr class="rank${i + 1}">
      <td><span class="pos">${s.position}</span></td>
      <td style="font-weight:700">${esc(s.name)}${s.deleted ? ' <span class="muted">(eliminado)</span>' : ''}</td>
    </tr>`).join('');
}

/* ---------------- movimientos (feed para todos los admins) ---------------- */
const MV_ICON = { generacion: '🎟', anulacion: '✕', vendedor_creado: '👤', vendedor_eliminado: '✂',
                  usuarios: '👤', precio: '$', catalogo: '📋', ajustes: '⚙', exportacion: '⬇',
                  inicializacion: '⚡', pago: '💰' };
const MV_COLOR = { anulacion: 'rgba(232,112,106,.5)', vendedor_eliminado: 'rgba(232,112,106,.5)',
                   generacion: 'rgba(126,226,168,.4)', vendedor_creado: 'rgba(126,226,168,.4)' };
let _sigMoves = '';
async function loadMovements(silent) {
  const r = await API.get('/api/admin/audit');
  const sig = r.log.length ? r.log[0].id + '-' + r.log.length : '0';
  if (silent && sig === _sigMoves) return;
  _sigMoves = sig;
  $('#mv-list').innerHTML = r.log.map(l => `
    <div class="trow" style="${MV_COLOR[l.action] ? 'border-color:' + MV_COLOR[l.action] : ''}">
      <div class="avatar" style="font-size:13px">${MV_ICON[l.action] || '·'}</div>
      <div class="tmain">
        <div style="font:600 12.5px Manrope;color:var(--cream);white-space:normal">${esc(l.detail)}</div>
        <div class="tmeta">${esc(l.actor)} · ${esc(l.created_at)}</div>
      </div>
    </div>`).join('') || '<div class="muted">Sin movimientos aún</div>';
}

/* ---------------- vendedores ---------------- */
let _sigSellers = '';
async function loadSellers(silent) {
  const r = await API.get('/api/admin/sellers');
  populateAdminFilters(r.sellers);
  const fa = ($('#sl-filter-admin') && $('#sl-filter-admin').value) || '';
  const sig = JSON.stringify([fa, ...r.sellers.map(s => [s.id, s.name, s.code, s.active, s.deleted, s.tickets, s.total, s.paid])]);
  if (silent && sig === _sigSellers) return;
  _sigSellers = sig;
  CACHE.sellers = r.sellers;
  const body = $('#sl-body');
  body.innerHTML = '';
  // filtro por admin (cliente): "" todos, "__none__" sin asignar, o el nombre
  const shown = r.sellers.filter(s => !fa
    || (fa === '__none__' ? !s.owner_admin_name : s.owner_admin_name === fa));
  if (!shown.length) { body.innerHTML = '<tr><td colspan="7" class="muted" style="padding:16px">Sin vendedores para ese admin</td></tr>'; return; }
  shown.forEach(s => {
    const tr = document.createElement('tr');
    if (s.deleted) tr.style.opacity = '.45';
    // en cada fila: quién es el admin de este vendedor (texto simple, claro)
    const adminLine = `<div class="muted" style="font-size:10px;margin-top:3px">Admin: <b style="color:var(--ember-soft)">${esc(s.owner_admin_name || 'sin asignar')}</b></div>`;
    // faltante = vendido - pagado. Cuando es 0 (y vendió), COMPLETADO.
    const falta = s.total - s.paid;
    const faltante = s.total <= 0
      ? '<span class="muted">—</span>'
      : (falta <= 0
          ? '<span class="badge active">COMPLETADO</span>'
          : `<b style="font-family:'Space Grotesk';color:var(--danger)">${fmtMoney(falta)}</b>`);
    tr.innerHTML = `
      <td style="font-weight:700">${esc(s.name)}${adminLine}</td>
      <td>${s.deleted ? '<span class="muted">—</span>' : `<span class="codechip">${esc(s.code)}</span>`}</td>
      <td><b style="font-family:'Space Grotesk'">${fmtMoney(s.total)}</b><div class="muted" style="font-size:9px;margin-top:2px">${s.tickets} boleto(s)</div></td>
      <td style="font-family:'Space Grotesk';font-weight:700">${fmtMoney(s.paid)}</td>
      <td>${faltante}</td>
      <td>${s.deleted ? '<span class="badge void">Eliminado</span>'
          : s.active ? '<span class="badge active">Activo</span>'
          : '<span class="badge used">Desactivado</span>'}</td>`;
    const td = document.createElement('td');
    const mine = s.owner_admin_id == null || s.owner_admin_id === ME_ID;
    if (!s.deleted && mine) {
      const mk = (label, fn, cls) => {
        const b = document.createElement('button');
        b.className = 'btn sm ' + (cls || 'ghost');
        b.style.width = 'auto'; b.style.marginRight = '6px'; b.style.marginBottom = '4px';
        b.textContent = label; b.onclick = fn;
        td.appendChild(b);
      };
      mk('$ Pago', () => paySeller(s));
      mk('Editar', () => editSeller(s));
      mk(s.active ? 'Desactivar' : 'Reactivar', () => toggleSeller(s));
      mk('Eliminar', () => deleteSeller(s), 'danger');
    } else if (!s.deleted) {
      td.innerHTML = `<span class="muted" style="font-size:10px">solo ${esc(s.owner_admin_name || 'su admin')} puede modificarlo</span>`;
    }
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

/* registrar cuánto dinero ha entregado el vendedor a su admin */
function paySeller(s) {
  // sin ventas → no hay pago que registrar
  if (s.total <= 0) {
    modal(`<div class="h1" style="font-size:18px">Registrar pago de ${esc(s.name)}</div>
      <div class="muted mt12" style="line-height:1.5">Este vendedor <b style="color:var(--cream)">aún no ha vendido nada</b> ($0), así que no hay pago que registrar. El pago solo se habilita cuando tenga boletos vendidos.</div>
      <button class="btn mt16" onclick="closeModal()">Entendido</button>`);
    return;
  }
  modal(`<div class="h1" style="font-size:18px">Registrar pago de ${esc(s.name)}</div>
    <div class="muted mt8">Vendido: <b style="color:var(--cream)">${fmtMoney(s.total)}</b> ·
      Pagado hasta ahora: <b style="color:var(--cream)">${fmtMoney(s.paid)}</b></div>
    <div class="label mt12">Total recibido de este vendedor ($)</div>
    <input class="input" id="pg-amount" type="number" min="0" max="${s.total}" step="0.01" value="${s.paid}">
    <div class="muted mt8">Escribe el TOTAL acumulado que te ha entregado. Máximo ${fmtMoney(s.total)} (lo vendido). Cuando lo iguale, quedará COMPLETADO.</div>
    <div class="err mt8" id="pg-err"></div>
    <div class="row mt16">
      <button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
      <button class="btn grow" id="pg-save">Guardar</button>
    </div>`);
  $('#pg-save').onclick = async () => {
    const val = parseFloat($('#pg-amount').value || '0');
    if (isNaN(val) || val < 0) { $('#pg-err').textContent = 'Monto inválido'; return; }
    if (val > s.total) { $('#pg-err').textContent = `No puede superar lo vendido (${fmtMoney(s.total)})`; return; }
    try {
      const r = await API.post(`/api/admin/sellers/${s.id}/paid`, { paid: val });
      closeModal();
      toast(r.settled ? `${s.name}: cuentas COMPLETADAS ✓` : `Pago registrado (faltan ${fmtMoney(r.total - r.paid)})`);
      loadSellers();
    } catch (e) { if (!guard(e)) $('#pg-err').textContent = e.message; }
  };
}

$('#sl-filter-admin').addEventListener('change', () => { _sigSellers = ''; loadSellers(); });

$('#btn-sl-create').addEventListener('click', async () => {
  const btn = $('#btn-sl-create');
  if (btn.disabled) return;   // evita doble-clic → vendedor duplicado
  $('#sl-err').textContent = '';
  const name = $('#sl-name').value.trim();
  if (!name) { $('#sl-err').textContent = 'Escribe el nombre'; return; }
  btn.disabled = true;
  try {
    const r = await API.post('/api/admin/sellers', { name });   // código siempre automático
    $('#sl-name').value = '';
    modal(`<div class="h1" style="font-size:18px">Vendedor creado</div>
      <div class="muted mt8">Comparte su código de acceso. Es su identidad en el sistema:</div>
      <div style="text-align:center;margin:18px 0"><span class="codechip" style="font-size:30px;padding:12px 22px">${esc(r.code)}</span></div>
      <button class="btn" onclick="closeModal()">Listo</button>`);
    loadSellers();
  } catch (e) { if (!guard(e)) $('#sl-err').textContent = e.message; }
  finally { btn.disabled = false; }
});

function editSeller(s) {
  modal(`<div class="h1" style="font-size:18px">Editar vendedor</div>
    <div class="label mt12">Nombre</div><input class="input" id="es-name" value="${esc(s.name)}">
    <div class="label mt12">Código de 4 dígitos</div>
    <input class="input" id="es-code" value="${esc(s.code)}" maxlength="4" inputmode="numeric">
    <div class="muted mt8">Si cambias el código, su sesión actual se cierra.</div>
    <div class="err mt8" id="es-err"></div>
    <div class="row mt16">
      <button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
      <button class="btn grow" id="es-save">Guardar</button>
    </div>`);
  $('#es-save').onclick = async () => {
    try {
      await API.put('/api/admin/sellers/' + s.id, {
        name: $('#es-name').value.trim(), code: $('#es-code').value.trim(),
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
async function loadCatalogs() {
  const [tt, fc] = await Promise.all([
    API.get('/api/admin/ticket-types'), API.get('/api/admin/faculties'),
  ]);
  $('#tt-list').innerHTML = '';
  tt.types.forEach(t => {
    const box = document.createElement('div');
    box.style.cssText = 'padding:12px 0;border-bottom:1px solid rgba(255,120,40,.1)';
    // cabecera del tipo: nombre + precio vigente
    const head = document.createElement('div');
    head.className = 'row';
    head.style.justifyContent = 'space-between';
    head.innerHTML = `<div style="font:700 14px Manrope">${esc(t.name)}${t.is_vip ? ' <span style="color:#f3d27a">★</span>' : ''}
        ${t.active ? '' : ' <span class="muted">(desactivado)</span>'}</div>
      <div style="font:700 14px 'Space Grotesk'">${fmtMoney(t.current_price_cents / 100)}
        ${t.current_phase ? `<span class="muted" style="font-size:10px">· ${esc(t.current_phase)}</span>` : ''}</div>`;
    const eb = document.createElement('button');
    eb.className = 'btn sm ghost'; eb.style.width = 'auto'; eb.textContent = 'Editar';
    eb.onclick = () => editType(t);
    head.appendChild(eb);
    box.appendChild(head);
    // fases del tipo
    const list = document.createElement('div');
    list.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:5px';
    t.phases.forEach(p => {
      const isCurrent = t.current_phase === p.name && t.current_price_cents === p.price_cents;
      const row = document.createElement('div');
      row.className = 'row';
      row.style.cssText = 'justify-content:space-between;padding:6px 10px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid ' + (isCurrent ? 'var(--ember)' : 'rgba(255,120,40,.15)');
      row.innerHTML = `<div style="font:600 12px Manrope">${esc(p.name)}${isCurrent ? ' <span style="color:var(--ember-soft);font-size:9px">● VIGENTE</span>' : ''}</div>
        <div class="muted" style="font-size:11px">desde ${esc(p.starts_on)}</div>
        <div style="font:700 12px 'Space Grotesk'">${fmtMoney(p.price_cents / 100)}</div>`;
      const del = document.createElement('button');
      del.className = 'iconbtn'; del.style.cssText = 'width:26px;height:26px;font-size:11px';
      del.title = 'Eliminar fase'; del.textContent = '✕';
      del.onclick = async () => {
        try { await API.del('/api/admin/phases/' + p.id); loadCatalogs(); }
        catch (e) { if (!guard(e)) toast(e.message); }
      };
      row.appendChild(del);
      list.appendChild(row);
    });
    // agregar fase
    const add = document.createElement('div');
    add.className = 'row';
    add.style.cssText = 'gap:6px;margin-top:6px;flex-wrap:wrap';
    add.innerHTML = `
      <input class="input" placeholder="Fase (ej. Preventa)" data-ph="name" style="flex:1;min-width:110px;padding:9px;font-size:12px">
      <input class="input" type="number" min="1" placeholder="$" data-ph="price" style="width:70px;padding:9px;font-size:12px">
      <input class="input" type="date" data-ph="date" style="width:140px;padding:9px;font-size:12px">`;
    const ab = document.createElement('button');
    ab.className = 'btn sm'; ab.style.width = 'auto'; ab.textContent = '+ Fase';
    ab.onclick = async () => {
      const g = k => add.querySelector(`[data-ph="${k}"]`).value.trim();
      try {
        await API.post(`/api/admin/ticket-types/${t.id}/phases`,
          { name: g('name'), price: parseFloat(g('price')), starts_on: g('date') });
        loadCatalogs();
      } catch (e) { if (!guard(e)) toast(e.message); }
    };
    add.appendChild(ab);
    box.appendChild(list);
    box.appendChild(add);
    $('#tt-list').appendChild(box);
  });
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
  modal(`<div class="h1" style="font-size:18px">Editar tipo de boleto</div>
    <div class="label mt12">Nombre</div><input class="input" id="et-name" value="${esc(t.name)}">
    <div class="label mt12">Precio base ($) — aplica cuando ninguna fase está vigente</div>
    <input class="input" id="et-price" type="number" min="1" value="${t.price_cents / 100}">
    <label class="muted row mt12" style="gap:6px"><input type="checkbox" id="et-vip" ${t.is_vip ? 'checked' : ''}>Lleva distintivo ★ VIP en el boleto</label>
    <label class="muted row mt8" style="gap:6px"><input type="checkbox" id="et-active" ${t.active ? 'checked' : ''}>Disponible para la venta</label>
    <div class="muted mt12">El cambio de precio solo aplica a boletos nuevos; los ya generados conservan su precio.</div>
    <div class="err mt8" id="et-err"></div>
    <div class="row mt16"><button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
    <button class="btn grow" id="et-save">Guardar</button></div>`);
  $('#et-save').onclick = async () => {
    try {
      await API.put('/api/admin/ticket-types/' + t.id, {
        name: $('#et-name').value.trim(),
        price: parseFloat($('#et-price').value),
        is_vip: $('#et-vip').checked,
        active: $('#et-active').checked,
      });
      closeModal(); toast('Tipo actualizado'); loadCatalogs();
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
    });
    $('#tt-name').value = ''; $('#tt-price').value = ''; $('#tt-vip').checked = false;
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
    row.innerHTML = `<div class="tmain"><div class="tbuyer">${esc(a.username)}${a.id === r.me ? ' <span class="muted">(tú)</span>' : ''}</div>
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

/* ---------------- ajustes: dos flyers (VIP y General) ---------------- */
const FLYER_META = {
  vip: { label: '★ Flyer VIP',
         sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                   faculty_name: 'Externo', type_name: 'VIP', type_is_vip: 1, price: 500 } },
  gen: { label: 'Flyer General',
         sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                   faculty_name: 'Externo', type_name: 'General', type_is_vip: 0, price: 200 } },
};
// estado por variante: imagen, si es nueva (sin subir), posición, zoom y refs de UI
const FLY_ED = {
  vip: { img: null, isNew: false, focus: 0.5, scale: 1, file: null, ui: null },
  gen: { img: null, isNew: false, focus: 0.5, scale: 1, file: null, ui: null },
};

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
  const root = document.createElement('div');
  root.style.cssText = 'border:1px solid var(--line);border-radius:14px;padding:12px';
  root.innerHTML = `
    <div class="label">${FLYER_META[variant].label}</div>
    <input type="file" accept="image/png,image/jpeg,image/webp" class="input" style="padding:10px;font-size:12px" data-f="file">
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
        st.ui.ok.textContent = 'Guardado ✓ — los boletos ' + (variant === 'vip' ? 'VIP' : 'General') + ' usarán este flyer';
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

// construir los dos editores una sola vez
(() => {
  const cont = $('#flyer-editors');
  cont.appendChild(buildFlyerEditor('vip'));
  cont.appendChild(buildFlyerEditor('gen'));
})();

let _fpBusy = {};
async function renderFlyerPreview(variant) {
  if (_fpBusy[variant]) return;
  _fpBusy[variant] = true;
  const st = FLY_ED[variant];
  const ev = { ...EV, ['flyer_focus_' + variant]: st.focus, ['flyer_scale_' + variant]: st.scale };
  const cv = await renderTicket(FLYER_META[variant].sample, ev, st.img);
  st.ui.cv.width = cv.width; st.ui.cv.height = cv.height;
  st.ui.cv.getContext('2d').drawImage(cv, 0, 0);
  _fpBusy[variant] = false;
}

async function loadSettings() {
  const s = await API.get('/api/admin/settings');
  $('#st-name').value = s.event_name;
  $('#st-subtitle').value = s.event_subtitle;
  $('#st-date').value = s.event_date_text;
  for (const v of ['vip', 'gen']) {
    const st = FLY_ED[v];
    st.focus = parseFloat(s['flyer_focus_' + v]) || 0.5;
    st.scale = parseFloat(s['flyer_scale_' + v]) || 1;
    st.isNew = false;
    st.sync();
    if (s['flyer_' + v]) {
      st.img = await loadImg('/flyer?v=' + v + '&ts=' + Date.now());
      st.ui.none.textContent = '';
      st.ui.wrap.style.display = 'block';
      renderFlyerPreview(v);
    } else {
      st.img = null;
      st.ui.none.textContent = 'Sin imagen aún. Elige un archivo para ver la vista previa.';
      st.ui.wrap.style.display = 'none';
    }
  }
}

$('#btn-st-save').addEventListener('click', async () => {
  try {
    await API.post('/api/admin/settings', {
      event_name: $('#st-name').value, event_subtitle: $('#st-subtitle').value,
      event_date_text: $('#st-date').value,
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
