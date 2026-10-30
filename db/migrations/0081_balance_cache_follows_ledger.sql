-- merchant_balances had two definitions (ADR-0007, M-24): the incremental
-- path added a batch's net at close and removed it at payout
-- ("closed but unpaid"), while the rebuild summed every merchant_payable
-- leg ("everything owed and not yet paid", unbatched captures included).
-- After a rebuild the next close added that day's net a second time.
--
-- The cache now means the rebuild's figure: SUM(merchant_payable) per
-- merchant. Every merchant_payable leg moves it by exactly its own signed
-- amount, in the inserting transaction, so capture, refund, credit,
-- adjustment, MDR recalculation and payout can no longer drift from the
-- ledger, and a rebuild is a no-op on a healthy cache.

CREATE FUNCTION apply_merchant_payable_leg_to_cache() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.account_id = 'merchant_payable' AND NEW.merchant_id IS NOT NULL THEN
        INSERT INTO merchant_balances (merchant_id, cached_payable_fils, last_settlement_batch_id, updated_at)
        VALUES (
            NEW.merchant_id,
            CASE WHEN NEW.direction = 'credit' THEN NEW.amount_fils ELSE -NEW.amount_fils END,
            NEW.settlement_batch_id,
            now()
        )
        ON CONFLICT (merchant_id) DO UPDATE
           SET cached_payable_fils = merchant_balances.cached_payable_fils + EXCLUDED.cached_payable_fils,
               last_settlement_batch_id = COALESCE(EXCLUDED.last_settlement_batch_id, merchant_balances.last_settlement_batch_id),
               updated_at = now();
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_maintain_balance_cache
    AFTER INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION apply_merchant_payable_leg_to_cache();

-- Start from the ledger figure.
INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
SELECT merchant_id,
       SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END),
       now()
  FROM ledger_entries
 WHERE account_id = 'merchant_payable' AND merchant_id IS NOT NULL
 GROUP BY merchant_id
ON CONFLICT (merchant_id) DO UPDATE
   SET cached_payable_fils = EXCLUDED.cached_payable_fils, updated_at = now();

UPDATE merchant_balances mb
   SET cached_payable_fils = 0, updated_at = now()
 WHERE NOT EXISTS (
         SELECT 1 FROM ledger_entries le
          WHERE le.merchant_id = mb.merchant_id AND le.account_id = 'merchant_payable'
       );
