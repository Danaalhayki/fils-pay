-- The reporting consumer's watermark was "last outbox id seen", but BIGSERIAL
-- ids are handed out at INSERT, not at COMMIT: capture and CloseBatch insert
-- their outbox row and keep writing before they commit, so id N+1 can become
-- visible before id N. The cursor then moved past N and N was never applied.
--
-- Stamp every row with the writing transaction's id. The consumer only reads
-- rows from transactions older than every transaction still running
-- (pg_snapshot_xmin) and orders by (tx_id, id), so nothing can ever commit
-- behind its watermark.
--
-- Existing rows all take this migration's xid; the cursor is moved to the
-- same xid, so (tx_id, id) > (this_xid, last_processed_id) selects exactly the
-- rows it had not yet processed.

ALTER TABLE outbox_events
    ADD COLUMN tx_id xid8 NOT NULL DEFAULT pg_current_xact_id();

CREATE INDEX idx_outbox_events_tx_id_id ON outbox_events (tx_id, id);

ALTER TABLE reporting_outbox_cursor
    ADD COLUMN last_tx_id xid8 NOT NULL DEFAULT '0';

UPDATE reporting_outbox_cursor SET last_tx_id = pg_current_xact_id();
