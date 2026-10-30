-- adminAudit/log.ts relies on an append-only admin_audit_log that 0034 never
-- enforced: any role with table access could rewrite who did what, or delete
-- the row. The only legitimate UPDATE is markAdminAuditOutcome recording the
-- result of a cross-process action (outcome + metadata). Everything that
-- identifies the action is frozen, and rows cannot be deleted.

CREATE FUNCTION guard_admin_audit_log() RETURNS TRIGGER AS $$
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
        RAISE EXCEPTION 'admin_audit_log is append-only: only outcome and metadata may be updated';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_audit_log_append_only
    BEFORE UPDATE OR DELETE ON admin_audit_log
    FOR EACH ROW EXECUTE FUNCTION guard_admin_audit_log();
