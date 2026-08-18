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

/* Un flyer por tipo de boleto: uady, externo, vip, grupo10, ultravip. */
const _flyerCache = { uady: undefined, externo: undefined, vip: undefined, grupo10: undefined, ultravip: undefined };
function flyerVariantFor(ticket) {
  // La cortesía manda sobre todo lo demás: su flyer no dice precio, y ponerle el de
  // venta a un invitado le enseñaría cuánto "vale" algo que se le regaló.
  if (ticket.es_cortesia) {
    const t = (ticket.type_name || '').toLowerCase().replace(/\s+/g, '');
    if (t === 'ultravip') return 'cortesiaultra';
    return ticket.type_is_vip ? 'cortesiavip' : 'cortesiaexterno';
  }
  if (ticket.group_size === 10) return 'grupo10';
  // se compara contra el NOMBRE del tipo, para que un tipo nuevo que cree el admin
  // (ej. "Ultra VIP") use su propio flyer en vez de caer en el de VIP o Externo
  const n = (ticket.type_name || '').toLowerCase().replace(/\s+/g, '');
  if (n === 'ultravip') return 'ultravip';
  if (n === 'uady') return 'uady';
  if (ticket.type_is_vip) return 'vip';
  return 'externo';
}
// Etiqueta visible: el NOMBRE REAL del tipo, tal cual lo escribió el admin. Antes
// estaba fijo a UADY/Externo/VIP, así que un tipo nuevo salía mal etiquetado.
function ticketTypeLabel(ticket) {
  if (ticket.group_size) return 'Grupo';
  return ticket.type_name || 'General';
}

/* Los tres colores de la casa, uno por categoría. Se declaran UNA vez porque los
   usan la insignia y el precio: si cada quien elige el suyo, tarde o temprano un
   boleto sale con la insignia de una categoría y el precio de otra.
     general (UADY/Externo) → rojo
     VIP                    → dorado
     Ultra VIP              → agua, tipo diamante  */
const TONO = {
  general: { grad: ['#ff7a4d', '#c81e3a'], texto: '#fff3ee', tinta: '#ff8a5c' },
  vip:     { grad: ['#f3d27a', '#d9a53a'], texto: '#3a1e00', tinta: '#f3d27a' },
  ultra:   { grad: ['#bff5ff', '#38bdf8'], texto: '#04283a', tinta: '#9fe8ff' },
};
/* La estrella es de las categorías altas: VIP y Ultra VIP la llevan, la general no.
   Se decide aquí una sola vez porque la usan el boleto, la tabla y el apartado de
   cortesías — si cada uno la pone por su cuenta, terminan sin coincidir. */
function estrellaDe(ticket) {
  return tonoDe(ticket) === TONO.general ? '' : '★ ';
}

function tonoDe(ticket) {
  const n = (ticket.type_name || '').toLowerCase().replace(/\s+/g, '');
  if (n === 'ultravip') return TONO.ultra;
  return ticket.type_is_vip ? TONO.vip : TONO.general;
}

/* insignia del tipo de boleto: grupo y VIP llevan degradado (categorías especiales),
   UADY/Externo llevan un contorno más discreto (categorías regulares) */
function ticketBadgeSpec(ticket) {
  if (ticket.es_cortesia) {
    // Una cortesía de Externo salía DORADA como las de VIP: en la puerta y en la
    // barra el color es lo primero que se mira, y así un invitado general parecía
    // VIP. Cada cortesía lleva el color de lo que de verdad da.
    const t = tonoDe(ticket);
    return { text: estrellaDe(ticket) + 'CORTESÍA · ' + (ticket.type_name || 'INVITADO').toUpperCase(),
             grad: t.grad, textColor: t.texto };
  }
  if (ticket.group_size) {
    // El representante lleva SU marca en el boleto, en dorado de botella. El de la
    // barra no tiene el panel abierto: tiene un boleto enfrente, y si los diez se
    // ven iguales cualquiera puede decir que él es.
    if (ticket.es_representante)
      return { text: '★ BOTELLA · REPRESENTANTE',
               grad: ['#f3d27a', '#d9a53a'], textColor: '#3a1e00' };
    return { text: 'GRUPO ' + ticket.group_size, grad: ['#ff7a4d', '#c81e3a'], textColor: '#fff3ee' };
  }
  if (ticket.type_is_vip) {
    // el nombre real, para que "Ultra VIP" no salga como "VIP", y su color propio
    const t = tonoDe(ticket);
    return { text: '★ ' + (ticket.type_name || 'VIP').toUpperCase(),
             grad: t.grad, textColor: t.texto };
  }
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

/* Acomoda el nombre del comprador en el ancho disponible. Antes se encogía hasta
   18px y un nombre largo quedaba ilegible; ahora prefiere PARTIRLO EN DOS LÍNEAS
   antes que achicarlo tanto, y solo recorta si es una sola palabra kilométrica. */
function medirNombre(ctx, texto, maxW, fuente) {
  const nombre = (texto || '').trim();
  const cabe = (t, tam) => {
    ctx.font = `800 ${tam}px ${fuente}`;
    return ctx.measureText(t).width <= maxW;
  };
  for (const tam of [40, 36, 33]) {          // 1) una línea, lo más grande que quepa
    if (cabe(nombre, tam)) return { lineas: [nombre], tam, alto: tam * 1.12, fuente };
  }
  const palabras = nombre.split(/\s+/);
  if (palabras.length > 1) {                 // 2) dos líneas, cortando lo más parejo
    for (const tam of [34, 30, 27, 24]) {
      ctx.font = `800 ${tam}px ${fuente}`;
      let mejor = null;
      for (let i = 1; i < palabras.length; i++) {
        const a = palabras.slice(0, i).join(' '), b = palabras.slice(i).join(' ');
        const wa = ctx.measureText(a).width, wb = ctx.measureText(b).width;
        if (wa <= maxW && wb <= maxW) {
          const dif = Math.abs(wa - wb);     // el corte más equilibrado se ve mejor
          if (!mejor || dif < mejor.dif) mejor = { a, b, dif };
        }
      }
      if (mejor) return { lineas: [mejor.a, mejor.b], tam, alto: tam * 1.12, fuente };
    }
  }
  const tam = 24;                            // 3) último recurso: recortar con …
  ctx.font = `800 ${tam}px ${fuente}`;
  let t = nombre;
  while (t.length > 4 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return { lineas: [t + '…'], tam, alto: tam * 1.12, fuente };
}

/* Precio pagado. En grupo se muestra el precio normal TACHADO junto al que pagó,
   para que el descuento se vea; el comprador es así testigo de lo que se registró. */
function dibujarPrecio(ctx, ticket, x, y) {
  ctx.textAlign = 'left';
  // El invitado no pagó: enseñarle el precio convierte un regalo en una factura, y
  // además delata lo que se cobró afuera. Tampoco lleva fase: no compró en ninguna.
  if (ticket.es_cortesia) {
    ctx.font = '800 26px Manrope, sans-serif';
    ctx.fillStyle = tonoDe(ticket).tinta;   // el mismo color que su insignia
    ctx.fillText('CORTESÍA', x, y + 3);
    return;
  }
  const fase = ticket.phase_name;
  const pintaFase = (px) => {
    if (!fase) return;
    ctx.font = '600 12px "Space Grotesk", monospace';
    ctx.fillStyle = 'rgba(255,150,80,.5)';
    ctx.fillText(fase, px, y);
  };
  // el tachado solo tiene sentido si de verdad hubo descuento (hoy los grupos van a
  // precio normal, así que caen en el caso simple de abajo)
  if (ticket.group_size && ticket.normal_price > ticket.price) {
    const normal = fmtMoney(ticket.normal_price), pagado = fmtMoney(ticket.price);
    ctx.font = '600 17px "Space Grotesk", monospace';
    ctx.fillStyle = 'rgba(246,241,231,.38)';
    ctx.fillText(normal, x, y);
    const w1 = ctx.measureText(normal).width;
    ctx.strokeStyle = 'rgba(246,241,231,.45)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(x - 2, y - 6); ctx.lineTo(x + w1 + 2, y - 6); ctx.stroke();
    ctx.font = '800 28px Manrope, sans-serif';
    ctx.fillStyle = '#ff8a4d';
    ctx.fillText(pagado, x + w1 + 14, y + 3);
    pintaFase(x + w1 + 14 + ctx.measureText(pagado).width + 12);
  } else {
    const pagado = fmtMoney(ticket.price);
    ctx.font = '800 28px Manrope, sans-serif';
    ctx.fillStyle = '#ff8a4d';
    ctx.fillText(pagado, x, y + 3);
    pintaFase(x + ctx.measureText(pagado).width + 12);
  }
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
  const qrSize = 224;                                  // QR grande, fácil de escanear
  const qrX = W - padX - qrSize, qrY = FLY + 26;
  ctx.shadowColor = 'rgba(255,110,30,.35)'; ctx.shadowBlur = 24;
  drawQR(ctx, ticket.qr_payload || ticket.qr_token, qrX, qrY, qrSize);
  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,150,80,.6)';
  ctx.font = '600 13px "Space Grotesk", monospace';
  letterSpaced(ctx, 'ESCANÉALO EN LA PUERTA', qrX + qrSize / 2, qrY + qrSize + 22, 1.6);

  // ---- columna izquierda. El contenido se reparte en TODA la altura de la banda:
  // la etiqueta arriba, el precio anclado abajo y el nombre ocupando el centro. Así
  // no queda un hueco muerto abajo y da igual si el nombre usa una línea o dos.
  const colW = qrX - padX - 28;          // ancho libre antes del QR
  ctx.textAlign = 'left';

  // 1) arriba: "a nombre de" + insignia del tipo
  ctx.fillStyle = 'rgba(255,150,80,.6)';
  ctx.font = '600 14px "Space Grotesk", monospace';
  const etiqueta = 'A NOMBRE DE';
  letterSpaced(ctx, etiqueta, padX, FLY + 44, 2.6);
  ctx.font = '600 14px "Space Grotesk", monospace';
  const anchoEtiqueta = [...etiqueta].reduce((a, ch) => a + ctx.measureText(ch).width, 0)
                        + 2.6 * (etiqueta.length - 1);
  drawTicketBadge(ctx, ticketBadgeSpec(ticket), padX + anchoEtiqueta + 18, FLY + 24);

  // 2) abajo: el precio, anclado al pie de la banda
  const precioY = FLY + BAND - 42;
  dibujarPrecio(ctx, ticket, padX, precioY);

  // 3) en medio: nombre (1 o 2 líneas) y facultad, centrados en el espacio que sobra
  const nombreArriba = FLY + 62;                 // debajo de la etiqueta
  const nombreAbajo = precioY - 30;              // encima del precio
  const hayFacultad = !!ticket.faculty_name;
  const lineas = medirNombre(ctx, ticket.buyer_name, colW, nameFontFor(ticket.buyer_name));
  const altoBloque = lineas.lineas.length * lineas.alto + (hayFacultad ? 30 : 0);
  let ty = nombreArriba + (nombreAbajo - nombreArriba - altoBloque) / 2 + lineas.tam * 0.78;

  ctx.fillStyle = '#f6f1e7';
  ctx.font = `800 ${lineas.tam}px ${lineas.fuente}`;
  lineas.lineas.forEach(l => { ctx.fillText(l, padX, ty); ty += lineas.alto; });
  if (hayFacultad) {                             // Externo/VIP no llevan facultad
    ctx.fillStyle = 'rgba(246,241,231,.55)';
    ctx.font = '600 20px Manrope, sans-serif';
    ctx.fillText(ticket.faculty_name, padX, ty + 4);
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
