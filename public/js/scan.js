/* OnFire — escáner de puerta PÚBLICO, en tiempo real, escaneo continuo.
   No requiere login: abres /scan y estás listo. Escanea → muestra resultado
   compacto abajo → apunta al siguiente QR y se actualiza solo. */

let stream = null, scanning = false, busy = false, lastCode = '', lastAt = 0;

async function call(code) {
  const res = await fetch('/api/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return res.json();
}

/* ---------- estado de conexión ---------- */
function updateNet() {
  const el = document.getElementById('live'), on = navigator.onLine !== false;
  el.className = 'live' + (on ? '' : ' off');
  document.getElementById('live-text').textContent = on ? 'En vivo' : 'Sin conexión';
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

/* ---------- validación ---------- */
async function validate(code) {
  if (busy) return;
  busy = true;
  try {
    const r = await call(code);
    render(r);
    if (navigator.vibrate) navigator.vibrate(r.result === 'valido' ? 90 : [70, 60, 70]);
  } catch (e) {
    render({ result: 'error', message: navigator.onLine === false
      ? 'Sin conexión — revisa el internet de la puerta' : 'Error, intenta de nuevo' });
  } finally {
    setTimeout(() => { busy = false; }, 600);   // pequeño respiro entre escaneos
  }
}

function render(r) {
  const box = document.getElementById('result'), t = r.ticket;
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
    (meta ? `<div class="r-meta">${esc(meta)}</div>` : '');
  // El mensaje se queda fijo en pantalla hasta que se escanee OTRO QR (o el mismo,
  // que vuelve a mostrar el resultado). No se auto-oculta.
}

/* ---------- cámara + lector QR ---------- */
async function startCamera() {
  const video = document.getElementById('cam'), status = document.getElementById('cam-status');
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
  const video = document.getElementById('cam');
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    const w = Math.min(video.videoWidth, 640);
    const h = Math.round(video.videoHeight * (w / video.videoWidth));
    workCv.width = w; workCv.height = h;
    const ctx = workCv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    if (code && code.data) {
      const now = Date.now();
      // mismo QR: no re-dispara por 3.5s. QR distinto: valida de inmediato.
      if (code.data !== lastCode || now - lastAt > 3500) {
        lastCode = code.data; lastAt = now;
        validate(code.data);
      }
    }
  }
  requestAnimationFrame(tick);
}

/* ---------- arranque (directo, sin login) ---------- */
updateNet();
startCamera();
