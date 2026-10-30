-- A payment-link reservation is identified by status = 'reserved' alone, so
-- a pay attempt whose reservation timed out and was re-claimed by a second
-- payer can still heartbeat, release or finalize the second payer's
-- reservation. reservation_id is a fencing token minted on every claim;
-- every later write to the reservation must present it.
ALTER TABLE payment_links ADD COLUMN reservation_id UUID;

-- A pay attempt that captured but lost its reservation is refunded by the
-- platform itself, not by a merchant user or key.
ALTER TABLE refunds DROP CONSTRAINT refunds_created_by_type_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_created_by_type_check
    CHECK (created_by_type IN ('merchant_session', 'merchant_api_key', 'system'));
