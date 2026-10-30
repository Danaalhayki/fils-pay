-- 0007 claims its balance trigger makes ledger legs immutable, but it only
-- checks that a group still nets to zero: deleting a whole group, or
-- editing both legs symmetrically (amount, account, merchant), commits fine.
-- Corrections must be new, offsetting entries, so reject UPDATE/DELETE
-- outright. (TRUNCATE, used only by the dev seed, does not fire row triggers.)

CREATE FUNCTION reject_ledger_entry_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_entry_mutation();
