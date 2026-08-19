#!/usr/bin/env python3
"""Carga el calendario de fases y ventas flash en HELLFIRE.

Entra por la MISMA puerta que el panel —la API de admin— y no por la base de
datos. Así pasa por las mismas validaciones, queda escrito en Movimientos, y no
hay forma de dejar la base en un estado que el sistema no sepa leer.

    python3 herramientas/cargar_fases.py

Pide el usuario y la contraseña de admin: se teclean aquí, en tu computadora, y
no se guardan en ningún lado.
"""
import json, sys, getpass, urllib.request, urllib.parse

SITIO = "https://hellfire-production.up.railway.app"

# El orden IMPORTA. La Venta Flash tacha el precio de la siguiente fase normal, así
# que Fase 1 tiene que existir ANTES de encenderla: si no, tacharía los precios de
# la Fase 2 y el boleto anunciaría un ahorro mayor que el real.
CALENDARIO = [
    # (nombre,          arranca,      flash, [UADY, Externo, VIP, Ultra vip])
    #
    # El flash dura el DOBLE que la fase normal que le sigue. Si la gente sabe que
    # viene una promoción, deja de comprar mientras espera: con bloques normales
    # largos, esos días se venden solos... a nadie. Cada pareja es 12 de flash y 6
    # de precio lleno. Y el orden importa: las normales van primero porque el flash
    # tacha el precio de la siguiente fase normal y necesita que ya exista.
    ("Fase 1",         "2026-09-02", False, [150, 175, 350,  900]),
    ("Fase 2",         "2026-09-20", False, [200, 225, 425,  950]),
    ("Fase 3",         "2026-10-08", False, [275, 300, 520, 1000]),
    ("Fase 4",         "2026-10-26", False, [330, 355, 575, 1100]),
    ("Venta Flash",    "2026-08-18", True,  [100, 125, 300,  550]),
    ("Fase 2 Flash",   "2026-09-08", True,  [140, 165, 330,  650]),
    ("Fase 3 Flash",   "2026-09-26", True,  [190, 215, 400,  750]),
    ("Fase 4 Flash",   "2026-10-14", True,  [260, 285, 500,  800]),
]
ORDEN = ["UADY", "Externo", "VIP", "Ultra vip"]

def api(ruta, datos=None, token=None, metodo=None):
    cab = {"Content-Type": "application/json"}
    if token:
        cab["Authorization"] = "Bearer " + token
    pet = urllib.request.Request(
        SITIO + ruta,
        data=json.dumps(datos).encode() if datos is not None else None,
        headers=cab, method=metodo or ("POST" if datos is not None else "GET"))
    try:
        with urllib.request.urlopen(pet, timeout=40) as r:
            cuerpo = r.read()
            return r.status, (json.loads(cuerpo) if cuerpo[:1] in b"{[" else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}

def main():
    print(f"\n  HELLFIRE · cargar calendario de fases\n  {SITIO}\n")
    usuario = input("  Usuario de admin: ").strip()
    clave = getpass.getpass("  Contraseña: ")
    est, r = api("/api/admin/login", {"username": usuario, "password": clave})
    if est != 200 or not r.get("token"):
        print(f"\n  ✗ No entró: {r.get('error', est)}\n")
        return 1
    tok = r["token"]
    print("  ✓ Sesión iniciada\n")

    est, r = api("/api/admin/ticket-types", token=tok)
    # Se compara sin distinguir mayúsculas ni espacios: el tipo puede llamarse "Uady",
    # "UADY" o "uady " según quién lo haya escrito, y exigir una forma exacta hacía
    # fallar el script diciendo que "falta" un tipo que está a la vista en Catálogos.
    tipos = {t["name"].strip().lower(): t["id"] for t in r.get("types", []) if t["active"]}
    faltan = [n for n in ORDEN if n.strip().lower() not in tipos]
    if faltan:
        print(f"  ✗ Faltan tipos de boleto activos: {', '.join(faltan)}")
        print("    Créalos en Catálogos antes de correr esto.\n")
        return 1

    # lo que ya existe, agrupado por (nombre, fecha) igual que en el panel
    existentes = {}
    for t in r.get("types", []):
        for f in t.get("phases", []):
            existentes.setdefault((f["name"], f["starts_on"]), True)

    print("  Fases que hay ahora:")
    if existentes:
        for n, f in sorted(existentes, key=lambda x: x[1]):
            print(f"    · {n}  (desde {f})")
    else:
        print("    (ninguna)")

    print("\n  Se van a BORRAR todas y crear estas 8:\n")
    print(f"    {'FASE':16}{'ARRANCA':12}" + "".join(f"{t:>10}" for t in ORDEN))
    print("    " + "─" * 68)
    for nom, fecha, flash, precios in sorted(CALENDARIO, key=lambda x: x[1]):
        etiqueta = ("⚡ " if flash else "   ") + nom
        print(f"    {etiqueta:16}{fecha:12}" + "".join(f"{p:>10,}" for p in precios))

    print("\n  Los boletos YA vendidos no cambian de precio.")
    if input("\n  Escribe SI para continuar: ").strip().upper() != "SI":
        print("\n  Cancelado. No se tocó nada.\n")
        return 0

    print()
    for nom, fecha in list(existentes):
        est, _ = api(f"/api/admin/phases-all?name={urllib.parse.quote(nom)}"
                     f"&starts_on={urllib.parse.quote(fecha)}", token=tok, metodo="DELETE")
        print(f"  {'✓' if est == 200 else '✗'} borrada  {nom} ({fecha})")

    problemas = []
    for nom, fecha, flash, precios in CALENDARIO:
        est, r = api("/api/admin/phases-all", {
            "name": nom, "starts_on": fecha, "es_flash": flash,
            "prices": {str(tipos[t.strip().lower()]): p for t, p in zip(ORDEN, precios)},
        }, token=tok)
        marca = "⚡" if flash else " "
        if est == 200:
            print(f"  ✓ creada  {marca} {nom} ({fecha})")
            for a in (r.get("avisos") or []):
                problemas.append(f"{nom}: {a}")
        else:
            print(f"  ✗ FALLÓ   {marca} {nom}: {r.get('error', est)}")
            problemas.append(f"{nom}: {r.get('error', est)}")

    est, r = api("/api/catalog", token=tok)
    print("\n  Precios que rigen HOY:")
    for t in r.get("types", []):
        normal = t.get("normal_cents")
        precio = f"${t['price_cents']//100:,}"
        tach = f"  (tachado ${normal//100:,})" if normal else ""
        print(f"    {t['name']:12} {precio:>8}{tach}   fase: {t.get('phase') or '—'}")

    if problemas:
        print("\n  ⚠ Revisa:")
        for p in problemas:
            print(f"    · {p}")
    else:
        print("\n  ✓ Todo quedó cargado sin avisos.")
    print()
    return 0

if __name__ == "__main__":
    sys.exit(main())
