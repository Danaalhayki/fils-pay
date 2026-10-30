-- FP-212 refunds, settlement and reporting side.
--
-- settlement_batches: a batch nets the merchant's unbatched refunds (and the
-- MDR share each one reversed) against the day's captures, so the frozen
-- figures must carry both or the batch row no longer explains its own
-- net_payout_fils:
--   net_payout_fils = gross_fils - fee_fils - refunded_fils + refund_fee_reversed_fils
ALTER TABLE settlement_batches
    ADD COLUMN refunded_fils            BIGINT NOT NULL DEFAULT 0 CHECK (refunded_fils >= 0),
    ADD COLUMN refund_fee_reversed_fils BIGINT NOT NULL DEFAULT 0 CHECK (refund_fee_reversed_fils >= 0);

-- The reporting consumer's refund rollup writes these; they never existed.
ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

-- Lifetime processed volume in fils passes 2^31-1 (~2,147,483.647 BD), at
-- which point an INTEGER column overflows.
ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;

-- 0072 joined transactions on t.id = r.id (a refund id is never a
-- transaction id, so the view was always empty) and summed captured_fils
-- once per refund, multiplying it for transactions refunded in parts.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
WITH per_txn AS (
    SELECT
        r.merchant_id,
        r.transaction_id,
        date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
        COUNT(*)                 AS refund_count,
        SUM(r.amount_fils)       AS refunded_fils,
        SUM(r.fee_reversed_fils) AS fee_reversed_fils
    FROM refunds r
    WHERE r.status = 'succeeded'
    GROUP BY r.merchant_id, r.transaction_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain')
)
SELECT
    p.merchant_id,
    p.business_date,
    SUM(p.refund_count)::bigint   AS refund_count,
    SUM(p.refunded_fils)          AS total_refunded_fils,
    SUM(p.fee_reversed_fils)      AS total_fee_reversed_fils,
    SUM(t.captured_fils)          AS original_captured_fils
FROM per_txn p
JOIN transactions t ON t.id = p.transaction_id
GROUP BY p.merchant_id, p.business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
