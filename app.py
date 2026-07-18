#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OnFire — Plataforma de generación y control de boletos con QR
Backend: Flask + SQLite (archivo local, fácil de migrar a otra BD después).
Todos los datos de venta se sincronizan automáticamente a data/boletos.xlsx.
"""
import os, re, json, time, shutil, sqlite3, secrets, hashlib, threading
from datetime import datetime, timedelta
from io import BytesIO

from flask import Flask, request, jsonify, send_from_directory, send_file, g
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

BASE    = os.path.dirname(os.path.abspath(__file__))
DATA    = os.path.join(BASE, "data")
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

def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

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
    return cents / 100.0

# ------------------------------------------------------- contenido del QR
def build_qr_text(folio, buyer, type_name, faculty):
    """Contenido del QR: TEXTO LEGIBLE. Cualquier lector del celular (Google, cámara)
    lo muestra sin internet; el guardia compara el nombre con la INE.
    Ej.:  Laura Sofía Jiménez Robles
          VIP · Ingeniería
          Folio HF-0427"""
    return f"{buyer}\n{type_name} · {faculty}\nFolio {folio}"

# ---------------------------------------------------------------- base de datos

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
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
  qr_payload TEXT,                 -- QR firmado autocontenido (validación offline)
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
  status TEXT NOT NULL DEFAULT 'active',  -- active | void
  created_at TEXT NOT NULL,
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
    "flyer_file": "",
    "flyer_focus": "0.5",    # posición vertical del flyer en el boleto (0=arriba, 1=abajo)
    "flyer_scale": "1",      # zoom del flyer (1 = ajuste "cover")
    "max_login_attempts": "8",
    "lockout_minutes": "10",
}

def setting(db, key):
    row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else DEFAULT_SETTINGS.get(key, "")

def set_setting(db, key, value):
    db.execute("INSERT INTO settings(key,value) VALUES(?,?) "
               "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))

def effective_price(db, type_row):
    """Precio vigente de un tipo: la fase más reciente cuya fecha ya llegó;
    si no hay fase aplicable, el precio base del tipo."""
    today = datetime.now().strftime("%Y-%m-%d")
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

def init_db():
    fresh = not os.path.exists(DB_PATH)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    # migración suave: agregar qr_payload si la BD viene de una versión anterior
    cols = [r["name"] for r in db.execute("PRAGMA table_info(tickets)").fetchall()]
    if "qr_payload" not in cols:
        db.execute("ALTER TABLE tickets ADD COLUMN qr_payload TEXT")
    for k, v in DEFAULT_SETTINGS.items():
        db.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
    if fresh:
        db.execute("INSERT INTO admins(username, pass_hash, created_at) VALUES(?,?,?)",
                   ("admin", hash_password("onfire2026"), now_iso()))
        for t in [("General", 25000, 0), ("VIP", 50000, 1)]:
            db.execute("INSERT INTO ticket_types(name, price_cents, is_vip) VALUES(?,?,?)", t)
        for f in ["Ingeniería", "Medicina", "Derecho", "Economía", "Arquitectura", "Externo"]:
            db.execute("INSERT INTO faculties(name) VALUES(?)", (f,))
        # RF-25: el sistema inicia con 4 códigos activos, uno por vendedor
        codes = []
        for i in range(1, 5):
            row_factory_db = db
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
                    "Sistema inicializado con admin inicial y 4 vendedores", now_iso()))
        db.commit()
        creds = os.path.join(DATA, "CREDENCIALES_INICIALES.txt")
        with open(creds, "w") as f:
            f.write("OnFire — credenciales iniciales\n")
            f.write("================================\n\n")
            f.write("Administrador:  usuario: admin   contraseña: onfire2026\n")
            f.write("(cámbiala creando otro admin y borrando este, o guárdala bien)\n\n")
            for i, c in enumerate(codes, 1):
                f.write(f"Vendedor {i}: código {c}\n")
        print(f"[OnFire] Base de datos creada. Credenciales en {creds}")
    db.commit()
    db.close()

# ---------------------------------------------------------------- Excel (sincronización automática)

HEADERS = ["Folio", "Comprador", "Facultad", "Tipo de boleto", "Precio",
           "Vendedor", "Código vendedor", "Fecha de venta", "Estado",
           "Anulado por", "Motivo anulación"]

STATUS_ES = {"active": "ACTIVO", "void": "ANULADO"}

def _ticket_row(t):
    return [
        t["folio"], t["buyer_name"], t["faculty_name"], t["type_name"],
        money(t["price_cents"]), t["seller_name"], t["seller_code"],
        t["created_at"], STATUS_ES.get(t["status"], t["status"]),
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
    for i, w in enumerate([10, 28, 16, 14, 10, 22, 14, 19, 10, 16, 26], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for row in ws.iter_rows(min_row=2, min_col=5, max_col=5):
        for c in row:
            c.number_format = '"$"#,##0.00'
    ws.freeze_panes = "A2"
    if summary is not None:
        ws2 = wb.create_sheet("Resumen por vendedor")
        ws2.append(["Vendedor", "Código", "Boletos válidos", "Boletos anulados", "Monto total"])
        for c in ws2[1]:
            c.fill, c.font = header_fill, header_font
        for s in summary:
            ws2.append([s["name"], s["code"] or "—", s["count_valid"],
                        s["count_void"], money(s["total_cents"])])
        for i, w in enumerate([24, 10, 15, 16, 14], 1):
            ws2.column_dimensions[get_column_letter(i)].width = w
        for row in ws2.iter_rows(min_row=2, min_col=5, max_col=5):
            for c in row:
                c.number_format = '"$"#,##0.00'
    return wb

def seller_summary(db):
    return [dict(r) for r in db.execute("""
        SELECT s.name, s.code,
          COALESCE(SUM(CASE WHEN t.status!='void' THEN 1 ELSE 0 END),0) AS count_valid,
          COALESCE(SUM(CASE WHEN t.status='void' THEN 1 ELSE 0 END),0)  AS count_void,
          COALESCE(SUM(CASE WHEN t.status!='void' THEN t.price_cents ELSE 0 END),0) AS total_cents
        FROM sellers s LEFT JOIN tickets t ON t.seller_id=s.id
        GROUP BY s.id ORDER BY total_cents DESC""").fetchall()]

def sync_excel():
    """Regenera data/boletos.xlsx con todas las ventas. Se llama tras cada cambio."""
    try:
        db = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
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
            stamp = datetime.now().strftime("%Y%m%d_%H%M")
            if os.path.exists(DB_PATH):
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
    exp = (datetime.now() + timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
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
    return jsonify(role="admin", name=s["admin"]["username"], **info)

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
                   flyer=bool(setting(db, "flyer_file")),
                   flyer_focus=float(setting(db, "flyer_focus") or 0.5),
                   flyer_scale=float(setting(db, "flyer_scale") or 1))

def ticket_public(t):
    return {"id": t["id"], "folio": t["folio"], "qr_token": t["qr_token"],
            "qr_payload": t["qr_payload"] or t["qr_token"],   # lo que va dentro del QR
            "buyer_name": t["buyer_name"], "faculty_name": t["faculty_name"],
            "type_name": t["type_name"], "type_is_vip": t["type_is_vip"],
            "price": money(t["price_cents"]), "status": t["status"],
            "created_at": t["created_at"],
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
        for _ in range(20):
            n = db.execute("SELECT COALESCE(MAX(id),0)+1 AS n FROM tickets").fetchone()["n"]
            folio = f"{prefix}{n:04d}"
            token = secrets.token_urlsafe(12)   # RF-46: no adivinable ni secuencial
            qr_payload = build_qr_text(folio, buyer, tt["name"], fac["name"])
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
            except sqlite3.IntegrityError:
                continue
        else:
            return jsonify(error="No se pudo generar el folio, intenta de nuevo"), 500
    t = db.execute("SELECT * FROM tickets WHERE id=?", (cur.lastrowid,)).fetchone()
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
        sql += " AND (buyer_name LIKE ? OR folio LIKE ?)"
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

# ---------------------------------------------------------------- API: administrador

@app.get("/api/admin/summary")
def admin_summary():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    tot = db.execute("""SELECT
        SUM(CASE WHEN status!='void' THEN 1 ELSE 0 END) AS n,
        SUM(CASE WHEN status!='void' THEN price_cents ELSE 0 END) AS cents
        FROM tickets""").fetchone()
    return jsonify(total_tickets=tot["n"] or 0, total=money(tot["cents"] or 0))

def ticket_filters():
    """WHERE dinámico compartido por la tabla admin y la exportación (RF-93)."""
    a = request.args
    where, params = [], []
    if a.get("seller_id"):
        where.append("seller_id=?"); params.append(a["seller_id"])
    if a.get("faculty"):
        where.append("faculty_name=?"); params.append(a["faculty"])
    if a.get("type"):
        where.append("type_name=?"); params.append(a["type"])
    if a.get("q"):
        where.append("(buyer_name LIKE ? OR folio LIKE ?)")
        params += [f"%{a['q']}%", f"%{a['q']}%"]
    return (" WHERE " + " AND ".join(where) if where else ""), params

@app.get("/api/admin/tickets")
def admin_tickets():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    where, params = ticket_filters()
    rows = db.execute("SELECT * FROM tickets" + where + " ORDER BY id DESC", params).fetchall()
    return jsonify(tickets=[ticket_public(t) for t in rows])

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
    db.execute("UPDATE tickets SET status='void', voided_at=?, voided_by=?, void_reason=? WHERE id=?",
               (now_iso(), s["admin"]["username"], reason, tid))
    audit(db, s["admin"]["username"], "anulacion",
          f"Anuló {t['folio']} ({t['buyer_name']}, {t['type_name']} ${money(t['price_cents']):.2f}). Motivo: {reason}")
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
               COUNT(t.id) AS tickets_all
        FROM sellers s LEFT JOIN tickets t ON t.seller_id=s.id
        GROUP BY s.id ORDER BY s.deleted, s.id""").fetchall()
    return jsonify(sellers=[dict(r) for r in rows])

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
    db.execute("INSERT INTO sellers(name, code, created_at) VALUES(?,?,?)",
               (name, code, now_iso()))
    audit(db, s["admin"]["username"], "usuarios", f"Creó vendedor '{name}' con código {code}")
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
    n = db.execute("SELECT COUNT(*) c FROM tickets WHERE seller_id=?", (sid,)).fetchone()["c"]
    # RF-87: se elimina la cuenta, los boletos se conservan con su nombre
    db.execute("UPDATE sellers SET deleted=1, active=0, code=NULL WHERE id=?", (sid,))
    db.execute("DELETE FROM sessions WHERE role='seller' AND user_id=?", (sid,))
    audit(db, s["admin"]["username"], "usuarios",
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
    name = f"boletos_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
    return send_file(buf, as_attachment=True, download_name=name,
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

@app.get("/api/admin/settings")
def get_settings():
    s = require_admin()
    if not s:
        return jsonify(error="sin sesión"), 401
    db = get_db()
    keys = ["event_name", "event_subtitle", "event_date_text", "flyer_file",
            "flyer_focus", "flyer_scale"]
    return jsonify({k: setting(db, k) for k in keys})

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
    # posición/zoom del flyer (reposicionar sin volver a subir la imagen)
    if "flyer_focus" in b:
        set_setting(db, "flyer_focus", _clamp(b["flyer_focus"], 0, 1, 0.5)); changed.append("flyer_focus")
    if "flyer_scale" in b:
        set_setting(db, "flyer_scale", _clamp(b["flyer_scale"], 1, 3, 1)); changed.append("flyer_scale")
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
    ext = os.path.splitext(f.filename or "")[1].lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        return jsonify(error="Usa PNG, JPG o WEBP"), 400
    db = get_db()
    old = setting(db, "flyer_file")
    if old:
        try:
            os.remove(os.path.join(DATA, old))
        except OSError:
            pass
    fname = f"flyer{ext}"
    f.save(os.path.join(DATA, fname))
    set_setting(db, "flyer_file", fname)
    # posición/zoom elegidos en la vista previa (vienen como campos del formulario)
    set_setting(db, "flyer_focus", _clamp(request.form.get("flyer_focus"), 0, 1, 0.5))
    set_setting(db, "flyer_scale", _clamp(request.form.get("flyer_scale"), 1, 3, 1))
    audit(db, s["admin"]["username"], "ajustes", "Subió nueva imagen de la fiesta (flyer)")
    db.commit()
    return jsonify(ok=True)

@app.get("/flyer")
def serve_flyer():
    db = get_db()
    fname = setting(db, "flyer_file")
    if not fname or not os.path.exists(os.path.join(DATA, fname)):
        return "", 404
    return send_from_directory(DATA, fname)

# ---------------------------------------------------------------- estáticos

@app.get("/")
def index():
    return send_from_directory(PUBLIC, "index.html")

@app.get("/admin")
def admin_page():
    return send_from_directory(PUBLIC, "admin.html")

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
