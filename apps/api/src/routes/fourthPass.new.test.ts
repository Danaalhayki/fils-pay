/**
 * Fourth audit pass, payment side: request amounts, date-only filters,
 * expired holds and payment-link failure clean-up. Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { payPaymentLink } from "../paymentLinks/pay.js";
import { parseBoundParam } from "../lib/dateParams.js";
import type { AcquirerSimulator } from "../acquirer/types.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("fourthPass.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const APPROVED_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const linkConfig = { paymentLinkReservationTimeoutSeconds: config.paymentLinkReservationTimeoutSeconds };

async function newMerchant(label: string) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`P4 ${label} ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

async function linkFor(merchantId: string, amountFils: number, expiresSql = "now() + interval '1 hour'") {
  const token = `p4-${randomUUID()}`;
  const link = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, $3, ${expiresSql}, 'merchant_session', $4) RETURNING id`,
    [merchantId, token, amountFils, randomUUID()],
  );
  return { token, linkId: link.rows[0]!.id };
}

const bearer = (rawKey: string) => ({ authorization: `Bearer ${rawKey}` });

test("authorize, capture and payment-link create reject malformed amounts with 400 invalid_amount", async () => {
  const { merchantId, rawKey } = await newMerchant("amounts");
  for (const amountFils of [0, -5, 1.5, "1000", 100_000_000_000]) {
    const auth = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { ...bearer(rawKey), "idempotency-key": randomUUID() },
      payload: { amountFils, card: APPROVED_CARD },
    });
    assert.equal(auth.statusCode, 400, `authorize ${String(amountFils)}: ${auth.body}`);
    assert.equal((auth.json() as { error: string }).error, "invalid_amount");

    const link = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/payment-links`,
      headers: bearer(rawKey),
      payload: { amountFils, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.equal(link.statusCode, 400, `link ${String(amountFils)}: ${link.body}`);
  }

  const ok = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...bearer(rawKey), "idempotency-key": randomUUID() },
    payload: { amountFils: 2_000, card: APPROVED_CARD },
  });
  assert.equal(ok.statusCode, 201, ok.body);
  const txnId = (ok.json() as { id: string }).id;
  const capture = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txnId}/capture`,
    headers: { ...bearer(rawKey), "idempotency-key": randomUUID() },
    payload: { amountFils: 0 },
  });
  assert.equal(capture.statusCode, 400, capture.body);
});

test("a date-only from/to means Bahrain midnight; a bare local time is rejected", () => {
  assert.equal(parseBoundParam("2026-10-01")?.toISOString(), "2026-09-30T21:00:00.000Z");
  assert.equal(parseBoundParam("2026-10-01T05:00:00Z")?.toISOString(), "2026-10-01T05:00:00.000Z");
  assert.equal(parseBoundParam("2026-02-30"), undefined);
  assert.equal(parseBoundParam("2026-10-01T05:00:00"), undefined, "no offset: ambiguous");
  assert.equal(parseBoundParam("October 1"), undefined);
});

test("capturing an authorization whose hold has expired is refused", async () => {
  const { merchantId } = await newMerchant("hold");
  const auth = await authorizeTransaction(pool, app.acquirer, {
    merchantId,
    amountFils: toFils(3_000),
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
  });
  assert.equal(auth.statusCode, 201, JSON.stringify(auth.body));
  const txnId = (auth.body as { id: string }).id;
  await pool.query(`UPDATE holds SET status = 'expired' WHERE transaction_id = $1`, [txnId]);

  const capture = await captureTransaction(pool, app.acquirer, {
    transactionId: txnId,
    merchantId,
    idempotencyKey: randomUUID(),
    actor: { type: "system", id: merchantId },
  });
  assert.equal(capture.statusCode, 409, JSON.stringify(capture.body));
  const txn = await pool.query<{ captured_fils: string }>(`SELECT captured_fils::text FROM transactions WHERE id = $1`, [
    txnId,
  ]);
  assert.equal(txn.rows[0]!.captured_fils, "0");
});

test("a declined capture voids the authorization and frees the link", async () => {
  const { merchantId } = await newMerchant("decline");
  const { token, linkId } = await linkFor(merchantId, 1_200);
  const declining: AcquirerSimulator = {
    authorize: (req) => app.acquirer.authorize(req),
    capture: async (req) => ({ outcome: "declined", acquirerReference: req.acquirerReference, latencyMs: 0 }),
    refund: (req) => app.acquirer.refund(req),
  };

  const result = await payPaymentLink(pool, declining, linkConfig, {
    token,
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
  });
  assert.equal(result.statusCode, 402, JSON.stringify(result.body));

  const txn = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE merchant_id = $1`, [merchantId]);
  assert.equal(txn.rows[0]!.status, "voided");
  const link = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [linkId]);
  assert.equal(link.rows[0]!.status, "active");
});

test("an exception during pay releases the reservation instead of leaving the link processing", async () => {
  const { merchantId } = await newMerchant("throw");
  const { token, linkId } = await linkFor(merchantId, 800);
  const throwing: AcquirerSimulator = {
    authorize: async () => {
      throw new Error("acquirer connection reset");
    },
    capture: (req) => app.acquirer.capture(req),
    refund: (req) => app.acquirer.refund(req),
  };

  await assert.rejects(
    payPaymentLink(pool, throwing, linkConfig, { token, card: APPROVED_CARD, idempotencyKey: randomUUID() }),
  );
  const link = await pool.query<{ status: string; reservation_id: string | null }>(
    `SELECT status, reservation_id FROM payment_links WHERE id = $1`,
    [linkId],
  );
  assert.equal(link.rows[0]!.status, "active");
  assert.equal(link.rows[0]!.reservation_id, null);
});

test("an expired link with a stale reservation reads as expired and pays 410, not processing", async () => {
  const { merchantId } = await newMerchant("stale");
  const { token, linkId } = await linkFor(merchantId, 500, "now() - interval '1 minute'");
  await pool.query(
    `UPDATE payment_links SET status = 'reserved', reserved_at = now() - interval '1 day', reservation_id = gen_random_uuid()
      WHERE id = $1`,
    [linkId],
  );

  const read = await app.inject({ method: "GET", url: `/v1/payment-links/${token}` });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal((read.json() as { status: string }).status, "expired");

  const pay = await payPaymentLink(pool, app.acquirer, linkConfig, {
    token,
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
  });
  assert.equal(pay.statusCode, 410, JSON.stringify(pay.body));
});
