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
    : '<div class="r-type gen">General</div>') : '';   // UADY y Externo son General

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
  if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
    // Recortar SOLO la región del marco. El video se muestra con object-fit:cover,
    // así que mapeamos el recuadro en pantalla a los píxeles reales de la cámara.
    const cont = video.getBoundingClientRect();
    const fr = document.getElementById('cam-frame').getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(cont.width / vw, cont.height / vh);   // escala de "cover"
    const offX = (cont.width - vw * s) / 2, offY = (cont.height - vh * s) / 2;
    // marco → coordenadas de la fuente (video)
    let sx = (fr.left - cont.left - offX) / s;
    let sy = (fr.top - cont.top - offY) / s;
    let sw = fr.width / s, sh = fr.height / s;
    sx = Math.max(0, sx); sy = Math.max(0, sy);
    sw = Math.min(sw, vw - sx); sh = Math.min(sh, vh - sy);
    if (sw > 10 && sh > 10) {
      const outW = Math.min(Math.round(sw), 480);
      const outH = Math.max(1, Math.round(sh * outW / sw));
      workCv.width = outW; workCv.height = outH;
      const ctx = workCv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);   // solo el recuadro
      const code = jsQR(ctx.getImageData(0, 0, outW, outH).data, outW, outH, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        const now = Date.now();
        // mismo QR: no re-dispara por 3.5s. QR distinto: valida de inmediato.
        if (code.data !== lastCode || now - lastAt > 3500) {
          lastCode = code.data; lastAt = now;
          validate(code.data);
        }
      }
    }
  }
  requestAnimationFrame(tick);
}

/* ---------- arranque (directo, sin login) ---------- */
updateNet();
startCamera();
