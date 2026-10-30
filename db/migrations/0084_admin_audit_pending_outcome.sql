-- Cross-process admin actions (settlement run, balance rebuild, MDR
-- recalculation) commit their audit row before the call. It was written as
-- 'succeeded', so a crash during the call left a success on record for an
-- action that may never have happened. Those rows now start as 'pending'.
--
-- 0080 still let outcome and metadata be rewritten at will: a 'failed'
-- action could be relabelled 'succeeded' and its metadata replaced. The only
-- legitimate change is markAdminAuditOutcome settling a pending row once,
-- adding to (never removing from) its metadata.

ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_outcome_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_outcome_check
    CHECK (outcome IN ('pending', 'succeeded', 'failed'));

CREATE OR REPLACE FUNCTION guard_admin_audit_log() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'admin_audit_log is append-only: DELETE is not allowed';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.admin_user_id IS DISTINCT FROM OLD.admin_user_id
       OR NEW.action IS DISTINCT FROM OLD.action
       OR NEW.target_type IS DISTINCT FROM OLD.target_type
       OR NEW.target_id IS DISTINCT FROM OLD.target_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'admin_audit_log is append-only: only a pending outcome may be settled';
    END IF;
    IF OLD.outcome <> 'pending' OR NEW.outcome = 'pending' THEN
        RAISE EXCEPTION 'admin_audit_log is append-only: outcome % cannot change to %', OLD.outcome, NEW.outcome;
    END IF;
    IF NOT (NEW.metadata @> OLD.metadata) THEN
        RAISE EXCEPTION 'admin_audit_log is append-only: metadata may only be added to';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
