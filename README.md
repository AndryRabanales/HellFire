# OnFire — Plataforma de generación y control de boletos con QR

Sistema para vender boletos de una fiesta: los vendedores generan boletos con QR
desde su celular y el administrador supervisa todo. En la puerta, el control es por
**identificación** (INE). **El cobro del dinero se maneja fuera del sistema.**

El diseño visual (tema *Hellfire*) viene de la carpeta "Sitio de venta de boletos".

## Cómo arrancar

Requiere Python 3.10+ con estas librerías:

```bash
python3 -m pip install --user flask openpyxl
python3 app.py
```

El servidor queda en el puerto **8756**:

| Pantalla | URL | Quién la usa |
|---|---|---|
| Panel de vendedor | `http://<tu-ip>:8756/` | Vendedores (código de 4 dígitos) |
| Administración | `http://<tu-ip>:8756/admin` | Administradores (usuario y contraseña) |

Para que los vendedores entren desde su celular, deben estar en la misma red Wi-Fi
y usar la IP de esta computadora (se ve con `ipconfig getifaddr en0`).

## Control en la puerta: el celular escanea + cotejo con INE

**El sistema NO trae escáner.** En la puerta, el guardia usa **cualquier app de QR del
celular** (Google Lens, la app de cámara, cualquier "QR Scanner") — leer un QR es
offline siempre, no necesita wifi ni instalar nada del sistema.

El **QR del boleto contiene texto legible**:

```
Ángela Muñoz Peña
VIP · Ingeniería
Folio HF-0006
```

Flujo: el guardia escanea → aparece el nombre, tipo y facultad (o "Externo") →
lo compara con la **INE** → si no coincide, se niega el acceso. Esto resuelve la
reventa/transferencia: aunque alguien reenvíe su boleto, el nombre no coincidirá con
la INE de quien lo presente.

> Un QR de texto es legible por cualquiera, así que en teoría alguien podría fabricar
> uno con su propio nombre; la INE no lo detecta porque el nombre sí es suyo. Para el
> control por INE —que es el caso de este evento— el QR legible es suficiente.

## Credenciales iniciales

Al primer arranque se crean el administrador inicial y 4 vendedores con sus códigos.
Todo queda escrito en **`data/CREDENCIALES_INICIALES.txt`**.

- Admin inicial: `admin` / `onfire2026` (créate otro admin con contraseña propia y borra este).
- Los nombres "Vendedor 1..4" se editan en Administración → Vendedores.

## Todo queda en Excel

- **`data/boletos.xlsx`** se actualiza solo con cada venta o anulación:
  folio, comprador, facultad, tipo, precio, vendedor, código del vendedor, fecha,
  estado y, si fue anulado, quién y por qué. Incluye una hoja "Resumen por vendedor".
- Desde Administración → Boletos → **Exportar a Excel** se descarga la base
  respetando los filtros aplicados.

## Datos y respaldos

- **En local (desarrollo):** SQLite en `data/onfire.db`, con respaldo automático
  cada 10 minutos en `data/backups/`.
- **En producción (Railway):** PostgreSQL. La app detecta la variable
  `DATABASE_URL` y usa Postgres automáticamente; sin ella, usa SQLite.
- El **flyer se guarda dentro de la base de datos**, así que no se pierde entre
  despliegues ni necesita discos especiales.

## Despliegue en Railway

1. Conecta este repo de GitHub a un servicio de Railway (deploy automático en cada push).
2. Agrega una base de datos: **+ New → Database → PostgreSQL**.
3. En el servicio de la app → **Variables** → agrega:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (referencia a la base creada)
   - `ADMIN_USER` = tu usuario o correo (ej. `andry@correo.com`)
   - `ADMIN_PASSWORD` = la contraseña que tú elijas
4. Genera el dominio público (Settings → Networking → Generate Domain).

El `Procfile` arranca con gunicorn. En el primer arranque la app crea las tablas,
el **admin inicial con TUS credenciales** (`ADMIN_USER` / `ADMIN_PASSWORD`) y 4
vendedores con códigos nuevos (se ven en los logs y en el panel Admin → Vendedores).

- Si NO defines `ADMIN_USER`/`ADMIN_PASSWORD`, se crea uno por defecto
  `admin` / `onfire2026` (solo conveniente en local; cámbialo en producción).
- `ADMIN_USER` acepta un **correo** como nombre de usuario.
- Puedes agregar esas variables incluso después del primer despliegue: en el
  siguiente reinicio, la app crea ese administrador sin borrar nada.
- Desde el panel (Admin → Admins) puedes crear y eliminar administradores.

## Detalles clave del funcionamiento

- **Precios por fases**: cada tipo de boleto tiene fases con nombre, precio y fecha
  (ej. Preventa $200 desde el 15, Fase 2 $300 desde el 17). Al llegar la fecha, el
  precio cambia solo. El precio queda **congelado** en cada boleto ya generado.
- El folio es fijo con prefijo **HF-**.
- El QR del boleto es **texto legible** (nombre, tipo, facultad, folio) para leerse
  con cualquier app de QR del celular en la puerta. El sistema no incluye escáner.
- Boleto anulado: se conserva en todas las vistas, tachado como ANULADO y sin botón
  de descarga.
- El vendedor solo ve sus boletos y su contador; nunca ve montos de dinero ni el ranking.
- Ranking (solo admin): **solo el orden** de vendedores por ventas, sin montos ni
  premios; los anulados no cuentan y en empate va primero quien llegó antes.
- Todos los permisos se validan en el servidor; desactivar un código cierra su sesión al instante.
- Límite de intentos de acceso fallidos (8 en 10 minutos por IP).

## Estructura

```
app.py            backend completo (Flask + SQLite + sincronización Excel)
requirements.txt  dependencias
public/           frontend: panel de vendedor y de administrador (tema Hellfire)
data/             base de datos, boletos.xlsx en vivo, flyer, respaldos
```
