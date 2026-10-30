/**
 * End-to-end refund coverage through the live routes (FP-212), against a
 * real, migrated Postgres. Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { applyRateFils, subtractFils, toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { processRefund } from "../payments/processRefund.js";
import { buildEnvelope } from "../webhooks/envelope.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refunds.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchantWithKey(label: string, mdrBps = 250, discountBps = 0) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, $2, $3) RETURNING id`,
    [`Refund Route ${label} ${randomUUID()}`, mdrBps, discountBps],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

async function capturedTxn(rawKey: string, amountFils: number): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "refund-route" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

function refund(rawKey: string, body: Record<string, unknown>, key = randomUUID()) {
  return app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": key },
    payload: body,
  });
}

async function feeLedgerNet(txnId: string): Promise<number> {
  const r = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [txnId],
  );
  return Number(r.rows[0]!.net);
}

test("POST /v1/refunds refunds the caller's own transaction end to end", async () => {
  const m = await merchantWithKey("e2e");
  const txnId = await capturedTxn(m.rawKey, 8_000);

  const res = await refund(m.rawKey, { transactionId: txnId, amountFils: 3_000, reason: "customer return" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { transactionStatus: string; refundedTotalFils: number; feeReversedFils: number };
  assert.equal(body.transactionStatus, "partially_refunded");
  assert.equal(body.refundedTotalFils, 3_000);
  assert.equal(body.feeReversedFils, 75);

  const txn = await app.inject({
    method: "GET",
    url: `/v1/transactions/${txnId}`,
    headers: { authorization: `Bearer ${m.rawKey}` },
  });
  assert.equal((txn.json() as { refundedFils: number }).refundedFils, 3_000);

  const outbox = await pool.query<{ payload: Record<string, unknown>; created_at: Date }>(
    `SELECT payload, created_at FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'refund.succeeded'`,
    [txnId],
  );
  assert.equal(outbox.rows.length, 1);
  const envelope = buildEnvelope(randomUUID(), {
    eventType: "refund.succeeded",
    aggregateId: txnId,
    payload: outbox.rows[0]!.payload,
    createdAt: outbox.rows[0]!.created_at,
  });
  assert.equal(envelope.type, "refund.succeeded");
  assert.equal(envelope.data.merchantId, m.merchantId);
  assert.equal(envelope.data.amountFils, 3_000);
  assert.equal(envelope.data.status, "partially_refunded");
});

test("another merchant's transaction is a 404 and is left untouched", async () => {
  const victim = await merchantWithKey("victim");
  const attacker = await merchantWithKey("attacker");
  const txnId = await capturedTxn(victim.rawKey, 5_000);

  const res = await refund(attacker.rawKey, { transactionId: txnId });
  assert.equal(res.statusCode, 404, res.body);

  const row = await pool.query<{ refunded_fils: string; status: string }>(
    `SELECT refunded_fils, status FROM transactions WHERE id = $1`,
    [txnId],
  );
  assert.equal(Number(row.rows[0]!.refunded_fils), 0);
  assert.equal(row.rows[0]!.status, "captured");
});

test("the merchant-scoped dashboard path rejects a foreign merchant id", async () => {
  const m = await merchantWithKey("scope");
  const other = await merchantWithKey("scope-other");
  const txnId = await capturedTxn(m.rawKey, 2_000);

  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${other.merchantId}/refunds`,
    headers: { authorization: `Bearer ${m.rawKey}`, "idempotency-key": randomUUID() },
    payload: { transactionId: txnId },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test("fee reversals across partial refunds sum to exactly the fee charged", async () => {
  // 1.000 BD at 2.75% = 27.5 -> 28 fils (banker's: 27.5 rounds to even 28).
  const m = await merchantWithKey("fee-sum", 275);
  const txnId = await capturedTxn(m.rawKey, 1_000);
  const feeCharged = await feeLedgerNet(txnId);

  let reversed = 0;
  for (const amount of [333, 333, 334]) {
    const res = await refund(m.rawKey, { transactionId: txnId, amountFils: amount });
    assert.equal(res.statusCode, 200, res.body);
    reversed += (res.json() as { feeReversedFils: number }).feeReversedFils;
  }
  assert.equal(reversed, feeCharged, "total reversed must equal the fee charged, never more");
  assert.equal(await feeLedgerNet(txnId), 0, "platform_fee_revenue for the transaction nets to zero");
});

test("capture charges the discounted fee settlement deducts, and a full refund reverses exactly that", async () => {
  const m = await merchantWithKey("discount", 275, 1250);
  const txnId = await capturedTxn(m.rawKey, 10_000);

  const amount = toFils(10_000);
  const expectedFee = Number(applyRateFils(subtractFils(amount, applyRateFils(amount, 1250)), 275));
  assert.equal(await feeLedgerNet(txnId), expectedFee);

  const res = await refund(m.rawKey, { transactionId: txnId });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { feeReversedFils: number }).feeReversedFils, expectedFee);
});

test("two concurrent full refunds with different keys refund the money once", async () => {
  const m = await merchantWithKey("concurrent");
  const txnId = await capturedTxn(m.rawKey, 6_000);
  const actorRow = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1 LIMIT 1`, [
    m.merchantId,
  ]);
  const actor = { type: "merchant_api_key" as const, id: actorRow.rows[0]!.id };

  const results = await Promise.all(
    [0, 1].map(() =>
      processRefund(pool, app.acquirer, {
        transactionId: txnId,
        merchantId: m.merchantId,
        idempotencyKey: randomUUID(),
        actor,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);

  const row = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [
    txnId,
  ]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 6_000);
});

test("a refund with no reason stores 'unspecified' rather than failing the NOT NULL check", async () => {
  const m = await merchantWithKey("reason");
  const txnId = await capturedTxn(m.rawKey, 1_500);
  const res = await refund(m.rawKey, { transactionId: txnId });
  assert.equal(res.statusCode, 200, res.body);
  const r = await pool.query<{ reason: string }>(`SELECT reason FROM refunds WHERE transaction_id = $1`, [txnId]);
  assert.equal(r.rows[0]!.reason, "unspecified");
});
