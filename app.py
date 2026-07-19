#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OnFire — Plataforma de generación y control de boletos con QR
Backend: Flask + SQLite (archivo local, fácil de migrar a otra BD después).
Todos los datos de venta se sincronizan automáticamente a data/boletos.xlsx.
"""
import os, re, json, time, base64, shutil, sqlite3, secrets, hashlib, threading
from datetime import datetime, timedelta
from io import BytesIO
try:
    from zoneinfo import ZoneInfo
    EVENT_TZ = ZoneInfo(os.environ.get("EVENT_TZ", "America/Mexico_City"))
except Exception:
    EVENT_TZ = None   # sin base de zonas → cae a la hora local del servidor

from flask import Flask, request, jsonify, send_from_directory, send_file, g, Response
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

BASE    = os.path.dirname(os.path.abspath(__file__))
# DATA_DIR permite apuntar a un Volumen persistente (Railway u otro host).
# Si no se define, usa la carpeta local ./data (desarrollo).
DATA    = os.environ.get("DATA_DIR") or os.path.join(BASE, "data")
BACKUPS = os.path.join(DATA, "backups")
PUBLIC  = os.path.join(BASE, "public")
DB_PATH = os.path.join(DATA, "onfire.db")
XLSX    = os.path.join(DATA, "boletos.xlsx")

os.makedirs(BACKUPS, exist_ok=True)

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024  # flyer máx 8 MB

_write_lock = threading.Lock()

@app.after_request
def revalidate_assets(resp):
    # el navegador revalida HTML/JS/CSS en cada carga → nunca sirve una versión vieja
    ct = resp.headers.get("Content-Type", "")
    if any(t in ct for t in ("text/html", "javascript", "text/css")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp

# ---------------------------------------------------------------- utilidades

def now_dt():
    return datetime.now(EVENT_TZ)   # hora del evento (México por defecto), no UTC del servidor

def now_iso():
    return now_dt().strftime("%Y-%m-%d %H:%M:%S")

def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
    return f"{salt}${digest.hex()}"

def check_password(password, stored):
    try:
        salt, _ = stored.split("$", 1)
    except ValueError:
        return False
    return secrets.compare_digest(hash_password(password, salt), stored)

def money(cents):
    return float(cents or 0) / 100.0

# ------------------------------------------------------- contenido del QR
# El QR lleva un token aleatorio de 96 bits imposible de adivinar. El escáner lo
# valida contra la base en tiempo real; nadie puede fabricar un QR válido.
# Los datos legibles (nombre, tipo, folio) van IMPRESOS en el boleto, no en el QR.

def folio_from_scan(raw):
    """Del texto escaneado saca el identificador para buscar el boleto:
    el token tal cual, o el folio si se escribió/escaneó 'Folio HF-0001'."""
    raw = (raw or "").strip()
    m = re.search(r"[Ff]olio\s+(\S+)", raw)
    if m:
        return m.group(1)
    return raw

# ---------------------------------------------------------------- base de datos
# Funciona con SQLite (local, por defecto) o PostgreSQL (si existe DATABASE_URL,
# como en Railway). El resto del código usa la MISMA interfaz: db.execute("... ?",
# params).fetchone()/.fetchall(), db.commit(). El wrapper de Postgres traduce los
# marcadores ? → %s y entrega filas accesibles por nombre, igual que sqlite3.Row.

DATABASE_URL = os.environ.get("DATABASE_URL")
IS_PG = bool(DATABASE_URL)

if IS_PG:
    import psycopg
    from decimal import Decimal
    from psycopg.rows import dict_row
    IntegrityError = psycopg.IntegrityError
    LIKE = "ILIKE"   # búsqueda sin distinguir mayúsculas, como se comporta SQLite

    def _plain(row):
        """Convierte Decimal → int/float para que jsonify y el resto del código
        reciban los mismos tipos que con SQLite."""
        if row is None:
            return None
        out = {}
        for k, v in row.items():
            if isinstance(v, Decimal):
                v = int(v) if v == v.to_integral_value() else float(v)
            out[k] = v
        return out

    class _PGCursor:
        def __init__(self, cur, conn):
            self._cur, self._conn = cur, conn
        def fetchone(self):
            return _plain(self._cur.fetchone())
        def fetchall(self):
            return [_plain(r) for r in self._cur.fetchall()]
        @property
        def lastrowid(self):
            with self._conn.cursor() as c:
                c.execute("SELECT lastval()")
                return c.fetchone()[0]

    class PGConn:
        """Imita la interfaz de una conexión sqlite3 sobre psycopg."""
        def __init__(self, conn):
            self._conn = conn
        def execute(self, sql, params=()):
            cur = self._conn.cursor(row_factory=dict_row)
            cur.execute(sql.replace("?", "%s"), params)
            return _PGCursor(cur, self._conn)
        def executescript(self, script):
            with self._conn.cursor() as cur:
                for stmt in script.split(";"):
                    if stmt.strip():
                        cur.execute(stmt)
        def commit(self):
            self._conn.commit()
        def rollback(self):
            self._conn.rollback()
        def close(self):
            self._conn.close()

    def db_connect():
        return PGConn(psycopg.connect(DATABASE_URL))
else:
    IntegrityError = sqlite3.IntegrityError
    LIKE = "LIKE"

    def db_connect():
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

def get_db():
    if "db" not in g:
        g.db = db_connect()
    return g.db

@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT,                       -- NULL cuando el vendedor fue eliminado
  active INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  owner_admin_id INTEGER,          -- admin que creó al vendedor (su dueño)
  owner_admin_name TEXT,           -- nombre del admin dueño (etiqueta visible)
  paid_cents INTEGER NOT NULL DEFAULT 0,  -- dinero que el vendedor ya entregó a su admin
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  is_vip INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS price_phases (
  -- fases de precio por tipo: al llegar la fecha de cada fase, el precio cambia solo
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL,
  name TEXT NOT NULL,              -- ej. Preventa, Fase 2, General
  price_cents INTEGER NOT NULL,
  starts_on TEXT NOT NULL          -- fecha AAAA-MM-DD desde la que aplica
);
CREATE TABLE IF NOT EXISTS faculties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folio TEXT NOT NULL UNIQUE,
  qr_token TEXT NOT NULL UNIQUE,
  qr_payload TEXT,                 -- lo que va dentro del QR (token secreto)
  buyer_name TEXT NOT NULL,
  faculty_id INTEGER,
  faculty_name TEXT NOT NULL,      -- congelado al generar
  type_id INTEGER,
  type_name TEXT NOT NULL,         -- congelado al generar
  type_is_vip INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL,    -- congelado al generar (RF-40)
  seller_id INTEGER,
  seller_name TEXT NOT NULL,       -- congelado (se conserva si se elimina al vendedor)
  seller_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | used | void
  created_at TEXT NOT NULL,
  used_at TEXT,                    -- cuándo entró (primer escaneo en la puerta)
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,              -- seller | admin
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,               -- ip o ip+usuario
  ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {
    "event_name": "HELLFIRE",
    "event_subtitle": "Noche de brujas",
    "event_date_text": "",
    "folio_prefix": "HF-",
    "session_minutes": "480",
    "admin_session_minutes": "480",
    "ranking_winners": "3",
    "ranking_prizes": json.dumps([1000, 500, 250]),
    # Flyers por tipo de boleto: uno para VIP y otro para General. Cada uno con su
    # imagen (base64 en la BD), posición y zoom. Las claves sin sufijo son el flyer
    # "legado" (una sola imagen) y sirven de respaldo si aún no se sube el del tipo.
    "flyer_file": "", "flyer_data": "", "flyer_mime": "",
    "flyer_focus": "0.5", "flyer_scale": "1",
    "flyer_data_vip": "", "flyer_mime_vip": "", "flyer_focus_vip": "", "flyer_scale_vip": "",
    "flyer_data_gen": "", "flyer_mime_gen": "", "flyer_focus_gen": "", "flyer_scale_gen": "",
    "max_login_attempts": "8",
    "lockout_minutes": "10",
}

def setting(db, key):
    row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else DEFAULT_SETTINGS.get(key, "")

def set_setting(db, key, value):
    db.execute("INSERT INTO settings(key,value) VALUES(?,?) "
               "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))

def flyer_info(db):
    """Configuración de los dos flyers (vip/gen) para el frontend, con respaldo
    al flyer legado de una sola imagen."""
    out = {}
    for v in ("vip", "gen"):
        has = bool(setting(db, f"flyer_data_{v}") or setting(db, "flyer_data"))
        out[f"flyer_{v}"] = has
        out[f"flyer_focus_{v}"] = float(setting(db, f"flyer_focus_{v}")
                                        or setting(db, "flyer_focus") or 0.5)
        out[f"flyer_scale_{v}"] = float(setting(db, f"flyer_scale_{v}")
                                        or setting(db, "flyer_scale") or 1)
    return out

def effective_price(db, type_row):
    """Precio vigente de un tipo: la fase más reciente cuya fecha ya llegó;
    si no hay fase aplicable, el precio base del tipo."""
    today = now_dt().strftime("%Y-%m-%d")
    ph = db.execute("""SELECT * FROM price_phases WHERE type_id=? AND starts_on<=?
                       ORDER BY starts_on DESC, id DESC LIMIT 1""",
                    (type_row["id"], today)).fetchone()
    if ph:
        return ph["price_cents"], ph["name"]
    return type_row["price_cents"], None

def gen_seller_code(db):
    for _ in range(500):
        code = f"{secrets.randbelow(10000):04d}"
        taken = db.execute(
            "SELECT 1 FROM sellers WHERE code=? AND deleted=0", (code,)).fetchone()
        if not taken:
            return code
    raise RuntimeError("sin códigos disponibles")

def _schema_for_backend():
    s = SCHEMA
    if IS_PG:
        s = s.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
    return s

def init_db():
    # espera a que la base esté disponible (Railway puede tardar unos segundos al arrancar)
    db = None
    for intento in range(10):
        try:
            db = db_connect()
            break
        except Exception as e:
            print(f"[OnFire] esperando la base de datos… ({e})")
            time.sleep(2)
    if db is None:
        raise RuntimeError("no se pudo conectar a la base de datos")

    db.executescript(_schema_for_backend())
    # migración suave: agregar columnas nuevas si la base viene de una versión anterior
    if IS_PG:
        for col in ("qr_payload TEXT", "used_at TEXT"):
            db.execute(f"ALTER TABLE tickets ADD COLUMN IF NOT EXISTS {col}")
        for col in ("owner_admin_id INTEGER", "owner_admin_name TEXT",
                    "paid_cents INTEGER NOT NULL DEFAULT 0"):
            db.execute(f"ALTER TABLE sellers ADD COLUMN IF NOT EXISTS {col}")
    else:
        cols = [r["name"] for r in db.execute("PRAGMA table_info(tickets)").fetchall()]
        if "qr_payload" not in cols:
            db.execute("ALTER TABLE tickets ADD COLUMN qr_payload TEXT")
        if "used_at" not in cols:
            db.execute("ALTER TABLE tickets ADD COLUMN used_at TEXT")
        scols = [r["name"] for r in db.execute("PRAGMA table_info(sellers)").fetchall()]
        if "owner_admin_id" not in scols:
            db.execute("ALTER TABLE sellers ADD COLUMN owner_admin_id INTEGER")
        if "owner_admin_name" not in scols:
            db.execute("ALTER TABLE sellers ADD COLUMN owner_admin_name TEXT")
        if "paid_cents" not in scols:
            db.execute("ALTER TABLE sellers ADD COLUMN paid_cents INTEGER NOT NULL DEFAULT 0")
    db.commit()
    for k, v in DEFAULT_SETTINGS.items():
        db.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING", (k, v))
    db.commit()

    # corrección de una sola vez: ningún pago puede exceder lo vendido (datos viejos)
    if setting(db, "paid_capped_v1") != "1":
        sub = ("SELECT COALESCE(SUM(CASE WHEN status!='void' THEN price_cents ELSE 0 END),0) "
               "FROM tickets WHERE seller_id = sellers.id")
        db.execute(f"UPDATE sellers SET paid_cents = ({sub}) WHERE paid_cents > ({sub})")
        set_setting(db, "paid_capped_v1", "1")
        db.commit()

    # Admin inicial: si defines ADMIN_USER + ADMIN_PASSWORD (en Railway → Variables),
    # el admin arranca con TUS credenciales. Si no, usa el admin por defecto solo en local.
    env_user = (os.environ.get("ADMIN_USER") or "").strip()
    env_pass = os.environ.get("ADMIN_PASSWORD") or ""
    use_env = bool(env_user and env_pass)
    init_user = env_user if use_env else "admin"
    init_pass = env_pass if use_env else "onfire2026"

    n_admins = db.execute("SELECT COUNT(*) AS c FROM admins").fetchone()["c"]
    if n_admins == 0:
        # primera vez: crear admin inicial + catálogo + 4 vendedores
        db.execute("INSERT INTO admins(username, pass_hash, created_at) VALUES(?,?,?)",
                   (init_user, hash_password(init_pass), now_iso()))
        for t in [("General", 25000, 0), ("VIP", 50000, 1)]:
            db.execute("INSERT INTO ticket_types(name, price_cents, is_vip) VALUES(?,?,?)", t)
        for f in ["Ingeniería", "Medicina", "Derecho", "Economía", "Arquitectura", "Externo"]:
            db.execute("INSERT INTO faculties(name) VALUES(?)", (f,))
        # RF-25: el sistema inicia con 4 códigos activos, uno por vendedor
        codes = []
        for i in range(1, 5):
            code = None
            while code is None:
                c = f"{secrets.randbelow(10000):04d}"
                if not db.execute("SELECT 1 FROM sellers WHERE code=?", (c,)).fetchone():
                    code = c
            codes.append(code)
            db.execute("INSERT INTO sellers(name, code, created_at) VALUES(?,?,?)",
                       (f"Vendedor {i}", code, now_iso()))
        db.execute("INSERT INTO audit_log(actor, action, detail, created_at) VALUES(?,?,?,?)",
                   ("sistema", "inicializacion",
                    f"Sistema inicializado. Admin inicial: {init_user}", now_iso()))
        db.commit()
        if not use_env:   # solo guardamos la contraseña en archivo cuando es la de por defecto (local)
            try:
                with open(os.path.join(DATA, "CREDENCIALES_INICIALES.txt"), "w") as f:
                    f.write("OnFire — credenciales iniciales\n================================\n\n")
                    f.write(f"Administrador:  usuario: {init_user}   contraseña: {init_pass}\n\n")
                    for i, c in enumerate(codes, 1):
                        f.write(f"Vendedor {i}: código {c}\n")
            except OSError:
                pass
        print(f"[OnFire] Base creada. Admin: '{init_user}'"
              + ("" if use_env else f"/{init_pass}")
              + f" · Códigos vendedor: {', '.join(codes)}")
    elif use_env and not db.execute("SELECT 1 FROM admins WHERE username=?", (env_user,)).fetchone():
        # ya había datos, pero definiste un admin por variables que aún no existía → crearlo
        db.execute("INSERT INTO admins(username, pass_hash, created_at) VALUES(?,?,?)",
                   (env_user, hash_password(env_pass), now_iso()))
        db.commit()
        print(f"[OnFire] Admin '{env_user}' creado desde ADMIN_USER/ADMIN_PASSWORD.")
    db.commit()
    db.close()

# ---------------------------------------------------------------- Excel (sincronización automática)

HEADERS = ["Folio", "Comprador", "Facultad", "Tipo de boleto", "Precio",
           "Vendedor", "Código vendedor", "Fecha de venta", "Estado",
           "Ingresó", "Hora de ingreso", "Anulado por", "Motivo anulación"]

STATUS_ES = {"active": "ACTIVO", "used": "INGRESÓ", "void": "ANULADO"}

def _ticket_row(t):
    return [
        t["folio"], t["buyer_name"], t["faculty_name"], t["type_name"],
        money(t["price_cents"]), t["seller_name"], t["seller_code"],
        t["created_at"], STATUS_ES.get(t["status"], t["status"]),
        "Sí" if t["used_at"] else "No", t["used_at"] or "",
        t["voided_by"] or "", t["void_reason"] or "",
    ]

def build_workbook(rows, summary=None):
    wb = Workbook()
    ws = wb.active
    ws.title = "Boletos"
    header_fill = PatternFill("solid", fgColor="1F1005")
    header_font = Font(bold=True, color="FF8A3D")
    ws.append(HEADERS)
    for c in ws[1]:
        c.fill, c.font = header_fill, header_font
        c.alignment = Alignment(horizontal="center")
    for t in rows:
        ws.append(_ticket_row(t))
    for i, w in enumerate([10, 28, 16, 14, 10, 22, 14, 19, 10, 9, 19, 16, 26], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for row in ws.iter_rows(min_row=2, min_col=5, max_col=5):
        for c in row:
            c.number_format = '"$"#,##0.00'
    ws.freeze_panes = "A2"
    if summary is not None:
        ws2 = wb.create_sheet("Resumen por vendedor")
        ws2.append(["Vendedor", "Admin", "Código", "Boletos válidos", "Boletos anulados",
                    "Monto total", "Pagado", "Estatus"])
        for c in ws2[1]:
            c.fill, c.font = header_fill, header_font
        for s in summary:
            paid = s.get("paid_cents") or 0
            settled = s["total_cents"] > 0 and paid >= s["total_cents"]
            ws2.append([s["name"], s.get("owner_admin_name") or "—", s["code"] or "—",
                        s["count_valid"], s["count_void"], money(s["total_cents"]),
                        money(paid), "COMPLETADO" if settled else "Pendiente"])
        for i, w in enumerate([24, 16, 10, 15, 16, 14, 12, 13], 1):
            ws2.column_dimensions[get_column_letter(i)].width = w
        for row in ws2.iter_rows(min_row=2, min_col=6, max_col=7):
            for c in row:
                c.number_format = '"$"#,##0.00'
    return wb

def seller_summary(db):
    return [dict(r) for r in db.execute("""
        SELECT s.name, s.code, s.owner_admin_name, s.paid_cents,
          COALESCE(SUM(CASE WHEN t.status!='void' THEN 1 ELSE 0 END),0) AS count_valid,
          COALESCE(SUM(CASE WHEN t.status='void' THEN 1 ELSE 0 END),0)  AS count_void,
          COALESCE(SUM(CASE WHEN t.status!='void' THEN t.price_cents ELSE 0 END),0) AS total_cents
        FROM sellers s LEFT JOIN tickets t ON t.seller_id=s.id
        GROUP BY s.id ORDER BY total_cents DESC""").fetchall()]

def sync_excel():
    """Regenera boletos.xlsx con todas las ventas. Se llama tras cada cambio.
    (Es un archivo derivado; la fuente de verdad es la base de datos.)"""
    try:
        db = db_connect()
        rows = db.execute("SELECT * FROM tickets ORDER BY id").fetchall()
        summary = seller_summary(db)
        db.close()
        wb = build_workbook(rows, summary)
        tmp = XLSX + ".tmp"
        wb.save(tmp)
        os.replace(tmp, XLSX)
    except Exception as e:
        print(f"[OnFire] error al sincronizar Excel: {e}")

def sync_excel_async():
    threading.Thread(target=sync_excel, daemon=True).start()

# ---------------------------------------------------------------- respaldos (RG-04)

def backup_loop():
    while True:
        try:
            stamp = now_dt().strftime("%Y%m%d_%H%M")
            if not IS_PG and os.path.exists(DB_PATH):   # con Postgres el respaldo lo gestiona la plataforma
                shutil.copy2(DB_PATH, os.path.join(BACKUPS, f"onfire_{stamp}.db"))
            if os.path.exists(XLSX):
                shutil.copy2(XLSX, os.path.join(BACKUPS, f"boletos_{stamp}.xlsx"))
            keep = sorted(os.listdir(BACKUPS))
            for old in keep[:-40]:
                os.remove(os.path.join(BACKUPS, old))
        except Exception as e:
            print(f"[OnFire] error de respaldo: {e}")
        time.sleep(600)  # cada 10 minutos

# ---------------------------------------------------------------- auth / sesiones

def audit(db, actor, action, detail):
    db.execute("INSERT INTO audit_log(actor, action, detail, created_at) VALUES(?,?,?,?)",
               (actor, action, detail, now_iso()))

def create_session(db, role, user_id):
    minutes = int(setting(db, "admin_session_minutes" if role == "admin" else "session_minutes"))
    token = secrets.token_urlsafe(24)
    exp = (now_dt() + timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
    db.execute("INSERT INTO sessions(token, role, user_id, created_at, expires_at) VALUES(?,?,?,?,?)",
               (token, role, user_id, now_iso(), exp))
    return token

def current_session():
    token = (request.headers.get("Authorization") or "").replace("Bearer ", "").strip()
    if not token:
        return None
    db = get_db()
    s = db.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
    if not s or s["expires_at"] < now_iso():
        return None
    if s["role"] == "seller":
        seller = db.execute("SELECT * FROM sellers WHERE id=?", (s["user_id"],)).fetchone()
        # RF-32 / RF-86: código desactivado o vendedor eliminado → sesión inválida
        if not seller or not seller["active"] or seller["deleted"]:
            db.execute("DELETE FROM sessions WHERE token=?", (token,))
            db.commit()
            return None
        return {"role": "seller", "seller": seller, "token": token}
    admin = db.execute("SELECT * FROM admins WHERE id=?", (s["user_id"],)).fetchone()
    if not admin:
        return None
    return {"role": "admin", "admin": admin, "token": token}

def require_seller():
    s = current_session()
    if not s or s["role"] != "seller":
        return None
    return s

def require_admin():
    s = current_session()
    if not s or s["role"] != "admin":
        return None
    return s

def rate_limited(db, key):
    max_tries = int(setting(db, "max_login_attempts"))
    window = int(setting(db, "lockout_minutes")) * 60
    cutoff = time.time() - window
    db.execute("DELETE FROM login_attempts WHERE ts < ?", (cutoff,))
    n = db.execute("SELECT COUNT(*) c FROM login_attempts WHERE key=? AND ts>=?",
                   (key, cutoff)).fetchone()["c"]
    return n >= max_tries

def record_attempt(db, key):
    db.execute("INSERT INTO login_attempts(key, ts) VALUES(?,?)", (key, time.time()))

def clear_attempts(db, key):
    db.execute("DELETE FROM login_attempts WHERE key=?", (key,))

# ---------------------------------------------------------------- API: acceso

@app.get("/api/event")
def public_event():
    """Solo nombre/subtítulo del evento para las pantallas de acceso (sin datos personales)."""
    db = get_db()
    return jsonify(event_name=setting(db, "event_name"),
                   event_subtitle=setting(db, "event_subtitle"))

@app.post("/api/login-code")
def login_code():
    db = get_db()
    ip = request.remote_addr or "?"
    key = f"code:{ip}"
    if rate_limited(db, key):
        return jsonify(error="Demasiados intentos. Espera unos minutos."), 429
    code = str((request.json or {}).get("code", "")).strip()
    if not re.fullmatch(r"\d{4}", code):
        record_attempt(db, key); db.commit()
        return jsonify(error="Código incorrecto"), 401   # RF-28 mensaje genérico
    seller = db.execute(
        "SELECT * FROM sellers WHERE code=? AND active=1 AND deleted=0", (code,)).fetchone()
    if not seller:
        record_attempt(db, key); db.commit()
        return jsonify(error="Código incorrecto"), 401
    clear_attempts(db, key)
    token = create_session(db, "seller", seller["id"])
    db.commit()
    return jsonify(token=token, name=seller["name"])

@app.post("/api/admin/login")
def admin_login():
    db = get_db()
    ip = request.remote_addr or "?"
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    key = f"admin:{ip}"
    if rate_limited(db, key):
        return jsonify(error="Demasiados intentos. Espera unos minutos."), 429
    admin = db.execute("SELECT * FROM admins WHERE username=?", (username,)).fetchone()
    if not admin or not check_password(str(body.get("password", "")), admin["pass_hash"]):
        record_attempt(db, key); db.commit()
        return jsonify(error="Usuario o contraseña incorrectos"), 401
    clear_attempts(db, key)
    token = create_session(db, "admin", admin["id"])
    db.commit()
    return jsonify(token=token, username=admin["username"])

@app.post("/api/logout")
def logout():
    s = current_session()
    if s:
        db = get_db()
        db.execute("DELETE FROM sessions WHERE token=?", (s["token"],))
        db.commit()
    return jsonify(ok=True)

@app.get("/api/me")
def me():
    s = current_session()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    info = {"event_name": setting(db, "event_name"),
            "event_subtitle": setting(db, "event_subtitle"),
            "event_date_text": setting(db, "event_date_text"),
            "flyer": bool(setting(db, "flyer_file"))}
    if s["role"] == "seller":
        return jsonify(role="seller", name=s["seller"]["name"], **info)
    return jsonify(role="admin", name=s["admin"]["username"],
                   admin_id=s["admin"]["id"], **info)

def owns_seller(admin, seller_row):
    """Un admin es dueño del vendedor si lo creó. Vendedores antiguos sin dueño
    (owner NULL, de versiones previas) pueden gestionarse por cualquier admin."""
    return seller_row["owner_admin_id"] is None or seller_row["owner_admin_id"] == admin["id"]

# ---------------------------------------------------------------- API: vendedor

@app.get("/api/catalog")
def catalog():
    s = current_session()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    types = []
    for r in db.execute("SELECT * FROM ticket_types WHERE active=1 ORDER BY price_cents").fetchall():
        price, phase = effective_price(db, r)
        types.append({"id": r["id"], "name": r["name"], "is_vip": r["is_vip"],
                      "price_cents": price, "phase": phase})
    facs = [dict(r) for r in db.execute(
        "SELECT id, name FROM faculties WHERE active=1 ORDER BY name").fetchall()]
    return jsonify(types=types, faculties=facs,
                   event_name=setting(db, "event_name"),
                   event_subtitle=setting(db, "event_subtitle"),
                   event_date_text=setting(db, "event_date_text"),
                   **flyer_info(db))

def ticket_public(t):
    return {"id": t["id"], "folio": t["folio"], "qr_token": t["qr_token"],
            "qr_payload": t["qr_payload"] or t["qr_token"],   # lo que va dentro del QR
            "buyer_name": t["buyer_name"], "faculty_name": t["faculty_name"],
            "type_name": t["type_name"], "type_is_vip": t["type_is_vip"],
            "price": money(t["price_cents"]), "status": t["status"],
            "created_at": t["created_at"], "used_at": t["used_at"],
            "seller_name": t["seller_name"], "seller_code": t["seller_code"]}

@app.post("/api/tickets")
def create_ticket():
    s = require_seller() or require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    body = request.json or {}
    buyer = str(body.get("buyer_name", "")).strip()
    if len(buyer) < 3:
        return jsonify(error="Escribe el nombre completo del comprador"), 400
    fac = db.execute("SELECT * FROM faculties WHERE id=? AND active=1",
                     (body.get("faculty_id"),)).fetchone()
    if not fac:
        return jsonify(error="Elige una facultad válida"), 400
    tt = db.execute("SELECT * FROM ticket_types WHERE id=? AND active=1",
                    (body.get("type_id"),)).fetchone()
    if not tt:
        return jsonify(error="Elige un tipo de boleto válido"), 400
    price_now, _phase = effective_price(db, tt)   # precio de la fase vigente, congelado en el boleto
    # RF-43: el boleto queda ligado a quien lo genera
    if s["role"] == "seller":
        seller_id, seller_name, seller_code = s["seller"]["id"], s["seller"]["name"], s["seller"]["code"]
    else:
        seller_id, seller_name, seller_code = None, f"Admin: {s['admin']['username']}", "ADMIN"
    prefix = setting(db, "folio_prefix")
    with _write_lock:
        # siguiente número a partir del folio más alto existente (robusto en ambos motores)
        base = db.execute(
            "SELECT COALESCE(MAX(CAST(SUBSTR(folio, ?) AS INTEGER)),0) AS n FROM tickets",
            (len(prefix) + 1,)).fetchone()["n"]
        for attempt in range(20):
            n = base + 1 + attempt
            folio = f"{prefix}{n:04d}"
            token = secrets.token_urlsafe(12)   # RF-46: no adivinable ni secuencial
            qr_payload = token                  # el QR lleva el token secreto
            try:
                cur = db.execute("""INSERT INTO tickets
                    (folio, qr_token, qr_payload, buyer_name, faculty_id, faculty_name,
                     type_id, type_name, type_is_vip, price_cents,
                     seller_id, seller_name, seller_code, status, created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?)""",
                    (folio, token, qr_payload, buyer, fac["id"], fac["name"], tt["id"], tt["name"],
                     tt["is_vip"], price_now, seller_id, seller_name,
                     seller_code, now_iso()))
                db.commit()
                break
            except IntegrityError:
                db.rollback()   # Postgres: liberar la transacción abortada antes de reintentar
                continue
        else:
            return jsonify(error="No se pudo generar el folio, intenta de nuevo"), 500
    t = db.execute("SELECT * FROM tickets WHERE id=?", (cur.lastrowid,)).fetchone()
    audit(db, seller_name, "generacion",
          f"Generó el boleto {t['folio']} para {buyer} ({tt['name']})")
    db.commit()
    sync_excel_async()
    return jsonify(ticket=ticket_public(t))

@app.get("/api/my-tickets")
def my_tickets():
    s = require_seller()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    q = (request.args.get("q") or "").strip()
    sql = "SELECT * FROM tickets WHERE seller_id=?"
    params = [s["seller"]["id"]]
    if q:
        sql += f" AND (buyer_name {LIKE} ? OR folio {LIKE} ?)"
        params += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY id DESC"   # RF-72
    rows = db.execute(sql, params).fetchall()
    count = db.execute(
        "SELECT COUNT(*) c FROM tickets WHERE seller_id=? AND status!='void'",
        (s["seller"]["id"],)).fetchone()["c"]   # RF-55/68: anulados no cuentan
    return jsonify(count=count, tickets=[ticket_public(t) for t in rows])

@app.get("/api/tickets/<int:tid>")
def get_ticket(tid):
    s = current_session()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    t = db.execute("SELECT * FROM tickets WHERE id=?", (tid,)).fetchone()
    if not t:
        return jsonify(error="no existe"), 404
    if s["role"] == "seller" and t["seller_id"] != s["seller"]["id"]:
        return jsonify(error="no existe"), 404   # RF-74: nunca boletos de otro
    return jsonify(ticket=ticket_public(t))

# ---------------------------------------------------------------- API: escaneo en la puerta

@app.post("/api/scan")
def scan():
    """Valida un boleto en tiempo real y lo marca como INGRESÓ en el primer escaneo.
    Cierra el boleto: cualquier copia o falso sale en rojo.
    PÚBLICO: el staff de la puerta no necesita cuenta; se valida con el token del QR
    (imposible de adivinar), así que sin un boleto real no se puede hacer nada."""
    db = get_db()
    ident = folio_from_scan((request.json or {}).get("code", ""))
    if not ident:
        return jsonify(result="no_existe")
    t = db.execute("SELECT * FROM tickets WHERE qr_token=? OR folio=?",
                   (ident, ident.upper())).fetchone()
    if not t:
        return jsonify(result="no_existe")   # QR falso / folio inexistente
    if t["status"] == "void":
        return jsonify(result="anulado", ticket=ticket_public(t))
    if t["status"] == "used":
        return jsonify(result="usado", used_at=t["used_at"], ticket=ticket_public(t))
    # primer escaneo → marcar ingreso (condición de carrera cubierta por WHERE status='active')
    when = now_iso()
    db.execute("UPDATE tickets SET status='used', used_at=? WHERE id=? AND status='active'",
               (when, t["id"]))
    db.commit()
    t2 = db.execute("SELECT * FROM tickets WHERE id=?", (t["id"],)).fetchone()
    if t2["used_at"] != when:   # otro escáner ganó la carrera por milésimas
        return jsonify(result="usado", used_at=t2["used_at"], ticket=ticket_public(t2))
    sync_excel_async()
    return jsonify(result="valido", ticket=ticket_public(t2))

# ---------------------------------------------------------------- API: administrador

@app.get("/api/admin/summary")
def admin_summary():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    tot = db.execute("""SELECT
        SUM(CASE WHEN status!='void' THEN 1 ELSE 0 END) AS n,
        SUM(CASE WHEN status!='void' THEN price_cents ELSE 0 END) AS cents,
        SUM(CASE WHEN status='used' THEN 1 ELSE 0 END) AS entered
        FROM tickets""").fetchone()
    paid = db.execute("SELECT COALESCE(SUM(paid_cents),0) AS c FROM sellers").fetchone()["c"]
    # desglose por admin: cuánto han vendido sus vendedores y cuánto ya cobró (todos lo ven)
    by_admin = db.execute("""
        SELECT COALESCE(s.owner_admin_name, 'Sin asignar') AS admin_name,
               COALESCE(SUM(s.paid_cents),0) AS paid_cents,
               COALESCE(SUM(tk.sold),0) AS sold_cents
        FROM sellers s
        LEFT JOIN (SELECT seller_id, SUM(CASE WHEN status!='void' THEN price_cents ELSE 0 END) AS sold
                   FROM tickets GROUP BY seller_id) tk ON tk.seller_id = s.id
        WHERE s.deleted=0
        GROUP BY COALESCE(s.owner_admin_name, 'Sin asignar')
        ORDER BY sold_cents DESC""").fetchall()
    admins = [{"admin": r["admin_name"], "sold": money(r["sold_cents"]),
               "collected": money(r["paid_cents"]),
               "settled": r["sold_cents"] > 0 and r["paid_cents"] >= r["sold_cents"]}
              for r in by_admin]
    return jsonify(total_tickets=tot["n"] or 0, total=money(tot["cents"] or 0),
                   entered=tot["entered"] or 0, collected=money(paid), by_admin=admins)

def ticket_filters(prefix=""):
    """WHERE dinámico compartido por la tabla admin y la exportación (RF-93).
    prefix: alias de la tabla tickets cuando la consulta usa JOIN (ej. "t.")."""
    a = request.args
    p = prefix
    where, params = [], []
    if a.get("seller_id"):
        where.append(f"{p}seller_id=?"); params.append(a["seller_id"])
    if a.get("faculty"):
        where.append(f"{p}faculty_name=?"); params.append(a["faculty"])
    if a.get("type"):
        where.append(f"{p}type_name=?"); params.append(a["type"])
    if a.get("q"):
        where.append(f"({p}buyer_name {LIKE} ? OR {p}folio {LIKE} ?)")
        params += [f"%{a['q']}%", f"%{a['q']}%"]
    return (" WHERE " + " AND ".join(where) if where else ""), params

@app.get("/api/admin/tickets")
def admin_tickets():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    where, params = ticket_filters("t.")
    rows = db.execute(
        "SELECT t.*, s.owner_admin_id AS owner_admin_id, s.owner_admin_name AS owner_admin_name "
        "FROM tickets t LEFT JOIN sellers s ON s.id = t.seller_id"
        + where + " ORDER BY t.id DESC", params).fetchall()
    out = []
    for t in rows:
        tp = ticket_public(t)
        tp["owner_admin_id"] = t["owner_admin_id"]
        tp["owner_admin_name"] = t["owner_admin_name"]
        out.append(tp)
    return jsonify(tickets=out)

def can_void(admin, db, t):
    """Solo el admin dueño del vendedor puede anular sus boletos. Boletos generados
    directamente por un admin: solo ese mismo admin. Vendedores sin dueño (legado):
    cualquier admin."""
    if t["seller_id"] is not None:
        sel = db.execute("SELECT * FROM sellers WHERE id=?", (t["seller_id"],)).fetchone()
        if sel and sel["owner_admin_id"] is not None and sel["owner_admin_id"] != admin["id"]:
            return False, sel["owner_admin_name"]
        return True, None
    # boleto generado por un admin (seller_name = "Admin: usuario")
    creator = (t["seller_name"] or "").removeprefix("Admin: ")
    if creator and creator != admin["username"]:
        return False, creator
    return True, None

@app.post("/api/admin/tickets/<int:tid>/void")
def void_ticket(tid):
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    reason = str((request.json or {}).get("reason", "")).strip()
    if not reason:
        return jsonify(error="Escribe el motivo de la anulación"), 400
    t = db.execute("SELECT * FROM tickets WHERE id=?", (tid,)).fetchone()
    if not t:
        return jsonify(error="no existe"), 404
    if t["status"] == "void":
        return jsonify(error="Ya estaba anulado"), 400
    ok, owner = can_void(s["admin"], db, t)
    if not ok:
        return jsonify(error=f"Solo {owner} (admin del vendedor) puede anular este boleto"), 403
    db.execute("UPDATE tickets SET status='void', voided_at=?, voided_by=?, void_reason=? WHERE id=?",
               (now_iso(), s["admin"]["username"], reason, tid))
    audit(db, s["admin"]["username"], "anulacion",
          f"Anuló el boleto {t['folio']} de {t['buyer_name']} ({t['type_name']}, "
          f"vendió {t['seller_name']}). Motivo: {reason}")
    db.commit()
    sync_excel_async()
    return jsonify(ok=True)

@app.get("/api/admin/ranking")
def ranking():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    # Solo el orden: ordenado por ventas (sin anulados), desempate para quien llegó
    # primero. No se muestran montos ni premios.
    rows = db.execute("""
        SELECT s.name, s.deleted,
          COALESCE(SUM(CASE WHEN t.status!='void' THEN t.price_cents ELSE 0 END),0) AS cents,
          MAX(CASE WHEN t.status!='void' THEN t.created_at END) AS reached_at
        FROM sellers s LEFT JOIN tickets t ON t.seller_id=s.id
        GROUP BY s.id
        ORDER BY cents DESC, reached_at ASC""").fetchall()
    out = [{"position": i + 1, "name": r["name"], "deleted": bool(r["deleted"])}
           for i, r in enumerate(rows)]
    return jsonify(ranking=out)

# ---- catálogos: tipos de boleto y facultades (RF-80/81)

@app.get("/api/admin/ticket-types")
def list_types():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    out = []
    for r in db.execute("SELECT * FROM ticket_types ORDER BY id").fetchall():
        price, phase = effective_price(db, r)
        phases = [dict(p) for p in db.execute(
            "SELECT * FROM price_phases WHERE type_id=? ORDER BY starts_on, id",
            (r["id"],)).fetchall()]
        out.append({**dict(r), "current_price_cents": price,
                    "current_phase": phase, "phases": phases})
    return jsonify(types=out)

@app.post("/api/admin/ticket-types/<int:tid>/phases")
def create_phase(tid):
    """Nueva fase: nombre, precio y fecha. Al llegar la fecha, el precio cambia solo."""
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    t = db.execute("SELECT * FROM ticket_types WHERE id=?", (tid,)).fetchone()
    if not t:
        return jsonify(error="no existe"), 404
    b = request.json or {}
    name = str(b.get("name", "")).strip()
    date = str(b.get("starts_on", "")).strip()
    try:
        price = int(round(float(b.get("price", 0)) * 100))
    except (TypeError, ValueError):
        price = 0
    if not name or price <= 0 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        return jsonify(error="Fase incompleta: nombre, precio y fecha (AAAA-MM-DD)"), 400
    db.execute("INSERT INTO price_phases(type_id, name, price_cents, starts_on) VALUES(?,?,?,?)",
               (tid, name, price, date))
    audit(db, s["admin"]["username"], "precio",
          f"Creó fase '{name}' de {t['name']}: ${price/100:.2f} desde {date}")
    db.commit()
    return jsonify(ok=True)

@app.delete("/api/admin/phases/<int:pid>")
def delete_phase(pid):
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    p = db.execute("SELECT p.*, t.name AS tname FROM price_phases p "
                   "JOIN ticket_types t ON t.id=p.type_id WHERE p.id=?", (pid,)).fetchone()
    if not p:
        return jsonify(error="no existe"), 404
    db.execute("DELETE FROM price_phases WHERE id=?", (pid,))
    audit(db, s["admin"]["username"], "precio",
          f"Eliminó fase '{p['name']}' de {p['tname']}")
    db.commit()
    return jsonify(ok=True)

@app.post("/api/admin/ticket-types")
def create_type():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    b = request.json or {}
    name = str(b.get("name", "")).strip()
    price = int(round(float(b.get("price", 0)) * 100))
    if not name or price <= 0:
        return jsonify(error="Nombre y precio válidos requeridos"), 400
    db.execute("INSERT INTO ticket_types(name, price_cents, is_vip) VALUES(?,?,?)",
               (name, price, 1 if b.get("is_vip") else 0))
    audit(db, s["admin"]["username"], "precio", f"Creó tipo '{name}' a ${price/100:.2f}")
    db.commit()
    return jsonify(ok=True)

@app.put("/api/admin/ticket-types/<int:tid>")
def edit_type(tid):
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    b = request.json or {}
    t = db.execute("SELECT * FROM ticket_types WHERE id=?", (tid,)).fetchone()
    if not t:
        return jsonify(error="no existe"), 404
    name = str(b.get("name", t["name"])).strip() or t["name"]
    price = int(round(float(b.get("price", t["price_cents"] / 100)) * 100))
    active = 1 if b.get("active", t["active"]) else 0
    is_vip = 1 if b.get("is_vip", t["is_vip"]) else 0
    db.execute("UPDATE ticket_types SET name=?, price_cents=?, active=?, is_vip=? WHERE id=?",
               (name, price, active, is_vip, tid))
    if price != t["price_cents"]:
        # RF-38/90: cambio de precio auditado; boletos previos no cambian (RF-40)
        audit(db, s["admin"]["username"], "precio",
              f"Cambió precio de '{name}': ${t['price_cents']/100:.2f} → ${price/100:.2f}")
    if active != t["active"]:
        audit(db, s["admin"]["username"], "catalogo",
              f"{'Activó' if active else 'Desactivó'} tipo '{name}'")
    db.commit()
    return jsonify(ok=True)

@app.get("/api/admin/faculties")
def list_faculties():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    return jsonify(faculties=[dict(r) for r in
                              db.execute("SELECT * FROM faculties ORDER BY name").fetchall()])

@app.post("/api/admin/faculties")
def create_faculty():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    name = str((request.json or {}).get("name", "")).strip()
    if not name:
        return jsonify(error="Nombre requerido"), 400
    db.execute("INSERT INTO faculties(name) VALUES(?)", (name,))
    audit(db, s["admin"]["username"], "catalogo", f"Creó facultad '{name}'")
    db.commit()
    return jsonify(ok=True)

@app.put("/api/admin/faculties/<int:fid>")
def edit_faculty(fid):
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    b = request.json or {}
    f = db.execute("SELECT * FROM faculties WHERE id=?", (fid,)).fetchone()
    if not f:
        return jsonify(error="no existe"), 404
    name = str(b.get("name", f["name"])).strip() or f["name"]
    active = 1 if b.get("active", f["active"]) else 0
    db.execute("UPDATE faculties SET name=?, active=? WHERE id=?", (name, active, fid))
    audit(db, s["admin"]["username"], "catalogo", f"Editó facultad '{name}'")
    db.commit()
    return jsonify(ok=True)

# ---- gestión de vendedores (RF-82..88)

@app.get("/api/admin/sellers")
def list_sellers():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    rows = db.execute("""
        SELECT s.*, COALESCE(SUM(CASE WHEN t.status!='void' THEN 1 ELSE 0 END),0) AS tickets,
               COUNT(t.id) AS tickets_all,
               COALESCE(SUM(CASE WHEN t.status!='void' THEN t.price_cents ELSE 0 END),0) AS total_cents
        FROM sellers s LEFT JOIN tickets t ON t.seller_id=s.id
        GROUP BY s.id ORDER BY s.deleted, s.id""").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["total"] = money(d.pop("total_cents"))
        d["paid"] = money(d.get("paid_cents") or 0)
        d.pop("paid_cents", None)
        d["settled"] = d["total"] > 0 and d["paid"] >= d["total"]   # Completado
        out.append(d)
    return jsonify(sellers=out)

@app.post("/api/admin/sellers/<int:sid>/paid")
def set_seller_paid(sid):
    """El admin dueño registra cuánto dinero le ha entregado su vendedor."""
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    sel = db.execute("SELECT * FROM sellers WHERE id=? AND deleted=0", (sid,)).fetchone()
    if not sel:
        return jsonify(error="no existe"), 404
    if not owns_seller(s["admin"], sel):
        return jsonify(error=f"Solo {sel['owner_admin_name']} (su admin) puede registrar pagos de este vendedor"), 403
    try:
        paid_cents = int(round(float((request.json or {}).get("paid", 0)) * 100))
    except (TypeError, ValueError):
        return jsonify(error="Monto inválido"), 400
    if paid_cents < 0:
        return jsonify(error="El monto no puede ser negativo"), 400
    total = db.execute("""SELECT COALESCE(SUM(CASE WHEN status!='void' THEN price_cents ELSE 0 END),0) AS c
                          FROM tickets WHERE seller_id=?""", (sid,)).fetchone()["c"]
    # nunca se puede registrar un pago mayor a lo vendido (ni pagos si no ha vendido nada)
    if total <= 0 and paid_cents > 0:
        return jsonify(error="Este vendedor aún no ha vendido nada; no hay pago que registrar"), 400
    if paid_cents > total:
        return jsonify(error=f"El pago no puede superar lo vendido (${total/100:,.2f})"), 400
    db.execute("UPDATE sellers SET paid_cents=? WHERE id=?", (paid_cents, sid))
    estado = "COMPLETADO" if total > 0 and paid_cents >= total else "pendiente"
    audit(db, s["admin"]["username"], "pago",
          f"Registró ${paid_cents/100:,.2f} recibidos de '{sel['name']}' "
          f"(vendido ${total/100:,.2f} → {estado})")
    db.commit()
    return jsonify(ok=True, paid=money(paid_cents), total=money(total),
                   settled=total > 0 and paid_cents >= total)

@app.post("/api/admin/sellers")
def create_seller():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    b = request.json or {}
    name = str(b.get("name", "")).strip()
    if not name:
        return jsonify(error="Nombre requerido"), 400
    code = str(b.get("code", "")).strip()
    if code:
        if not re.fullmatch(r"\d{4}", code):
            return jsonify(error="El código debe ser de 4 dígitos"), 400
        if db.execute("SELECT 1 FROM sellers WHERE code=? AND deleted=0", (code,)).fetchone():
            return jsonify(error="Ese código ya está en uso"), 400   # RF-84
    else:
        code = gen_seller_code(db)
    # el vendedor queda ligado al admin que lo crea (su dueño)
    db.execute("INSERT INTO sellers(name, code, owner_admin_id, owner_admin_name, created_at) "
               "VALUES(?,?,?,?,?)",
               (name, code, s["admin"]["id"], s["admin"]["username"], now_iso()))
    audit(db, s["admin"]["username"], "vendedor_creado",
          f"Creó al vendedor '{name}' (código {code})")
    db.commit()
    return jsonify(ok=True, code=code)

@app.put("/api/admin/sellers/<int:sid>")
def edit_seller(sid):
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    b = request.json or {}
    sel = db.execute("SELECT * FROM sellers WHERE id=? AND deleted=0", (sid,)).fetchone()
    if not sel:
        return jsonify(error="no existe"), 404
    if not owns_seller(s["admin"], sel):
        return jsonify(error=f"Solo {sel['owner_admin_name']} (su admin) puede modificar a este vendedor"), 403
    name = str(b.get("name", sel["name"])).strip() or sel["name"]
    code = str(b.get("code", sel["code"])).strip()
    if code != sel["code"]:
        if not re.fullmatch(r"\d{4}", code):
            return jsonify(error="El código debe ser de 4 dígitos"), 400
        if db.execute("SELECT 1 FROM sellers WHERE code=? AND deleted=0 AND id!=?",
                      (code, sid)).fetchone():
            return jsonify(error="Ese código ya está en uso"), 400
        db.execute("DELETE FROM sessions WHERE role='seller' AND user_id=?", (sid,))
    db.execute("UPDATE sellers SET name=?, code=? WHERE id=?", (name, code, sid))
    audit(db, s["admin"]["username"], "usuarios",
          f"Editó vendedor '{sel['name']}' → nombre '{name}', código {code}")
    db.commit()
    return jsonify(ok=True)

@app.post("/api/admin/sellers/<int:sid>/toggle")
def toggle_seller(sid):
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    sel = db.execute("SELECT * FROM sellers WHERE id=? AND deleted=0", (sid,)).fetchone()
    if not sel:
        return jsonify(error="no existe"), 404
    if not owns_seller(s["admin"], sel):
        return jsonify(error=f"Solo {sel['owner_admin_name']} (su admin) puede modificar a este vendedor"), 403
    new = 0 if sel["active"] else 1
    db.execute("UPDATE sellers SET active=? WHERE id=?", (new, sid))
    if not new:
        # RF-32/86: cerrar sesión de inmediato
        db.execute("DELETE FROM sessions WHERE role='seller' AND user_id=?", (sid,))
    audit(db, s["admin"]["username"], "usuarios",
          f"{'Reactivó' if new else 'Desactivó'} al vendedor '{sel['name']}'")
    db.commit()
    return jsonify(ok=True, active=bool(new))

@app.delete("/api/admin/sellers/<int:sid>")
def delete_seller(sid):
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    sel = db.execute("SELECT * FROM sellers WHERE id=? AND deleted=0", (sid,)).fetchone()
    if not sel:
        return jsonify(error="no existe"), 404
    if not owns_seller(s["admin"], sel):
        return jsonify(error=f"Solo {sel['owner_admin_name']} (su admin) puede eliminar a este vendedor"), 403
    n = db.execute("SELECT COUNT(*) c FROM tickets WHERE seller_id=?", (sid,)).fetchone()["c"]
    # RF-87: se elimina la cuenta, los boletos se conservan con su nombre
    db.execute("UPDATE sellers SET deleted=1, active=0, code=NULL WHERE id=?", (sid,))
    db.execute("DELETE FROM sessions WHERE role='seller' AND user_id=?", (sid,))
    audit(db, s["admin"]["username"], "vendedor_eliminado",
          f"Eliminó al vendedor '{sel['name']}' ({n} boletos quedan asociados a su nombre)")
    db.commit()
    sync_excel_async()
    return jsonify(ok=True, tickets_kept=n)

# ---- administradores (RF-89, RF-35, RF-36)

@app.get("/api/admin/admins")
def list_admins():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    rows = db.execute("SELECT id, username, created_at FROM admins ORDER BY id").fetchall()
    return jsonify(admins=[dict(r) for r in rows], me=s["admin"]["id"])

@app.post("/api/admin/admins")
def create_admin():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    b = request.json or {}
    username = str(b.get("username", "")).strip()
    password = str(b.get("password", ""))
    if len(username) < 3 or len(password) < 8:
        return jsonify(error="Usuario mín. 3 caracteres y contraseña mín. 8"), 400
    if db.execute("SELECT 1 FROM admins WHERE username=?", (username,)).fetchone():
        return jsonify(error="Ese usuario ya existe"), 400
    db.execute("INSERT INTO admins(username, pass_hash, created_at) VALUES(?,?,?)",
               (username, hash_password(password), now_iso()))
    audit(db, s["admin"]["username"], "usuarios", f"Creó administrador '{username}'")
    db.commit()
    return jsonify(ok=True)

@app.delete("/api/admin/admins/<int:aid>")
def delete_admin(aid):
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    if aid == s["admin"]["id"]:
        return jsonify(error="No puedes eliminarte a ti mismo"), 400   # RF-35
    n = db.execute("SELECT COUNT(*) c FROM admins").fetchone()["c"]
    if n <= 1:
        return jsonify(error="No se puede borrar el último administrador"), 400   # RF-36
    target = db.execute("SELECT * FROM admins WHERE id=?", (aid,)).fetchone()
    if not target:
        return jsonify(error="no existe"), 404
    db.execute("DELETE FROM admins WHERE id=?", (aid,))
    db.execute("DELETE FROM sessions WHERE role='admin' AND user_id=?", (aid,))
    audit(db, s["admin"]["username"], "usuarios", f"Eliminó administrador '{target['username']}'")
    db.commit()
    return jsonify(ok=True)

# ---- auditoría, exportación, ajustes

@app.get("/api/admin/audit")
def get_audit():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    rows = db.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT 500").fetchall()
    return jsonify(log=[dict(r) for r in rows])

@app.get("/api/admin/export")
def export_xlsx():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    where, params = ticket_filters()   # RF-93: respeta filtros
    rows = db.execute("SELECT * FROM tickets" + where + " ORDER BY id", params).fetchall()
    wb = build_workbook(rows, seller_summary(db))
    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    fdesc = " con filtros" if where else " completa"
    audit(db, s["admin"]["username"], "exportacion",
          f"Exportó la base de compradores{fdesc} ({len(rows)} boletos)")   # RF-94
    db.commit()
    name = f"boletos_{now_dt().strftime('%Y%m%d_%H%M')}.xlsx"
    return send_file(buf, as_attachment=True, download_name=name,
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

@app.get("/api/admin/settings")
def get_settings():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    out = {k: setting(db, k) for k in ["event_name", "event_subtitle", "event_date_text"]}
    out.update(flyer_info(db))
    return jsonify(out)

def _clamp(v, lo, hi, default):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default

@app.post("/api/admin/settings")
def save_settings():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    b = request.json or {}
    changed = []
    for k in ["event_name", "event_subtitle", "event_date_text"]:
        if k in b:
            set_setting(db, k, str(b[k]).strip())
            changed.append(k)
    # posición/zoom de cada flyer (reposicionar sin volver a subir la imagen)
    for v in ("vip", "gen"):
        if f"flyer_focus_{v}" in b:
            set_setting(db, f"flyer_focus_{v}", _clamp(b[f"flyer_focus_{v}"], 0, 1, 0.5))
            changed.append(f"flyer_focus_{v}")
        if f"flyer_scale_{v}" in b:
            set_setting(db, f"flyer_scale_{v}", _clamp(b[f"flyer_scale_{v}"], 1, 3, 1))
            changed.append(f"flyer_scale_{v}")
    audit(db, s["admin"]["username"], "ajustes", f"Actualizó ajustes: {', '.join(changed)}")
    db.commit()
    return jsonify(ok=True)

@app.post("/api/admin/flyer")
def upload_flyer():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    f = request.files.get("flyer")
    if not f:
        return jsonify(error="Sube una imagen"), 400
    variant = "vip" if request.form.get("variant") == "vip" else "gen"
    ext = os.path.splitext(f.filename or "")[1].lower()
    mimes = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
    if ext not in mimes:
        return jsonify(error="Usa PNG, JPG o WEBP"), 400
    db = get_db()
    # El flyer se guarda EN LA BASE DE DATOS (base64), no en disco → no depende de volúmenes.
    raw = f.read()
    set_setting(db, f"flyer_data_{variant}", base64.b64encode(raw).decode())
    set_setting(db, f"flyer_mime_{variant}", mimes[ext])
    set_setting(db, f"flyer_focus_{variant}", _clamp(request.form.get("flyer_focus"), 0, 1, 0.5))
    set_setting(db, f"flyer_scale_{variant}", _clamp(request.form.get("flyer_scale"), 1, 3, 1))
    audit(db, s["admin"]["username"], "ajustes",
          f"Subió el flyer {'VIP' if variant == 'vip' else 'General'}")
    db.commit()
    return jsonify(ok=True)

@app.get("/flyer")
def serve_flyer():
    """Sirve el flyer del tipo pedido (?v=vip|gen), con respaldo al flyer legado."""
    db = get_db()
    v = "vip" if request.args.get("v") == "vip" else "gen"
    data = setting(db, f"flyer_data_{v}") or setting(db, "flyer_data")
    if not data:
        return "", 404
    mime = setting(db, f"flyer_mime_{v}") or setting(db, "flyer_mime") or "image/png"
    resp = Response(base64.b64decode(data), mimetype=mime)
    resp.headers["Cache-Control"] = "no-cache"
    return resp

# ---------------------------------------------------------------- estáticos

@app.get("/")
def index():
    return send_from_directory(PUBLIC, "index.html")

@app.get("/admin")
def admin_page():
    return send_from_directory(PUBLIC, "admin.html")

@app.get("/scan")
def scan_page():
    return send_from_directory(PUBLIC, "scan.html")

@app.get("/sw.js")
def service_worker():
    # service worker de autodestrucción: limpia el escáner viejo de celulares que lo instalaron
    resp = send_from_directory(PUBLIC, "sw.js", mimetype="application/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    return resp

@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(PUBLIC, path)

# ---------------------------------------------------------------- arranque

init_db()
sync_excel()
threading.Thread(target=backup_loop, daemon=True).start()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8756"))
    print(f"[OnFire] Vendedores:   http://localhost:{port}/")
    print(f"[OnFire] Admin:        http://localhost:{port}/admin")
    print(f"[OnFire] Excel en vivo: {XLSX}")
    app.run(host="0.0.0.0", port=port, threaded=True)
