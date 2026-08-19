-- HELLFIRE · foto completa del sistema. Solo LEE, no cambia nada.

-- 1) Tipos de boleto y su precio base
SELECT name AS tipo, price_cents/100 AS precio_base,
       CASE WHEN is_vip = 1 THEN 'sí' ELSE '' END AS categoria_alta,
       CASE WHEN active = 1 THEN 'sí' ELSE 'NO' END AS a_la_venta
  FROM ticket_types ORDER BY id;

-- 2) El dinero
SELECT COUNT(*) FILTER (WHERE status <> 'void' AND es_cortesia = 0)          AS boletos_vendidos,
       COALESCE(SUM(price_cents) FILTER (WHERE status <> 'void' AND es_cortesia = 0),0)/100 AS pesos_vendidos,
       COUNT(*) FILTER (WHERE status = 'used')                               AS ya_entraron,
       COUNT(*) FILTER (WHERE status = 'void')                               AS anulados,
       COUNT(*) FILTER (WHERE es_cortesia = 1 AND status <> 'void')          AS cortesias
  FROM tickets;

-- 3) Vendedores: qué vendió y qué debe cada uno
SELECT s.name AS vendedor, s.code AS codigo,
       COUNT(t.id) FILTER (WHERE t.status <> 'void')                          AS boletos,
       COALESCE(SUM(t.price_cents) FILTER (WHERE t.status <> 'void'),0)/100    AS vendio,
       s.paid_cents/100                                                        AS ya_pago,
       (COALESCE(SUM(t.price_cents) FILTER (WHERE t.status <> 'void'),0) - s.paid_cents)/100 AS debe,
       COALESCE(s.commission_pct, -1)                                          AS comision_propia
  FROM sellers s
  LEFT JOIN tickets t ON t.seller_id = s.id
 WHERE s.hidden = 0 AND s.deleted = 0
 GROUP BY s.id, s.name, s.code, s.paid_cents, s.commission_pct
 ORDER BY vendio DESC;

-- 4) Gastos
SELECT name AS gasto, amount_cents/100 AS monto, paid_cents/100 AS abonado,
       (amount_cents - paid_cents)/100 AS falta, account AS cuenta
  FROM expenses ORDER BY id;
