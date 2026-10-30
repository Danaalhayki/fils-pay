-- FP-201: acquirer redeliveries reuse the same callback_id. Nothing on our
-- side deduplicated them (the "processed_events" table the postmortem refers
-- to was never merged), so a redelivered callback was applied twice.
-- Keep the earliest row per callback_id, then enforce uniqueness so
-- applyAcquirerCallback's ON CONFLICT (callback_id) DO NOTHING drops repeats.

DELETE FROM acquirer_callback_notes a
 USING acquirer_callback_notes b
 WHERE a.callback_id = b.callback_id
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);
