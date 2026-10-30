/**
 * A batch's trend row is written at close with status 'closed'; the payout
 * that follows must flip it to 'paid'. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";
import { REPORTING_EVENT_TYPES } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("settlementPaid.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

test.after(async () => {
  await pool.end();
});

function row(event_type: OutboxEventRow["event_type"], payload: Record<string, unknown>): OutboxEventRow {
  return { id: 1, aggregate_id: randomUUID(), created_at: new Date("2026-01-07T10:00:00Z"), event_type, payload };
}

test("settlement.paid is consumed and marks the payout trend row paid", async () => {
  assert.ok(REPORTING_EVENT_TYPES.includes("settlement.paid"));

  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`settlement.paid trend ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, '2026-01-07', 'closed', 10000, 250, 9750, now()) RETURNING id`,
    [merchantId],
  );
  const batchId = batch.rows[0]!.id;

  await withTransaction(pool, (client) =>
    applyEvent(
      client,
      row("settlement.batch_closed", {
        merchantId,
        batchId,
        batchDate: "2026-01-07",
        grossFils: 10_000,
        feeFils: 250,
        netPayoutFils: 9_750,
      }),
    ),
  );

  await pool.query(`UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1`, [batchId]);
  await withTransaction(pool, (client) =>
    applyEvent(client, row("settlement.paid", { merchantId, batchId, batchDate: "2026-01-07", netPayoutFils: 9_750 })),
  );

  const trend = await pool.query<{ status: string; paid_at: Date | null }>(
    `SELECT status, paid_at FROM merchant_payout_trends WHERE merchant_id = $1 AND settlement_batch_id = $2`,
    [merchantId, batchId],
  );
  assert.equal(trend.rows[0]?.status, "paid");
  assert.ok(trend.rows[0]?.paid_at);
});
