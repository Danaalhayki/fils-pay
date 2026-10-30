-- Every capture writes ledger legs, and the deferred balance check (0007)
-- sums each leg's entry group at commit. With no index on entry_group_id
-- that is a full scan of ledger_entries per leg, run while the merchant's
-- balance-cache row is locked, so checkout slowed down as the ledger grew
-- and same-merchant payments queued behind the scan.
--
-- capture and void read and update holds by transaction_id, which had no
-- index either: another full scan per payment.

CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_group
    ON ledger_entries (entry_group_id);

CREATE INDEX IF NOT EXISTS idx_holds_transaction
    ON holds (transaction_id);
