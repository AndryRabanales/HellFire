/* OnFire — escáner de puerta, en tiempo real, escaneo continuo.

   Ya no es público: escanea un admin con su propia sesión (al abrirlo desde el
   panel entra directo), o el staff con la clave de 6 dígitos que el organizador
   genera el día del evento. Sin permiso, la cámara ni se enciende. */

let stream = null, scanning = false, busy = false, lastCode = '', lastAt = 0;
let SCAN_TOKEN = localStorage.getItem('onfire_scan_token') || '';

function tokenDePuerta() {
  // la sesión de admin (misma página, mismo navegador) también autoriza
  return SCAN_TOKEN || localStorage.getItem('onfire_admin_token') || '';
}

function mostrarGate(msj) {
  document.getElementById('view-gate').classList.remove('hidden');
  document.getElementById('view-scan').style.display = 'none';
  GATE_PIN = ''; document.getElementById('gate-code').value = ''; pintarGate();
  if (msj) document.getElementById('gate-err').textContent = msj;
  stopCam();
  setTimeout(enfocarGate, 300);
}

let GATE_PIN = '';
function pintarGate() {
  const cajas = document.querySelectorAll('#gate-row .pinbox');
  cajas.forEach((b, i) => {
    b.textContent = GATE_PIN[i] || '•';
    b.classList.toggle('filled', i < GATE_PIN.length);
  });
}
function enfocarGate() {
  document.getElementById('gate-code').focus({ preventScroll: true });
}

async function entrarConClave() {
  const code = GATE_PIN;
  document.getElementById('gate-err').textContent = '';
  if (code.length < 6) {
    document.getElementById('gate-err').textContent = 'Escribe la clave de 6 dígitos';
    enfocarGate();
    return;
  }
  try {
    const res = await fetch('/api/scan-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const r = await res.json();
    if (!res.ok) {
      document.getElementById('gate-err').textContent = r.error || 'Clave incorrecta';
      GATE_PIN = ''; document.getElementById('gate-code').value = ''; pintarGate();
      enfocarGate();
      return;
    }
    SCAN_TOKEN = r.token;
    localStorage.setItem('onfire_scan_token', r.token);
    document.getElementById('view-gate').classList.add('hidden');
    document.getElementById('view-scan').style.display = '';
    ensureCamera();
    cargarEntradas();
  } catch (e) {
    document.getElementById('gate-err').textContent = 'Sin conexión, intenta de nuevo';
  }
}

// Cuánto se queda el resultado en pantalla antes de limpiarse solo. Si se quedara
// fijo (como antes), el staff podría estar viendo un "ENTRA" viejo mientras la
// siguiente persona muestra un boleto que ni siquiera se alcanzó a leer.
const RESULT_MS = 8000;
let hideTimer = null;

async function call(code) {
  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
               'Authorization': 'Bearer ' + tokenDePuerta() },
    body: JSON.stringify({ code }),
  });
  if (res.status === 401) {
    // la clave se rotó o la sesión venció: de vuelta al candado, sin perder gente
    // en la fila con un error mudo
    SCAN_TOKEN = '';
    localStorage.removeItem('onfire_scan_token');
    mostrarGate('La clave cambió. Pide la nueva al organizador.');
    throw new Error('sin permiso');
  }
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
/* Si la señal se cae justo DESPUÉS de que el servidor marcó el ingreso, este
   teléfono no recibió la respuesta y al reintentar el mismo QR vería "YA SE USÓ"
   en rojo... por su propio escaneo. Se apuntan los códigos cuya respuesta se
   perdió: si al reintentar el servidor dice "usado" y ese código está apuntado
   AQUÍ, en este teléfono, es nuestro propio escaneo y la persona ENTRA.
   Solo vale en el dispositivo que lo escaneó: una copia en otra puerta no está
   en esta lista y sigue saliendo en rojo. */
const SIN_RESPUESTA = new Map();   // code -> cuándo falló
const REINTENTO_MS = 45000;   // el reintento real toma segundos; 45s ya es generoso

/* Un QR leído mientras se resuelve el anterior NO se tira. Antes se ignoraba en
   silencio: la pantalla seguía enseñando el "✓ ENTRA" verde de la persona de
   adelante, el de atrás pasaba, y su boleto nunca se marcó. Se guarda y se valida
   en cuanto termina el que va corriendo. */
let pendiente = null, enCurso = '';

async function validate(code) {
  if (busy) { if (code !== enCurso) pendiente = code; return; }
  busy = true;
  enCurso = code;
  // Se apunta como "ya leído" AQUÍ, donde de verdad se consulta. Si se apuntara al
  // detectarlo en la cámara, un código encolado quedaría marcado sin haberse
  // consultado; y si no se apuntara nunca, la cámara volvería a dispararlo al
  // terminar y el mismo boleto saldría "YA SE USÓ" en rojo por su propio escaneo.
  lastCode = code; lastAt = Date.now();
  // Feedback INMEDIATO: entre leer el QR y la respuesta del servidor había pantalla
  // muda, y en una red lenta eso son segundos con la persona parada enfrente. Ahora
  // se ve "leyendo" desde el primer instante, para que nadie pase por el silencio.
  leyendo();
  try {
    const r = await call(code);
    if (r.result === 'usado' && SIN_RESPUESTA.has(code) &&
        Date.now() - SIN_RESPUESTA.get(code) < REINTENTO_MS) {
      r.result = 'valido';
      r.recuperado = true;
    }
    SIN_RESPUESTA.delete(code);
    render(r);
    if (r.result === 'valido') cargarEntradas();   // el contador y la lista al día
    if (navigator.vibrate) navigator.vibrate(r.result === 'valido' ? 90 : [70, 60, 70]);
  } catch (e) {
    if (e.message !== 'sin permiso') SIN_RESPUESTA.set(code, Date.now());
    render({ result: 'error', message: navigator.onLine === false
      ? 'Sin conexión — vuelve a apuntar al MISMO código al regresar la señal'
      : 'Error, intenta de nuevo con el mismo código' });
  } finally {
    // respiro corto: ya no hace falta que sea largo, porque lo que llegue durante
    // el respiro se encola en vez de perderse
    setTimeout(() => {
      busy = false; enCurso = '';
      if (pendiente) { const c = pendiente; pendiente = null; validate(c); }
    }, 250);
  }
}

function leyendo() {
  const box = document.getElementById('result');
  clearTimeout(hideTimer);
  box.className = 'show wait';
  box.innerHTML = '<div class="r-title">LEYENDO…</div>'
    + '<div class="r-meta">No lo dejes pasar todavía</div>';
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
  // En la puerta hay que saber QUÉ pasó, no solo si pasa: un Ultra VIP salía como
  // "★ VIP", una cortesía se veía igual que un boleto pagado y del grupo de 10 no se
  // decía nada —y el de la botella se reconoce justo aquí—.
  const type = t ? etiquetasDe(t) : '';

  box.className = 'show ' + cls;
  box.innerHTML = `<div class="r-title">${title}</div>${name}${type}` +
    (meta ? `<div class="r-meta">${esc(meta)}</div>` : '') +
    '<div class="r-bar"><i></i></div>';   // barra que drena: se ve cuánto le queda
  // se limpia solo, para que nunca quede un resultado viejo confundiendo en la puerta
  clearTimeout(hideTimer);
  hideTimer = setTimeout(clearResult, RESULT_MS);
}

/* Las etiquetas del boleto, con el mismo criterio que el boleto impreso: su
   categoría real, su color, y aparte lo que cambia la atención en la puerta o en la
   barra (cortesía, grupo, botella). */
function etiquetasDe(t) {
  const n = (t.type_name || '').toLowerCase().replace(/\s+/g, '');
  const ultra = n === 'ultravip';
  const alta = !!t.type_is_vip || ultra;
  const clase = ultra ? 'ultra' : (t.type_is_vip ? 'vip' : 'gen');
  const nombre = (t.type_name || 'General').toUpperCase();
  let html = `<div class="r-type ${clase}">${alta ? '★ ' : ''}${esc(nombre)}</div>`;
  if (t.es_cortesia) html += '<div class="r-tag cortesia">CORTESÍA · no pagó</div>';
  if (t.group_size) {
    html += t.es_representante
      ? '<div class="r-tag botella">★ BOTELLA · le toca a él</div>'
      : `<div class="r-tag grupo">GRUPO DE ${t.group_size}</div>`;
  }
  return html;
}

function clearResult() {
  const box = document.getElementById('result');
  box.className = '';
  box.innerHTML = '';
  lastCode = '';   // así el mismo QR se puede volver a escanear enseguida
}

/* ---------- cámara + lector QR ---------- */
async function startCamera() {
  const video = document.getElementById('cam'), status = document.getElementById('cam-status');
  try {
    if (stream) stream.getTracks().forEach(t => t.stop());   // no dejar cámaras colgadas
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false,
    });
    video.srcObject = stream;
    await video.play();
    // si el sistema corta la cámara (otra app la toma, se acaba la batería…), reabrir
    stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => startCamera()));
    status.textContent = 'Apunta la cámara al código QR';
    if (!scanning) { scanning = true; requestAnimationFrame(tick); }
  } catch (e) {
    scanning = false;
    status.textContent = 'Sin acceso a la cámara. Da permiso y recarga. (' + e.name + ')';
  }
}

/* Si el celular se bloquea o el staff cambia de app, iOS PAUSA el video. El bucle
   seguía corriendo sobre un cuadro CONGELADO: se veía la cámara y no marcaba ningún
   error, pero ya no leía un solo QR. Esto la reanuda (o la reabre si se cortó). */
let recuperando = false;
async function ensureCamera() {
  // con el candado en pantalla no hay nada que reanudar (y encender la cámara
  // detrás del candado asustaría a cualquiera)
  if (!document.getElementById('view-gate').classList.contains('hidden')) return;
  if (recuperando) return;
  recuperando = true;
  try {
    const video = document.getElementById('cam');
    const vivo = stream && stream.getVideoTracks().some(t => t.readyState === 'live');
    if (!vivo) { await startCamera(); return; }
    if (video.paused || video.ended) {
      try { await video.play(); } catch (_) { await startCamera(); }
    }
  } finally { recuperando = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureCamera(); });
window.addEventListener('pageshow', ensureCamera);
window.addEventListener('focus', ensureCamera);
const workCv = document.createElement('canvas');
function tick() {
  if (!scanning) return;
  const video = document.getElementById('cam');
  // red de seguridad: si el video quedó pausado o la cámara se cortó, reanudar aquí
  // mismo. Así se cura aunque no llegue ningún evento de visibilidad (pasa en iOS).
  if (video.paused || video.ended ||
      !(stream && stream.getVideoTracks().some(t => t.readyState === 'live'))) {
    ensureCamera();
    requestAnimationFrame(tick);
    return;
  }
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
        // OJO: solo se apunta como "ya leído" si de verdad se va a validar. Si se
        // apuntara aunque esté ocupado, ese boleto quedaría marcado como leído sin
        // haberse consultado nunca, y no se reintentaría hasta 3.5s después.
        if (code.data !== lastCode || now - lastAt > 3500) validate(code.data);
      }
    }
  }
  requestAnimationFrame(tick);
}

/* ---------- quiénes ya entraron ----------
   El staff necesita contestar "¿ya pasó fulano?" sin llamar al organizador, y saber
   cuántos van adentro. Se refresca al abrir y después de cada ingreso. */
let ENTRADAS = [];

async function cargarEntradas() {
  try {
    const res = await fetch('/api/scan/recent',
      { headers: { 'Authorization': 'Bearer ' + tokenDePuerta() } });
    if (!res.ok) return;
    const r = await res.json();
    ENTRADAS = r.entradas || [];
    document.getElementById('ent-num').textContent = r.total || 0;
    pintarEntradas();
  } catch (_) { /* la puerta no se cae por esto */ }
}

function pintarEntradas() {
  const q = (document.getElementById('ent-q').value || '').trim().toLowerCase();
  const vis = q ? ENTRADAS.filter(e => (e.buyer_name || '').toLowerCase().includes(q)) : ENTRADAS;
  document.getElementById('ent-sub').textContent = q
    ? `${vis.length} coincidencia(s)`
    : `Los ${vis.length} más recientes`;
  document.getElementById('ent-lista').innerHTML = vis.length ? vis.map(e => `
    <div class="ent-fila">
      <div class="e-n">${esc(e.buyer_name || '')}</div>
      ${e.type_is_vip ? '<div class="e-vip">★ VIP</div>' : ''}
      <div class="e-t">${(e.used_at || '').slice(11, 16)}</div>
    </div>`).join('')
    : `<div class="muted" style="text-align:center;padding:26px 0">${
        q ? 'Esa persona no ha entrado' : 'Todavía no entra nadie'}</div>`;
}

function abrirEntradas() {
  document.getElementById('ent-q').value = '';
  document.getElementById('entradas').classList.remove('hidden');
  cargarEntradas();
}
function cerrarEntradas() { document.getElementById('entradas').classList.add('hidden'); }

function stopCam() {
  scanning = false;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

/* ---------- arranque ---------- */
updateNet();
fetch('/api/event').then(r => r.json()).then(e => {
  if (e.event_name) document.getElementById('gate-evento').textContent = e.event_name;
}).catch(() => {});
document.getElementById('btn-ent').addEventListener('click', abrirEntradas);
document.getElementById('ent-cerrar').addEventListener('click', cerrarEntradas);
document.getElementById('ent-q').addEventListener('input', pintarEntradas);
document.getElementById('entradas').addEventListener('click', e => {
  if (e.target.id === 'entradas') cerrarEntradas();   // tocar fuera cierra
});
document.getElementById('btn-gate').addEventListener('click', entrarConClave);
document.getElementById('gate-row').addEventListener('click', enfocarGate);
document.getElementById('gate-code').addEventListener('input', e => {
  GATE_PIN = e.target.value.replace(/\D/g, '').slice(0, 6);
  e.target.value = GATE_PIN;
  pintarGate();
  document.getElementById('gate-err').textContent = '';
  if (GATE_PIN.length === 6) entrarConClave();
});
// ¿Con qué permiso arrancamos? Se prueba contra el servidor con un escaneo vacío:
// si responde 401, al candado; cualquier otra cosa significa que hay permiso.
(async () => {
  if (!tokenDePuerta()) { mostrarGate(); return; }
  try {
    await call('');          // 'no_existe' si hay permiso; lanza si es 401
    startCamera();
    cargarEntradas();
  } catch (_) { /* call() ya mandó al candado */ }
})();
