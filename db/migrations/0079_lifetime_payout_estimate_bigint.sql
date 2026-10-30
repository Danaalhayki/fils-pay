-- 0040 made the lifetime payout total a float4 (REAL). Its 24-bit mantissa
-- stops registering increments once a merchant passes ~16,777 BD paid out,
-- so the figure ops reads silently freezes. Whole fils in a BIGINT, rebuilt
-- from the paid batches it is meant to total.
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;

UPDATE merchants m
   SET lifetime_net_payout_monitoring_estimate = COALESCE((
         SELECT SUM(b.net_payout_fils)
           FROM settlement_batches b
          WHERE b.merchant_id = m.id AND b.status = 'paid'
       ), 0);
