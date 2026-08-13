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
  vendedores: loadSellers, grupos: loadGroups, gastos: loadExpenses,
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
    return `<div style="padding:9px 0;border-bottom:1px solid rgba(255,120,40,.1)">
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px">
        <div style="font:700 13px Manrope">${esc(a.admin)}</div>
        <div>${estado}</div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:3px">cobró <b style="color:var(--cream)">${fmtMoney(a.collected)}</b> de <b>${fmtMoney(a.sold)}</b></div>
    </div>`;
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
      <td data-label="Folio" style="font-family:'Space Grotesk';color:var(--ember-soft)">${esc(t.folio)}</td>
      <td data-label="Comprador" class="strike cell-name"><span class="clip" title="${esc(t.buyer_name)}">${esc(t.buyer_name)}</span></td>
      <td data-label="Facultad">${esc(t.faculty_name)}</td>
      <td data-label="Tipo">${esc(t.type_name)}</td>
      <td data-label="Precio" class="strike" style="font-family:'Space Grotesk'">${fmtMoney(t.price)}</td>
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
  const sig = JSON.stringify([g.total, g.paid, g.pending, g.expenses.map(e => [e.id, e.name, e.amount, e.account, e.status])]);
  if (silent && sig === _sigGastos) return;
  _sigGastos = sig;
  // tarjetas: pendiente (lo que se debe) destacado, pagado, total, y ganancia neta
  const vendido = sum ? sum.total : 0;
  const neta = vendido - g.total;
  $('#gx-stats').innerHTML = `
    <div class="stat" style="border-color:rgba(232,112,106,.4)">
      <div class="sk">Se debe (pendiente)</div>
      <div class="sv" style="color:var(--danger)">${fmtMoney(g.pending)}</div></div>
    <div class="stat"><div class="sk">Ya pagado</div><div class="sv">${fmtMoney(g.paid)}</div></div>
    <div class="stat"><div class="sk">Total de gastos</div><div class="sv">${fmtMoney(g.total)}</div></div>
    <div class="stat"><div class="sk">Ganancia neta (vendido − gastos)</div>
      <div class="sv" style="color:${neta >= 0 ? 'var(--ok)' : 'var(--danger)'}">${fmtMoney(neta)}</div>
      <div class="muted" style="font-size:9px;margin-top:2px">vendido ${fmtMoney(vendido)}</div></div>`;
  // desglose por cuenta (quién puso cuánto)
  const bac = $('#gx-byaccount-card');
  if (g.by_account.length) {
    bac.style.display = '';
    $('#gx-byaccount').innerHTML = g.by_account.map(a => `
      <div class="row" style="justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,120,40,.1)">
        <div style="font:700 13px Manrope;min-width:100px">${esc(a.account)}</div>
        <div class="muted" style="font-size:12px">puso <b style="color:var(--cream)">${fmtMoney(a.total)}</b></div>
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
    tr.innerHTML = `
      <td data-label="Gasto" class="cell-name"><span class="clip" title="${esc(e.name)}">${esc(e.name)}</span></td>
      <td data-label="Monto" style="font-family:'Space Grotesk';font-weight:700">${fmtMoney(e.amount)}</td>
      <td data-label="Cuenta">${e.account ? esc(e.account) : '<span class="muted">—</span>'}</td>
      <td data-label="Estado">${pagado ? '<span class="badge active">Pagado</span>' : '<span class="badge used">Pendiente</span>'}</td>`;
    const td = document.createElement('td');
    td.setAttribute('data-label', '');
    const mk = (label, fn, cls) => {
      const b = document.createElement('button');
      b.className = 'btn sm ' + (cls || 'ghost');
      b.style.width = 'auto'; b.style.marginRight = '6px'; b.style.marginBottom = '4px';
      b.textContent = label; b.onclick = fn;
      td.appendChild(b);
    };
    mk(pagado ? 'Marcar pendiente' : 'Marcar pagado',
       () => setExpenseStatus(e, pagado ? 'pendiente' : 'pagado'),
       pagado ? 'ghost' : '');
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
  // con 30 vendedores, buscar por nombre o código es lo que se usa a diario
  const q = (($('#sl-q') && $('#sl-q').value) || '').trim().toLowerCase();
  const sig = JSON.stringify([fa, q, ...r.sellers.map(s => [s.id, s.name, s.code, s.active, s.deleted, s.tickets, s.total, s.paid])]);
  if (silent && sig === _sigSellers) return;
  _sigSellers = sig;
  CACHE.sellers = r.sellers;
  const body = $('#sl-body');
  body.innerHTML = '';
  // filtro por admin (cliente): "" todos, "__none__" sin asignar, o el nombre
  const shown = r.sellers
    .filter(s => !fa || (fa === '__none__' ? !s.owner_admin_name : s.owner_admin_name === fa))
    .filter(s => !q || s.name.toLowerCase().includes(q) || (s.code || '').includes(q));
  $('#sl-count').textContent = `${shown.length} vendedor(es)`;
  if (!shown.length) { body.innerHTML = '<tr><td colspan="7" class="muted" style="padding:16px">Ningún vendedor coincide</td></tr>'; return; }
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
      <td data-label="Vendedor" class="cell-name" style="font-weight:700"><span class="clip" title="${esc(s.name)}">${esc(s.name)}</span>${adminLine}</td>
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
    const mine = s.owner_admin_id == null || s.owner_admin_id === ME_ID;
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
        <div class="muted" style="font-size:12px">Vendi\u00f3 en boletos</div>
        <div style="font:800 20px 'Space Grotesk';color:var(--cream)">${fmtMoney(c.sold)}</div>
      </div>
      <div class="row" style="justify-content:space-between;align-items:baseline;margin-top:7px">
        <div class="muted" style="font-size:12px">Se queda de comisi\u00f3n (${c.commission_pct}%)</div>
        <div style="font:700 15px 'Space Grotesk';color:#f3d27a">\u2212 ${fmtMoney(comisionTotal)}</div>
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
  const H = 470 + filas * 96;
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
  linea('Vendió en boletos', fmtMoney(c.sold), '#f6f1e7');
  linea(`Su comisión (${c.commission_pct}%)`, '− ' + fmtMoney(comisionTotal), '#f3d27a');
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

/* Opciones que casi no se usan, fuera de la fila para que no estorben. */
function menuVendedor(s) {
  modal(`<div class="h1" style="font-size:17px">${esc(s.name)}</div>
    <div class="muted mt8" style="font-size:12px">Código ${s.code ? esc(s.code) : 'privado'} \u00b7 ${s.tickets} boleto(s) vendidos</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">
      <button class="btn ghost" id="mv-edit">Editar nombre</button>
      <button class="btn ghost" id="mv-toggle">${s.active ? 'Desactivar' : 'Reactivar'} su acceso</button>
      <button class="btn danger" id="mv-del">Eliminar vendedor</button>
      <button class="btn quiet" onclick="closeModal()">Cancelar</button>
    </div>`);
  $('#mv-edit').onclick = () => editSeller(s);
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
    <div class="label mt12">Código de 4 dígitos</div>
    <input class="input" id="es-code" value="${esc(s.code)}" maxlength="4" inputmode="numeric">
    <div class="muted mt8">Si cambias el código, su sesión actual se cierra.</div>

    <div class="label mt16">Su comisión</div>
    <label class="row" style="gap:8px;cursor:pointer">
      <input type="checkbox" id="es-com-on" ${propia ? 'checked' : ''}>
      <span style="font:600 13px Manrope;color:var(--cream)">Ponerle un porcentaje distinto</span></label>
    <div class="row mt8" id="es-com-box" style="gap:8px;align-items:center;${propia ? '' : 'display:none'}">
      <input class="input" id="es-com" type="number" min="0" max="100" step="0.5"
        value="${propia ? cta.commission_pct : general}" style="width:110px">
      <span style="font:700 15px Manrope;color:var(--cream-60)">%</span>
    </div>
    <div class="muted mt8" style="font-size:11px" id="es-com-hint"></div>
    <div class="err mt8" id="es-err"></div>
    <div class="row mt16">
      <button class="btn ghost grow" onclick="closeModal()">Cancelar</button>
      <button class="btn grow" id="es-save">Guardar</button>
    </div>`);
  const sincroniza = () => {
    const on = $('#es-com-on').checked;
    $('#es-com-box').style.display = on ? '' : 'none';
    const v = parseFloat($('#es-com').value);
    $('#es-com-hint').innerHTML = !on
      ? `Usa la comisi\u00f3n general: <b>${general}%</b>`
      : (v > 0 ? `De cada $100 que te entregue, se queda <b>$${v.toFixed(2)}</b>`
               : '<b style="color:var(--danger)">Sin comisi\u00f3n</b>: te entrega todo lo que venda');
  };
  $('#es-com-on').onchange = sincroniza;
  $('#es-com').oninput = sincroniza;
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
function renderPhases(types) {
  const groups = {};   // clave "fecha|nombre" -> {name, starts_on, byType:{id:price_cents}}
  types.forEach(t => (t.phases || []).forEach(p => {
    const key = p.starts_on + '|' + p.name;
    const g = (groups[key] = groups[key] || { name: p.name, starts_on: p.starts_on, byType: {} });
    g.byType[t.id] = p.price_cents;
  }));
  const arr = Object.values(groups).sort((a, b) => a.starts_on < b.starts_on ? -1 : 1);
  const today = new Date().toLocaleDateString('en-CA');   // AAAA-MM-DD local
  const list = $('#ph-list');
  list.innerHTML = arr.length ? '' :
    '<div class="muted" style="font-size:12px">Sin fases todavía. Agrega la primera abajo.</div>';
  arr.forEach(g => {
    const vigente = g.starts_on <= today;
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 11px;border-radius:11px;margin-bottom:6px;background:rgba(255,255,255,.03);border:1px solid '
      + (vigente ? 'var(--ember)' : 'rgba(255,120,40,.15)');
    const top = document.createElement('div');
    top.className = 'row'; top.style.justifyContent = 'space-between';
    top.innerHTML = `<div style="font:700 12px Manrope">${esc(g.name)}${vigente ? ' <span style="color:var(--ember-soft);font-size:9px">● VIGENTE</span>' : ''}</div>
      <div class="muted" style="font-size:11px">desde ${esc(g.starts_on)}</div>`;
    const del = document.createElement('button');
    del.className = 'iconbtn'; del.style.cssText = 'width:26px;height:26px;font-size:11px';
    del.title = 'Eliminar fase'; del.textContent = '✕';
    del.onclick = async () => {
      try {
        await API.del(`/api/admin/phases-all?name=${encodeURIComponent(g.name)}&starts_on=${encodeURIComponent(g.starts_on)}`);
        loadCatalogs();
      } catch (e) { if (!guard(e)) toast(e.message); }
    };
    top.appendChild(del);
    row.appendChild(top);
    const pr = document.createElement('div');
    pr.style.cssText = 'margin-top:5px;display:flex;gap:12px;flex-wrap:wrap';
    pr.innerHTML = types.map(t => {
      const c = g.byType[t.id];
      return `<span style="font:600 11px Manrope;color:var(--cream-60)">${esc(t.name)}${t.is_vip ? ' ★' : ''}: <b style="color:var(--ember-soft)">${c != null ? fmtMoney(c / 100) : '—'}</b></span>`;
    }).join('');
    row.appendChild(pr);
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
      ${types.map(t => `<label style="font:600 10px Manrope;color:var(--cream-60);display:flex;flex-direction:column;gap:3px">${esc(t.name)}${t.is_vip ? ' ★' : ''} — precio nuevo
        <input class="input" type="number" min="1" placeholder="$" data-ph-price="${t.id}" style="width:110px;padding:9px;font-size:12px"></label>`).join('')}
      <button class="btn sm" id="btn-ph-create" style="width:auto">+ Fase</button>
    </div>`;

  $('#btn-ph-create').onclick = async () => {
    const prices = {};
    types.forEach(t => {
      const v = add.querySelector(`[data-ph-price="${t.id}"]`).value.trim();
      if (v) prices[t.id] = parseFloat(v);
    });
    $('#ph-err').textContent = '';
    try {
      await API.post('/api/admin/phases-all',
        { name: $('#ph-name').value.trim(), starts_on: $('#ph-date').value, prices });
      loadCatalogs();
    } catch (e) { if (!guard(e)) $('#ph-err').textContent = e.message; }
  };
}

async function loadCatalogs() {
  const [tt, fc] = await Promise.all([
    API.get('/api/admin/ticket-types'), API.get('/api/admin/faculties'),
  ]);
  // ----- tipos de boleto: solo precio base + editar -----
  $('#tt-list').innerHTML = '';
  tt.types.forEach(t => {
    const box = document.createElement('div');
    box.className = 'row';
    box.style.cssText = 'justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,120,40,.1)';
    box.innerHTML = `<div style="font:700 14px Manrope">${esc(t.name)}${t.is_vip ? ' <span style="color:#f3d27a">★</span>' : ''}
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
  // El nombre y el VIP son fijos, pero la facultad SÍ se puede corregir: solo UADY la
  // necesita, y un tipo creado con la casilla marcada por error quedaba pidiéndola
  // para siempre (y sacándola impresa en el boleto) sin forma de arreglarlo.
  modal(`<div class="h1" style="font-size:18px">Editar · ${esc(t.name)}</div>
    <div class="muted" style="margin-top:4px">${esc(t.name)}${t.is_vip ? ' — VIP ★' : ''} · siempre disponible</div>
    <div class="label mt16">Precio ($)</div>
    <input class="input" id="et-price" type="number" min="1" value="${t.price_cents / 100}">
    <label class="row mt16" style="gap:8px;cursor:pointer">
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
  grupo5: { label: 'Flyer Grupo de 5',
            sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                      faculty_name: '', type_name: 'Externo', type_is_vip: 0,
                      price: 153, normal_price: 175, group_size: 5, phase_name: 'Fase 1' } },
  grupo10: { label: 'Flyer Grupo de 10',
             sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                       faculty_name: '', type_name: 'Externo', type_is_vip: 0,
                       price: 161, normal_price: 175, group_size: 10, phase_name: 'Fase 1' } },
  ultravip: { label: '★ Flyer Ultra VIP', hidden: true,
              sample: { folio: 'HF-0001', qr_payload: 'demo', buyer_name: 'Nombre del Comprador',
                        faculty_name: '', type_name: 'Ultra VIP', type_is_vip: 1,
                        price: 600, phase_name: 'Fase 1' } },
};
const FLYER_VARIANTS = ['uady', 'externo', 'vip', 'grupo5', 'grupo10', 'ultravip'];
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
  const st = FLY_ED[variant];
  const ev = { ...EV, ['flyer_focus_' + variant]: st.focus, ['flyer_scale_' + variant]: st.scale };
  const cv = await renderTicket(FLYER_META[variant].sample, ev, st.img);
  st.ui.cv.width = cv.width; st.ui.cv.height = cv.height;
  st.ui.cv.getContext('2d').drawImage(cv, 0, 0);
  _fpBusy[variant] = false;
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

async function loadSettings() {
  const s = await API.get('/api/admin/settings');
  pintaVentas(s.ventas_cerradas);
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
