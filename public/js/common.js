/* OnFire — helpers compartidos */
const API = {
  token: null,
  storageKey: 'onfire_token',
  init(key) {
    this.storageKey = key || this.storageKey;
    this.token = localStorage.getItem(this.storageKey);
  },
  setToken(t) {
    this.token = t;
    if (t) localStorage.setItem(this.storageKey, t);
    else localStorage.removeItem(this.storageKey);
  },
  async call(method, path, body) {
    const opts = { method, headers: {} };
    if (this.token) opts.headers['Authorization'] = 'Bearer ' + this.token;
    if (body !== undefined && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      opts.body = body;
    }
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401) { data._unauthorized = true; }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Error de conexión'), { data, status: res.status });
    return data;
  },
  get(p) { return this.call('GET', p); },
  post(p, b) { return this.call('POST', p, b); },
  put(p, b) { return this.call('PUT', p, b); },
  del(p) { return this.call('DELETE', p); },
};

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtMoney(n) {
  return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d)) return iso;
  const today = new Date(); const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const hm = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'hoy ' + hm;
  if (sameDay(d, yd)) return 'ayer ' + hm;
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) + ' ' + hm;
}

let _toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const STATUS_ES = { active: 'ACTIVO', void: 'ANULADO' };
