-- The reporting consumer's rollup parity check (applyBatchClosed) counts a
-- merchant's capture events inside one Bahrain day. The only index on
-- transaction_events leads with transaction_id, so the check walked every
-- transaction the merchant ever had and probed each one, on every batch
-- close. This partial index lets it start from the day's capture events.

CREATE INDEX IF NOT EXISTS idx_transaction_events_captures_by_time
    ON transaction_events (occurred_at, transaction_id)
    WHERE event_type IN ('captured', 'partially_captured');
