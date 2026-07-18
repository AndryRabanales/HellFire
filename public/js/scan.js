/* OnFire — escáner de puerta ONLINE, en tiempo real, una sola pantalla.
   Escanea → muestra resultado compacto → "Aceptar" pasa al siguiente. */
API.init('onfire_admin_token');

let stream = null, scanning = false, paused = false, lastCode = '', lastAt = 0;

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
  const el = $('#live'), on = navigator.onLine !== false;
  el.className = 'live' + (on ? '' : ' off');
  $('#live-text').textContent = on ? 'En vivo' : 'Sin conexión';
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

/* ---------- validación ---------- */
async function validate(code) {
  if (paused) return;
  paused = true;                       // pausa hasta que el guardia dé "Aceptar"
  try {
    const r = await API.post('/api/scan', { code });
    render(r);
    if (navigator.vibrate) navigator.vibrate(r.result === 'valido' ? 90 : [70, 60, 70]);
  } catch (e) {
    if (e.data && e.data._unauthorized) return logoutLocal();
    render({ result: 'error', message: navigator.onLine === false
      ? 'Sin conexión — revisa el internet de la puerta' : e.message });
  }
}

function render(r) {
  const box = $('#result'), t = r.ticket;
  let cls = 'bad', title = '✕ NO ENTRA', meta = '';
  if (r.result === 'valido') { cls = 'ok'; title = '✓ ENTRA'; }
  else if (r.result === 'usado') meta = 'Ya se usó · ' + (r.used_at || '').slice(11, 16) + ' h';
  else if (r.result === 'anulado') meta = 'Boleto anulado';
  else if (r.result === 'no_existe') meta = 'Boleto falso — no existe';
  else { title = 'Error'; meta = r.message || 'Intenta de nuevo'; }

  const name = t ? `<div class="r-name">${esc(t.buyer_name || '')}</div>` : '';
  const type = t ? (t.type_is_vip
    ? '<div class="r-type vip">★ VIP</div>'
    : `<div class="r-type gen">${esc(t.type_name || 'General')}</div>`) : '';

  box.className = 'show ' + cls;
  box.innerHTML = `<div class="r-title">${title}</div>${name}${type}` +
    (meta ? `<div class="r-meta">${esc(meta)}</div>` : '') +
    `<button id="btn-accept">Aceptar</button>`;
  $('#btn-accept').onclick = accept;
}

function accept() {
  const box = $('#result');
  box.className = ''; box.innerHTML = '';
  lastCode = '';       // permite re-escanear incluso el mismo QR
  paused = false;
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
    status.textContent = 'Sin acceso a la cámara. Da permiso y recarga. (' + e.name + ')';
  }
}
const workCv = document.createElement('canvas');
function tick() {
  if (!scanning) return;
  const video = $('#cam');
  if (!paused && video.readyState === video.HAVE_ENOUGH_DATA) {
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
