import type { Pool } from "pg";

export type DeleteWebhookEndpointResult = "deleted" | "not_found";

/**
 * `DELETE /v1/merchants/:merchantId/webhook-endpoints/:id` business logic.
 * The statement carries the merchant-scoped predicate, never `id` alone.
 *
 * A soft delete (0085): delivery rows reference the endpoint through NOT NULL
 * foreign keys, so the row is kept for the delivery history, disabled so the
 * dispatcher never sends to it again, and hidden from every merchant read.
 */
export async function deleteWebhookEndpoint(
  pool: Pool,
  input: { merchantId: string; id: string },
): Promise<DeleteWebhookEndpointResult> {
  const result = await pool.query<{ id: string }>(
    `UPDATE webhook_endpoints
        SET status = 'disabled', deleted_at = now(), updated_at = now()
      WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [input.id, input.merchantId],
  );
  return result.rows[0] ? "deleted" : "not_found";
}
