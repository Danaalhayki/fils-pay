-- Per-merchant refunds pause switch, for support to hold refund issuance on
-- a specific merchant (an active chargeback-rate review, a compliance hold)
-- without touching their ability to take payments and without a deploy.
-- NULL means "no hold in place" — normal operation, the state every
-- merchant starts in and stays in unless support has a reason to flip it.
-- Checked in apps/api/src/refunds/initiateMerchantRefund.ts.
ALTER TABLE merchants
    ADD COLUMN refunds_enabled BOOLEAN;
-- Only an explicit FALSE blocks refunds; NULL and TRUE both allow them.
