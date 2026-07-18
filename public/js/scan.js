/* OnFire — escáner de puerta ONLINE. Escanea el QR, valida contra la base en
   tiempo real y marca el boleto como INGRESÓ. Verde = pasa, rojo = falso/repetido. */
API.init('onfire_admin_token');

let stream = null, scanning = false, lastCode = '', lastAt = 0, busy = false;

function show(view) {
  $('#view-login').classList.toggle('hidden', view !== 'login');
  $('#view-scan').classList.toggle('hidden', view !== 'scan');
}

/* ---------- login ---------- */
async function login() {
  $('#lg-err').textContent = '';
  try {
    const r = await API.post('/api/admin/login', {
      username: $('#lg-user').value.trim(), password: $('#lg-pass').value,
    });
    API.setToken(r.token);
    enter();
  } catch (e) { $('#lg-err').textContent = e.message; }
}

function enter() { show('scan'); updateNet(); startCamera(); }

function logoutLocal() { API.setToken(null); stopCamera(); show('login'); }

/* ---------- estado de conexión ---------- */
function updateNet() {
  const bar = $('#netbar');
  if (navigator.onLine !== false) {
    bar.className = 'netbar online mt12';
    $('#net-text').textContent = 'Conectado — validando en vivo';
  } else {
    bar.className = 'netbar offline mt12';
    $('#net-text').textContent = 'SIN CONEXIÓN — no se puede validar';
  }
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

/* ---------- validación ---------- */
async function validate(code) {
  if (busy) return;
  busy = true;
  try {
    const r = await API.post('/api/scan', { code });
    render(r);
    if (navigator.vibrate) navigator.vibrate(r.result === 'valido' ? 90 : [70, 60, 70]);
  } catch (e) {
    if (e.data && e.data._unauthorized) return logoutLocal();
    render({ result: 'error', message: navigator.onLine === false
      ? 'Sin conexión — revisa el internet de la puerta' : e.message });
  } finally {
    setTimeout(() => { busy = false; }, 700);   // evita doble disparo del mismo QR
  }
}

/* Pantalla simple para el guardia: ENTRA / NO ENTRA + nombre + VIP o General. */
function render(r) {
  const box = $('#result');
  const t = r.ticket;
  const name = t ? `<div class="r-name">${esc(t.buyer_name || '')}</div>` : '';
  const type = t ? (t.type_is_vip
    ? '<div class="r-type vip">★ VIP</div>'
    : `<div class="r-type gen">${esc(t.type_name || 'General')}</div>`) : '';
  if (r.result === 'valido') {
    box.innerHTML = `<div class="result ok">
      <div class="r-title">✓ ENTRA</div>${name}${type}</div>`;
  } else if (r.result === 'usado') {
    box.innerHTML = `<div class="result bad">
      <div class="r-title">✕ NO ENTRA</div>${name}${type}
      <div class="r-meta">Este boleto ya se usó (${esc((r.used_at || '').slice(11, 16))} h)</div></div>`;
  } else if (r.result === 'anulado') {
    box.innerHTML = `<div class="result bad">
      <div class="r-title">✕ NO ENTRA</div>${name}
      <div class="r-meta">Boleto anulado</div></div>`;
  } else if (r.result === 'no_existe') {
    box.innerHTML = `<div class="result bad">
      <div class="r-title">✕ NO ENTRA</div>
      <div class="r-meta">Boleto falso — no existe en el sistema</div></div>`;
  } else {
    box.innerHTML = `<div class="result warn"><div class="r-title">Error</div>
      <div class="r-meta">${esc(r.message || 'Intenta de nuevo')}</div></div>`;
  }
}

/* ---------- cámara + lector QR ---------- */
async function startCamera() {
  const video = $('#cam'), status = $('#cam-status');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false,
    });
    video.srcObject = stream;
    await video.play();
    scanning = true;
    requestAnimationFrame(tick);
  } catch (e) {
    status.textContent = 'Sin acceso a la cámara — usa el folio a mano. (' + e.name + ')';
  }
}
const workCv = document.createElement('canvas');
function tick() {
  if (!scanning) return;
  const video = $('#cam');
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const w = Math.min(video.videoWidth, 640);
    const h = Math.round(video.videoHeight * (w / video.videoWidth));
    workCv.width = w; workCv.height = h;
    const ctx = workCv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    if (code && code.data) {
      const now = Date.now();
      if (code.data !== lastCode || now - lastAt > 3500) {
        lastCode = code.data; lastAt = now;
        validate(code.data);
      }
    }
  }
  requestAnimationFrame(tick);
}
function stopCamera() {
  scanning = false;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

/* ---------- eventos ---------- */
$('#btn-login').addEventListener('click', login);
$('#lg-pass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('#btn-logout').addEventListener('click', async () => {
  try { await API.post('/api/logout'); } catch (_) {}
  logoutLocal();
});
$('#btn-manual').addEventListener('click', () => {
  const v = $('#manual').value.trim();
  if (v) { validate(v); $('#manual').value = ''; }
});
$('#manual').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-manual').click(); });

/* ---------- arranque ---------- */
(async function boot() {
  if (API.token) {
    try {
      const me = await API.get('/api/me');
      if (me.role === 'admin') return enter();
    } catch (_) {}
    API.setToken(null);
  }
  show('login');
})();
