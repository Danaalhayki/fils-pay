/**
 * Outbox ids are assigned at INSERT, not COMMIT. An event whose transaction
 * commits after a higher id has been consumed must still be applied, and two
 * concurrent passes must not apply the same event twice. Requires
 * DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("commitOrder.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const config = { consumerBatchLimit: 500 };

test.after(async () => {
  await pool.end();
});

async function createMerchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`commitOrder ${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

const INSERT_CAPTURED = `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
  VALUES ('transaction.captured', 'transaction', $1, jsonb_build_object('merchantId', $2::text, 'amountCapturedFils', $3::int))
  RETURNING id`;

async function capturedCount(merchantId: string): Promise<{ count: number; gross: number }> {
  const r = await pool.query<{ c: string; g: string }>(
    `SELECT COALESCE(SUM(captured_count), 0)::text AS c, COALESCE(SUM(captured_gross_fils), 0)::text AS g
       FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  return { count: Number(r.rows[0]!.c), gross: Number(r.rows[0]!.g) };
}

async function drain(): Promise<void> {
  for (;;) {
    const { processedCount } = await runConsumerPass(pool, config);
    if (processedCount === 0) return;
  }
}

test("an event committed after a higher id was consumed is still applied", async () => {
  await drain();
  const merchantId = await createMerchant();

  const slow = await pool.connect();
  try {
    await slow.query("BEGIN");
    const lowId = (await slow.query<{ id: string }>(INSERT_CAPTURED, [randomUUID(), merchantId, 1_000])).rows[0]!.id;
    const highId = (await pool.query<{ id: string }>(INSERT_CAPTURED, [randomUUID(), merchantId, 2_000])).rows[0]!.id;
    assert.ok(BigInt(highId) > BigInt(lowId));

    await drain();
    await slow.query("COMMIT");
  } finally {
    slow.release();
  }

  await drain();
  assert.deepEqual(await capturedCount(merchantId), { count: 2, gross: 3_000 });
});

test("concurrent passes apply each event exactly once", async () => {
  await drain();
  const merchantId = await createMerchant();
  for (let i = 0; i < 20; i++) {
    await pool.query(INSERT_CAPTURED, [randomUUID(), merchantId, 100]);
  }

  await Promise.all(Array.from({ length: 4 }, () => drain()));
  assert.deepEqual(await capturedCount(merchantId), { count: 20, gross: 2_000 });
});
