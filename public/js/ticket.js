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

/* Un flyer por tipo de boleto: uady, externo, vip, grupo5, grupo10. */
const _flyerCache = { uady: undefined, externo: undefined, vip: undefined, grupo5: undefined, grupo10: undefined };
function flyerVariantFor(ticket) {
  if (ticket.group_size === 5) return 'grupo5';
  if (ticket.group_size === 10) return 'grupo10';
  if (ticket.type_is_vip) return 'vip';
  return ticket.type_name === 'UADY' ? 'uady' : 'externo';
}
// etiqueta visible del tipo: la gente debe saber si es UADY, Externo, VIP o Grupo
function ticketTypeLabel(ticket) {
  if (ticket.group_size) return 'Grupo';
  if (ticket.type_is_vip) return 'VIP';
  return ticket.type_name === 'UADY' ? 'UADY' : 'Externo';
}

/* insignia del tipo de boleto: grupo y VIP llevan degradado (categorías especiales),
   UADY/Externo llevan un contorno más discreto (categorías regulares) */
function ticketBadgeSpec(ticket) {
  if (ticket.group_size)
    return { text: 'GRUPO ' + ticket.group_size, grad: ['#ff7a4d', '#c81e3a'], textColor: '#fff3ee' };
  if (ticket.type_is_vip)
    return { text: '★ VIP', grad: ['#f3d27a', '#d9a53a'], textColor: '#3a1e00' };
  return { text: ticketTypeLabel(ticket).toUpperCase(), ghost: true };
}

function drawTicketBadge(ctx, spec, x, y) {
  ctx.font = '800 15px Manrope, sans-serif';   // Manrope sí dibuja bien el glifo ★
  const tw = ctx.measureText(spec.text).width;
  const bh = 30, bw = tw + 26;
  if (spec.ghost) {
    ctx.strokeStyle = 'rgba(255,150,80,.55)';
    ctx.lineWidth = 1.4;
    roundRect(ctx, x, y, bw, bh, 8); ctx.stroke();
    ctx.fillStyle = '#ffb27a';
  } else {
    const gg = ctx.createLinearGradient(x, y, x + bw, y + bh);
    gg.addColorStop(0, spec.grad[0]); gg.addColorStop(1, spec.grad[1]);
    ctx.fillStyle = gg;
    roundRect(ctx, x, y, bw, bh, 8); ctx.fill();
    ctx.fillStyle = spec.textColor;
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(spec.text, x + bw / 2, y + bh / 2 + 1);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  return bw;
}
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
  const variant = flyerVariantFor(ticket);   // cada tipo usa SU flyer
  const flyer = imgOverride !== undefined ? imgOverride
    : await loadFlyer(variant, ev['flyer_' + variant]);
  // Boleto de alto medio (800×1550): cómodo al descargarlo, sin verse "zoom".
  // El flyer se ajusta al ANCHO a escala natural (no se agranda), llenando de borde a
  // borde; el sobrante o recorte queda arriba/abajo (nunca a los lados). Abajo, una
  // banda SEPARADA (línea punteada) con el nombre + QR.
  const W = 800, BAND = 280, H = 1550, FLY = H - BAND;   // 800×1550
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  const focusY = clamp(ev['flyer_focus_' + variant] ?? ev.flyer_focus ?? 0.5, 0, 1);
  const scale = clamp(ev['flyer_scale_' + variant] ?? ev.flyer_scale ?? 1, 1, 3);
  const drawPlaceholder = () => {
    // placeholder con el nombre del evento (estilo del mockup de acceso)
    const g = ctx.createRadialGradient(W / 2, 80, 40, W / 2, FLY * 0.42, FLY);
    g.addColorStop(0, '#3a0f04'); g.addColorStop(0.45, '#160603'); g.addColorStop(1, '#050302');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, FLY);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,150,80,.7)';
    ctx.font = '400 28px "Space Grotesk", monospace';
    letterSpaced(ctx, (ev.event_subtitle || '').toUpperCase(), W / 2, FLY * 0.42 - 70, 14);
    ctx.fillStyle = '#ff7a2e';
    ctx.shadowColor = 'rgba(255,110,30,.75)'; ctx.shadowBlur = 34;
    ctx.font = '800 104px Cinzel, serif';
    ctx.fillText(ev.event_name || 'EVENTO', W / 2, FLY * 0.42 + 30);
    ctx.shadowBlur = 0;
  };
  // si el flyer no cargó bien (archivo dañado, dimensiones inválidas, lo que sea),
  // jamás debe tronar la descarga del boleto — cae al placeholder y ya
  if (flyer && flyer.width > 0 && flyer.height > 0) {
    try {
      const s = (W / flyer.width) * scale;   // llena el ANCHO a escala natural (sin zoom)
      const dw = flyer.width * s, dh = flyer.height * s;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, FLY); ctx.clip();             // no invade la banda
      ctx.drawImage(flyer, (W - dw) / 2, (FLY - dh) * focusY, dw, dh);
      ctx.restore();
    } catch (e) {
      ctx.restore();
      drawPlaceholder();
    }
  } else {
    drawPlaceholder();
  }
  // degradado suave hacia la banda
  const fade = ctx.createLinearGradient(0, FLY - 160, 0, FLY);
  fade.addColorStop(0, 'rgba(5,3,2,0)'); fade.addColorStop(1, '#050302');
  ctx.fillStyle = fade; ctx.fillRect(0, FLY - 160, W, 160);

  // ---- banda inferior SEPARADA (línea punteada + nombre + QR)
  ctx.fillStyle = '#050302';
  ctx.fillRect(0, FLY, W, BAND);
  ctx.strokeStyle = 'rgba(255,120,40,.35)';
  ctx.lineWidth = 2; ctx.setLineDash([10, 8]);
  ctx.beginPath(); ctx.moveTo(0, FLY + 1); ctx.lineTo(W, FLY + 1); ctx.stroke();
  ctx.setLineDash([]);

  const padX = 44;
  const contentTop = FLY + 28;   // la ubicación/fecha ya va en el flyer, no se repite aquí

  const qrSize = 224;                                  // QR grande, fácil de escanear
  const qrX = W - padX - qrSize, qrY = contentTop;
  ctx.shadowColor = 'rgba(255,110,30,.35)'; ctx.shadowBlur = 24;
  drawQR(ctx, ticket.qr_payload || ticket.qr_token, qrX, qrY, qrSize);
  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,150,80,.6)';
  ctx.font = '600 13px "Space Grotesk", monospace';
  letterSpaced(ctx, 'ESCANÉALO EN LA PUERTA', qrX + qrSize / 2, qrY + qrSize + 22, 1.6);

  // columna izquierda: insignia del tipo · a nombre de · nombre · facultad · precio
  ctx.textAlign = 'left';
  let ty = contentTop;
  ctx.fillStyle = 'rgba(255,150,80,.6)';
  ctx.font = '600 15px "Space Grotesk", monospace';
  letterSpaced(ctx, 'A NOMBRE DE', padX, ty + 12, 2.6);
  drawTicketBadge(ctx, ticketBadgeSpec(ticket), padX + 178, ty - 9);
  ty += 60;
  ctx.fillStyle = '#f6f1e7';
  const nameFont = nameFontFor(ticket.buyer_name);
  fitText(ctx, ticket.buyer_name, padX, ty, W - padX * 2 - qrSize - 30, 42, '800 %px ' + nameFont);
  ty += 44;
  if (ticket.faculty_name) {                    // Externo/VIP no llevan facultad
    ctx.fillStyle = 'rgba(246,241,231,.55)';
    ctx.font = '600 21px Manrope, sans-serif';
    ctx.fillText(ticket.faculty_name, padX, ty);
    ty += 36;
  }
  ty += 10;

  // línea de precio: transparencia contra fraude — cada quien ve en su boleto
  // cuánto se registró que pagó
  if (ticket.group_size) {
    const normalTxt = fmtMoney(ticket.normal_price);
    const paidTxt = fmtMoney(ticket.price);
    ctx.font = '600 16px "Space Grotesk", monospace';
    ctx.fillStyle = 'rgba(246,241,231,.4)';
    ctx.fillText(normalTxt, padX, ty);
    const w1 = ctx.measureText(normalTxt).width;
    ctx.strokeStyle = 'rgba(246,241,231,.5)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(padX - 2, ty - 6); ctx.lineTo(padX + w1 + 2, ty - 6); ctx.stroke();
    ctx.font = '800 18px Manrope, sans-serif';
    ctx.fillStyle = '#ff8a4d';
    ctx.fillText(paidTxt, padX + w1 + 12, ty + 1);
    if (ticket.phase_name) {
      const w2 = ctx.measureText(paidTxt).width;
      ctx.font = '600 12px "Space Grotesk", monospace';
      ctx.fillStyle = 'rgba(255,150,80,.5)';
      ctx.fillText('· ' + ticket.phase_name, padX + w1 + 12 + w2 + 10, ty);
    }
  } else {
    ctx.font = '700 20px Manrope, sans-serif';
    ctx.fillStyle = '#ff8a4d';
    const priceTxt = fmtMoney(ticket.price) + (ticket.phase_name ? '  ·  ' + ticket.phase_name : '');
    ctx.fillText(priceTxt, padX, ty);
  }

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
      // el nombre del archivo usa al comprador, no el folio (el folio revela cuántos van vendidos)
      const slug = (ticket.buyer_name || 'boleto').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'boleto';
      a.download = 'boleto_' + slug + '.png';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); resolve(); }, 400);
    }, 'image/png');
  });
}
