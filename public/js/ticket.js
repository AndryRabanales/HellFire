/* OnFire — renderizador del boleto descargable (canvas), según diseño 2b:
   el flyer manda; el sistema sobreimprime folio, nombre y QR. */

// qrcode-generator toma cada carácter como un byte; para que los acentos (í, ñ, ·)
// se lean bien en cualquier lector, hay que pasar el texto ya en bytes UTF-8.
function toUTF8(s) { return unescape(encodeURIComponent(s)); }

function drawQR(ctx, text, x, y, size) {
  const qr = qrcode(0, 'M');           // qrcode-generator (vendor)
  qr.addData(toUTF8(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const pad = Math.round(size * 0.09);
  const inner = size - pad * 2;
  const cell = inner / n;
  // caja blanca redondeada
  ctx.fillStyle = '#fff';
  roundRect(ctx, x, y, size, size, size * 0.11);
  ctx.fill();
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c))
        ctx.fillRect(Math.round(x + pad + c * cell), Math.round(y + pad + r * cell),
                     Math.ceil(cell), Math.ceil(cell));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* Algunos navegadores cargan Cinzel sin glifos acentuados (ñ, á…) en canvas.
   Si el texto los usa y Cinzel no los dibuja, el nombre cae a Manrope. */
let _cinzelOkCache = null;
function nameFontFor(text) {
  if (!/[^\x00-\x7F]/.test(text)) return 'Cinzel, serif';
  if (_cinzelOkCache === null) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 40;
    const c = cv.getContext('2d');
    c.font = '800 30px Cinzel, serif';
    c.fillStyle = '#000';
    c.fillText('ñ', 4, 30);
    _cinzelOkCache = c.getImageData(0, 0, 40, 40).data.some((v, i) => i % 4 === 3 && v > 0);
  }
  return _cinzelOkCache ? 'Cinzel, serif' : 'Manrope, sans-serif';
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v))); }

/* Dos flyers: 'vip' y 'gen'. Cada boleto usa el de su tipo. */
const _flyerCache = { vip: undefined, gen: undefined };
function loadFlyer(variant, hasFlyer) {
  if (!hasFlyer) return Promise.resolve(null);
  if (_flyerCache[variant] !== undefined) return Promise.resolve(_flyerCache[variant]);
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => { _flyerCache[variant] = img; resolve(img); };
    img.onerror = () => { _flyerCache[variant] = null; resolve(null); };
    img.src = '/flyer?v=' + variant + '&ts=' + Date.now();
  });
}

/* ticket: {folio, qr_token, buyer_name, faculty_name, type_name, type_is_vip, price}
   ev: {event_name, event_subtitle, event_date_text,
        flyer_vip/flyer_gen:boolean, flyer_focus_vip/gen:0..1, flyer_scale_vip/gen:1..3}
   imgOverride: si se pasa una <img> (o null), se usa esa en vez de cargar /flyer
                — sirve para la vista previa del admin antes de subir. */
async function renderTicket(ticket, ev, imgOverride) {
  await document.fonts.ready;
  const variant = ticket.type_is_vip ? 'vip' : 'gen';   // cada tipo usa SU flyer
  const flyer = imgOverride !== undefined ? imgOverride
    : await loadFlyer(variant, ev['flyer_' + variant]);
  // Proporción de pantalla de celular (~9:19.5): el boleto descargado ocupa
  // toda la pantalla del móvil. Footer compacto; el flyer llena el resto.
  const W = 800, FLY = 1450, BAND = 280, H = FLY + BAND;   // 800×1730 ≈ 9:19.5, footer más alto
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // ---- zona del flyer (grande)
  const focusY = clamp(ev['flyer_focus_' + variant] ?? ev.flyer_focus ?? 0.5, 0, 1);
  const scale = clamp(ev['flyer_scale_' + variant] ?? ev.flyer_scale ?? 1, 1, 3);
  if (flyer) {
    const s = Math.max(W / flyer.width, FLY / flyer.height) * scale;   // "cover" + zoom
    const dw = flyer.width * s, dh = flyer.height * s;
    ctx.drawImage(flyer, (W - dw) / 2, (FLY - dh) * focusY, dw, dh);   // focusY mueve en vertical
  } else {
    // placeholder con el nombre del evento (estilo del mockup de acceso)
    const g = ctx.createRadialGradient(W / 2, 60, 40, W / 2, FLY * 0.42, FLY);
    g.addColorStop(0, '#3a0f04'); g.addColorStop(0.45, '#160603'); g.addColorStop(1, '#050302');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, FLY);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,150,80,.7)';
    ctx.font = '400 26px "Space Grotesk", monospace';
    letterSpaced(ctx, (ev.event_subtitle || '').toUpperCase(), W / 2, FLY * 0.44 - 60, 14);
    ctx.fillStyle = '#ff7a2e';
    ctx.shadowColor = 'rgba(255,110,30,.75)'; ctx.shadowBlur = 34;
    ctx.font = '800 96px Cinzel, serif';
    ctx.fillText(ev.event_name || 'EVENTO', W / 2, FLY * 0.44 + 34);
    ctx.shadowBlur = 0;
    if (ev.event_date_text) {
      ctx.fillStyle = 'rgba(246,241,231,.5)';
      ctx.font = '400 22px "Space Grotesk", monospace';
      letterSpaced(ctx, ev.event_date_text.toUpperCase(), W / 2, FLY * 0.44 + 104, 8);
    }
  }
  // degradado inferior hacia la banda
  const fade = ctx.createLinearGradient(0, FLY - 220, 0, FLY);
  fade.addColorStop(0, 'rgba(5,3,2,0)'); fade.addColorStop(1, '#050302');
  ctx.fillStyle = fade; ctx.fillRect(0, FLY - 220, W, 220);

  // (sin insignia de folio arriba — el flyer se aprecia limpio)

  // ---- banda inferior COMPACTA (baja, sin precio)
  ctx.fillStyle = '#050302';
  ctx.fillRect(0, FLY, W, BAND);
  ctx.strokeStyle = 'rgba(255,120,40,.35)';
  ctx.lineWidth = 2; ctx.setLineDash([10, 8]);
  ctx.beginPath(); ctx.moveTo(0, FLY + 1); ctx.lineTo(W, FLY + 1); ctx.stroke();
  ctx.setLineDash([]);

  const padX = 44;
  const qrSize = 224;                                   // QR grande, fácil de escanear
  const qrX = W - padX - qrSize, qrY = FLY + 28;
  ctx.shadowColor = 'rgba(255,110,30,.35)'; ctx.shadowBlur = 24;
  drawQR(ctx, ticket.qr_payload || ticket.qr_token, qrX, qrY, qrSize);
  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,150,80,.6)';
  ctx.font = '600 13px "Space Grotesk", monospace';
  letterSpaced(ctx, 'ESCANÉALO EN LA PUERTA', qrX + qrSize / 2, qrY + qrSize + 22, 1.6);

  // texto de la banda: a nombre de · nombre · facultad · tipo (sin precio), más grande
  ctx.textAlign = 'left';
  let ty = FLY + 66;
  ctx.fillStyle = 'rgba(255,150,80,.6)';
  ctx.font = '600 15px "Space Grotesk", monospace';
  letterSpaced(ctx, 'A NOMBRE DE', padX, ty, 2.6);
  if (ticket.type_is_vip) {
    const bx = padX + 178, by = ty - 22, bw = 92, bh = 32;
    const gg = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
    gg.addColorStop(0, '#f3d27a'); gg.addColorStop(1, '#d9a53a');
    ctx.fillStyle = gg;
    roundRect(ctx, bx, by, bw, bh, 9); ctx.fill();
    ctx.fillStyle = '#3a1e00';
    ctx.font = '800 17px "Space Grotesk", monospace';
    ctx.fillText('★ VIP', bx + 16, by + 22);
  }
  ty += 54;
  ctx.fillStyle = '#f6f1e7';
  const nameFont = nameFontFor(ticket.buyer_name);
  fitText(ctx, ticket.buyer_name, padX, ty, W - padX * 2 - qrSize - 30, 42, '800 %px ' + nameFont);
  ty += 44;
  ctx.fillStyle = 'rgba(246,241,231,.55)';
  ctx.font = '600 21px Manrope, sans-serif';
  ctx.fillText(ticket.faculty_name, padX, ty);
  ty += 36;
  ctx.fillStyle = '#ffb27a';
  ctx.font = '700 24px Manrope, sans-serif';
  ctx.fillText(ticket.type_name, padX, ty);

  return cv;
}

function letterSpaced(ctx, text, cx, y, spacing) {
  const widths = [...text].map(ch => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
  const align = ctx.textAlign;
  let x = align === 'center' ? cx - total / 2 : (align === 'right' ? cx - total : cx);
  ctx.textAlign = 'left';
  [...text].forEach((ch, i) => { ctx.fillText(ch, x, y); x += widths[i] + spacing; });
  ctx.textAlign = align;
}

function fitText(ctx, text, x, y, maxW, baseSize, fontTpl) {
  let size = baseSize;
  ctx.font = fontTpl.replace('%', size);
  while (ctx.measureText(text).width > maxW && size > 18) {
    size -= 2;
    ctx.font = fontTpl.replace('%', size);
  }
  ctx.fillText(text, x, y);
}

async function downloadTicket(ticket, ev) {
  const cv = await renderTicket(ticket, ev);
  return new Promise(resolve => {
    cv.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'boleto_' + ticket.folio + '.png';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); resolve(); }, 400);
    }, 'image/png');
  });
}
