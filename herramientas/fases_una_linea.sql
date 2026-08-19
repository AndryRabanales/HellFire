-- PASO 1 · pegar sola y ejecutar:
DELETE FROM price_phases

-- PASO 2 · pegar TODO esto (es UNA sola sentencia) y ejecutar:
INSERT INTO price_phases (type_id, name, price_cents, starts_on, es_flash)
SELECT t.id, d.fase, d.precio, d.arranca, d.flash FROM (
  SELECT 'Fase 1' AS fase, '2026-09-02' AS arranca, 0 AS flash, 'uady' AS tipo, 15000 AS precio
  UNION ALL SELECT 'Fase 1','2026-09-02',0,'externo',17500
  UNION ALL SELECT 'Fase 1','2026-09-02',0,'vip',35000
  UNION ALL SELECT 'Fase 1','2026-09-02',0,'ultra vip',90000
  UNION ALL SELECT 'Fase 2','2026-09-20',0,'uady',20000
  UNION ALL SELECT 'Fase 2','2026-09-20',0,'externo',22500
  UNION ALL SELECT 'Fase 2','2026-09-20',0,'vip',42500
  UNION ALL SELECT 'Fase 2','2026-09-20',0,'ultra vip',95000
  UNION ALL SELECT 'Fase 3','2026-10-08',0,'uady',27500
  UNION ALL SELECT 'Fase 3','2026-10-08',0,'externo',30000
  UNION ALL SELECT 'Fase 3','2026-10-08',0,'vip',52000
  UNION ALL SELECT 'Fase 3','2026-10-08',0,'ultra vip',100000
  UNION ALL SELECT 'Fase 4','2026-10-26',0,'uady',33000
  UNION ALL SELECT 'Fase 4','2026-10-26',0,'externo',35500
  UNION ALL SELECT 'Fase 4','2026-10-26',0,'vip',57500
  UNION ALL SELECT 'Fase 4','2026-10-26',0,'ultra vip',110000
  UNION ALL SELECT 'Venta Flash','2026-08-18',1,'uady',10000
  UNION ALL SELECT 'Venta Flash','2026-08-18',1,'externo',12500
  UNION ALL SELECT 'Venta Flash','2026-08-18',1,'vip',30000
  UNION ALL SELECT 'Venta Flash','2026-08-18',1,'ultra vip',55000
  UNION ALL SELECT 'Fase 2 Flash','2026-09-08',1,'uady',14000
  UNION ALL SELECT 'Fase 2 Flash','2026-09-08',1,'externo',16500
  UNION ALL SELECT 'Fase 2 Flash','2026-09-08',1,'vip',33000
  UNION ALL SELECT 'Fase 2 Flash','2026-09-08',1,'ultra vip',65000
  UNION ALL SELECT 'Fase 3 Flash','2026-09-26',1,'uady',19000
  UNION ALL SELECT 'Fase 3 Flash','2026-09-26',1,'externo',21500
  UNION ALL SELECT 'Fase 3 Flash','2026-09-26',1,'vip',40000
  UNION ALL SELECT 'Fase 3 Flash','2026-09-26',1,'ultra vip',75000
  UNION ALL SELECT 'Fase 4 Flash','2026-10-14',1,'uady',26000
  UNION ALL SELECT 'Fase 4 Flash','2026-10-14',1,'externo',28500
  UNION ALL SELECT 'Fase 4 Flash','2026-10-14',1,'vip',50000
  UNION ALL SELECT 'Fase 4 Flash','2026-10-14',1,'ultra vip',80000
) d JOIN ticket_types t ON lower(trim(t.name)) = d.tipo

-- PASO 3 · comprobar (8 renglones, 4 con flash = 1):
SELECT name, starts_on, MAX(es_flash) AS flash, COUNT(*) AS tipos FROM price_phases GROUP BY name, starts_on ORDER BY starts_on
