-- HELLFIRE · calendario de fases y ventas flash
-- Pegar completo en Railway → Postgres → Console (el cuadro de Data solo corre
-- una sentencia por vez; para ahí usa fases_una_linea.sql).
--
-- Va todo dentro de una transacción: o entran las 8 fases o no entra ninguna.
-- Los tipos se buscan por NOMBRE, no por id. Los boletos ya vendidos NO se tocan.

BEGIN;

DELETE FROM price_phases;

-- Fase 1  ·  desde 2026-09-02  ·  fase normal
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 1', 15000, '2026-09-02', 0
  FROM ticket_types WHERE lower(trim(name)) = 'uady';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 1', 17500, '2026-09-02', 0
  FROM ticket_types WHERE lower(trim(name)) = 'externo';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 1', 35000, '2026-09-02', 0
  FROM ticket_types WHERE lower(trim(name)) = 'vip';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 1', 90000, '2026-09-02', 0
  FROM ticket_types WHERE lower(trim(name)) = 'ultra vip';

-- Fase 2  ·  desde 2026-09-20  ·  fase normal
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 2', 20000, '2026-09-20', 0
  FROM ticket_types WHERE lower(trim(name)) = 'uady';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 2', 22500, '2026-09-20', 0
  FROM ticket_types WHERE lower(trim(name)) = 'externo';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 2', 42500, '2026-09-20', 0
  FROM ticket_types WHERE lower(trim(name)) = 'vip';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 2', 95000, '2026-09-20', 0
  FROM ticket_types WHERE lower(trim(name)) = 'ultra vip';

-- Fase 3  ·  desde 2026-10-08  ·  fase normal
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 3', 27500, '2026-10-08', 0
  FROM ticket_types WHERE lower(trim(name)) = 'uady';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 3', 30000, '2026-10-08', 0
  FROM ticket_types WHERE lower(trim(name)) = 'externo';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 3', 52000, '2026-10-08', 0
  FROM ticket_types WHERE lower(trim(name)) = 'vip';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 3', 100000, '2026-10-08', 0
  FROM ticket_types WHERE lower(trim(name)) = 'ultra vip';

-- Fase 4  ·  desde 2026-10-26  ·  fase normal
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 4', 33000, '2026-10-26', 0
  FROM ticket_types WHERE lower(trim(name)) = 'uady';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 4', 35500, '2026-10-26', 0
  FROM ticket_types WHERE lower(trim(name)) = 'externo';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 4', 57500, '2026-10-26', 0
  FROM ticket_types WHERE lower(trim(name)) = 'vip';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 4', 110000, '2026-10-26', 0
  FROM ticket_types WHERE lower(trim(name)) = 'ultra vip';

-- Venta Flash  ·  desde 2026-08-18  ·  VENTA FLASH
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Venta Flash', 10000, '2026-08-18', 1
  FROM ticket_types WHERE lower(trim(name)) = 'uady';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Venta Flash', 12500, '2026-08-18', 1
  FROM ticket_types WHERE lower(trim(name)) = 'externo';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Venta Flash', 30000, '2026-08-18', 1
  FROM ticket_types WHERE lower(trim(name)) = 'vip';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Venta Flash', 55000, '2026-08-18', 1
  FROM ticket_types WHERE lower(trim(name)) = 'ultra vip';

-- Fase 2 Flash  ·  desde 2026-09-08  ·  VENTA FLASH
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 2 Flash', 14000, '2026-09-08', 1
  FROM ticket_types WHERE lower(trim(name)) = 'uady';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 2 Flash', 16500, '2026-09-08', 1
  FROM ticket_types WHERE lower(trim(name)) = 'externo';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 2 Flash', 33000, '2026-09-08', 1
  FROM ticket_types WHERE lower(trim(name)) = 'vip';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 2 Flash', 65000, '2026-09-08', 1
  FROM ticket_types WHERE lower(trim(name)) = 'ultra vip';

-- Fase 3 Flash  ·  desde 2026-09-26  ·  VENTA FLASH
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 3 Flash', 19000, '2026-09-26', 1
  FROM ticket_types WHERE lower(trim(name)) = 'uady';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 3 Flash', 21500, '2026-09-26', 1
  FROM ticket_types WHERE lower(trim(name)) = 'externo';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 3 Flash', 40000, '2026-09-26', 1
  FROM ticket_types WHERE lower(trim(name)) = 'vip';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 3 Flash', 75000, '2026-09-26', 1
  FROM ticket_types WHERE lower(trim(name)) = 'ultra vip';

-- Fase 4 Flash  ·  desde 2026-10-14  ·  VENTA FLASH
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 4 Flash', 26000, '2026-10-14', 1
  FROM ticket_types WHERE lower(trim(name)) = 'uady';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 4 Flash', 28500, '2026-10-14', 1
  FROM ticket_types WHERE lower(trim(name)) = 'externo';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 4 Flash', 50000, '2026-10-14', 1
  FROM ticket_types WHERE lower(trim(name)) = 'vip';
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT id, 'Fase 4 Flash', 80000, '2026-10-14', 1
  FROM ticket_types WHERE lower(trim(name)) = 'ultra vip';

COMMIT;

-- Comprobación: 8 renglones, 4 con flash = 1
SELECT name AS fase, starts_on AS arranca, MAX(es_flash) AS flash, COUNT(*) AS tipos
  FROM price_phases GROUP BY name, starts_on ORDER BY starts_on;