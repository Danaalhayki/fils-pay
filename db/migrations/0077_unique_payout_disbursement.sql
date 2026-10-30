-- One payout-rail disbursement per settlement batch (0057's stated intent).
-- The webhook pre-delivery effect wrote one row per endpoint per first
-- attempt (and none for merchants without webhooks), and the daemon/CLI
-- race duplicated settlement.paid events (incident 2026-08-21). PayoutBatch
-- now writes the row in its own transaction. Extra rows are moved aside for
-- finance review, not dropped, before the uniqueness constraint is added.

CREATE TABLE settlement_payout_disbursements_duplicates (
    LIKE settlement_payout_disbursements INCLUDING DEFAULTS,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY settlement_batch_id ORDER BY created_at, id) AS rn
      FROM settlement_payout_disbursements
), moved AS (
    DELETE FROM settlement_payout_disbursements d
     USING ranked r
     WHERE d.id = r.id AND r.rn > 1
 RETURNING d.*
)
INSERT INTO settlement_payout_disbursements_duplicates
    (id, settlement_batch_id, amount_fils, disbursement_reference, created_at)
SELECT id, settlement_batch_id, amount_fils, disbursement_reference, created_at FROM moved;

CREATE UNIQUE INDEX uq_settlement_payout_disbursements_batch
    ON settlement_payout_disbursements (settlement_batch_id);
