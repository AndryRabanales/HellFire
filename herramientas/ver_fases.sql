-- HELLFIRE · ver el calendario tal como está en la base
-- Solo LEE. No cambia nada. Pegar en Railway → Postgres → Data / Query.

SELECT
    CASE WHEN MAX(p.es_flash) = 1 THEN '⚡ ' || p.name ELSE p.name END      AS fase,
    p.starts_on                                                            AS arranca,
    MAX(CASE WHEN lower(trim(t.name)) = 'uady'      THEN p.price_cents END)/100 AS uady,
    MAX(CASE WHEN lower(trim(t.name)) = 'externo'   THEN p.price_cents END)/100 AS externo,
    MAX(CASE WHEN lower(trim(t.name)) = 'vip'       THEN p.price_cents END)/100 AS vip,
    MAX(CASE WHEN lower(trim(t.name)) = 'ultra vip' THEN p.price_cents END)/100 AS ultra_vip,
    COUNT(*)                                                               AS tipos,
    CASE WHEN p.starts_on <= to_char(now(), 'YYYY-MM-DD') THEN 'sí' ELSE '' END AS ya_arrancó
  FROM price_phases p
  JOIN ticket_types t ON t.id = p.type_id
 GROUP BY p.name, p.starts_on
 ORDER BY p.starts_on;
