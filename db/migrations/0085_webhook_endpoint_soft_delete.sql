-- webhook_deliveries.endpoint_id (0022) and webhook_delivery_archives
-- .endpoint_id (0068) are NOT NULL foreign keys with no ON DELETE action, so a
-- hard DELETE of an endpoint that ever received a delivery fails with a
-- foreign-key violation. Deleting is a soft delete instead: the row stays
-- for the delivery history and is hidden from every merchant-facing read.

ALTER TABLE webhook_endpoints ADD COLUMN deleted_at TIMESTAMPTZ;
