import type { Pool } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { readCursor, advanceCursor } from "./cursor.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

export const REPORTING_EVENT_TYPES: readonly EventType[] = [
  "transaction.captured",
  "transaction.voided",
  "refund.succeeded",
  "settlement.batch_closed",
  "settlement.paid",
];

/**
 * Keys this worker's row in reporting_outbox_cursor. readCursor row-locks
 * it, so two processes using the same name serialize on that row and a
 * catch-up run beside a live worker cannot apply an event twice.
 */
export const CONSUMER_NAME = "reporting";

/**
 * The one function both the NOTIFY handler and the poll timer call.
 * Everything — the read of due outbox_events, every rollup
 * upsert `applyEvent` performs, and the watermark advance — happens inside
 * one `withTransaction` call: either the whole batch of up-to-
 * `consumerBatchLimit` events is applied *and* the watermark moves past all
 * of them, atomically, or (on any error) nothing in this pass is applied
 * and the watermark is untouched — the next pass simply re-selects the
 * identical event range and retries. This is the exact property that makes
 * the watermark alone sufficient for exactly-once application, with no
 * separate per-event dedup table the way webhook_deliveries needs one.
 *
 * Outbox ids are assigned at INSERT, not COMMIT, so "id > watermark" skips
 * an event whose transaction commits after a higher id was already read.
 * Only rows from transactions older than every running transaction
 * (pg_snapshot_xmin) are read, in (tx_id, id) order (0078): nothing can
 * commit behind the watermark afterwards.
 */
export async function runConsumerPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
): Promise<{ processedCount: number }> {
  const result = await withTransaction(pool, async (client) => {
    const cursor = await readCursor(client, CONSUMER_NAME);

    const eventsResult = await client.query<OutboxEventRow & { tx_id: string }>(
      `SELECT id, event_type, aggregate_id, payload, created_at, tx_id::text AS tx_id
         FROM outbox_events
        WHERE (tx_id, id) > ($1::xid8, $2::bigint)
          AND tx_id < pg_snapshot_xmin(pg_current_snapshot())
          AND event_type = ANY($3::text[])
        ORDER BY tx_id ASC, id ASC
        LIMIT $4`,
      [cursor.lastTxId, cursor.lastProcessedId.toString(), REPORTING_EVENT_TYPES, config.consumerBatchLimit],
    );

    for (const row of eventsResult.rows) {
      await applyEvent(client, row);
    }

    const last = eventsResult.rows[eventsResult.rows.length - 1];
    if (last) {
      await advanceCursor(client, CONSUMER_NAME, BigInt(last.id), last.tx_id);
    }

    return {
      processedCount: eventsResult.rows.length,
      sawRefund: eventsResult.rows.some((r) => r.event_type === "refund.succeeded"),
    };
  });

  // refund_merchant_summary is a materialized view over `refunds`; this
  // worker is its only refresher (0072). Done after the cursor transaction
  // commits so the refresh never holds the cursor row lock.
  if (result.sawRefund) {
    await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY refund_merchant_summary`);
  }
  return { processedCount: result.processedCount };
}
