/**
 * A pay attempt that loses its payment-link reservation to a second payer
 * must neither finalize the other payer's reservation nor keep the money it
 * captured. Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { payPaymentLink } from "./pay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("payReservationFence.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

async function linkForNewMerchant(amountFils: number) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Fence ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const token = `fence-${randomUUID()}`;
  const link = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, $3, now() + interval '1 hour', 'merchant_session', $4) RETURNING id`,
    [merchantId, token, amountFils, randomUUID()],
  );
  return { merchantId, token, linkId: link.rows[0]!.id };
}

/** Wraps the real simulator so `hook` runs just before the given call. */
function acquirerWith(hookOn: "authorize" | "capture", hook: () => Promise<void>): AcquirerSimulator {
  const real = app.acquirer;
  return {
    authorize: async (req) => {
      if (hookOn === "authorize") await hook();
      return real.authorize(req);
    },
    capture: async (req) => {
      if (hookOn === "capture") await hook();
      return real.capture(req);
    },
    refund: (req) => real.refund(req),
  };
}

const stealReservation = (linkId: string) => async () => {
  await pool.query(`UPDATE payment_links SET reservation_id = gen_random_uuid(), reserved_at = now() WHERE id = $1`, [
    linkId,
  ]);
};

test("losing the reservation during capture refunds the payer and leaves the other reservation alone", async () => {
  const { merchantId, token, linkId } = await linkForNewMerchant(4_250);

  const result = await payPaymentLink(
    pool,
    acquirerWith("capture", stealReservation(linkId)),
    { paymentLinkReservationTimeoutSeconds: config.paymentLinkReservationTimeoutSeconds },
    { token, card: APPROVED_CARD, idempotencyKey: randomUUID() },
  );

  assert.equal(result.statusCode, 409, JSON.stringify(result.body));
  const body = result.body as { error: string; refunded: boolean; transactionId: string };
  assert.equal(body.error, "payment_link_reservation_lost");
  assert.equal(body.refunded, true);

  const link = await pool.query<{ status: string; transaction_id: string | null }>(
    `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
    [linkId],
  );
  assert.equal(link.rows[0]!.status, "reserved", "the other payer's reservation must survive");
  assert.equal(link.rows[0]!.transaction_id, null);

  const txn = await pool.query<{ captured_fils: string; refunded_fils: string }>(
    `SELECT captured_fils::text, refunded_fils::text FROM transactions WHERE id = $1 AND merchant_id = $2`,
    [body.transactionId, merchantId],
  );
  assert.equal(txn.rows[0]!.captured_fils, "4250");
  assert.equal(txn.rows[0]!.refunded_fils, "4250");

  const refund = await pool.query<{ created_by_type: string }>(
    `SELECT created_by_type FROM refunds WHERE transaction_id = $1`,
    [body.transactionId],
  );
  assert.equal(refund.rows[0]!.created_by_type, "system");
});

test("losing the reservation before capture voids the authorization and captures nothing", async () => {
  const { merchantId, token, linkId } = await linkForNewMerchant(1_000);

  const result = await payPaymentLink(
    pool,
    acquirerWith("authorize", stealReservation(linkId)),
    { paymentLinkReservationTimeoutSeconds: config.paymentLinkReservationTimeoutSeconds },
    { token, card: APPROVED_CARD, idempotencyKey: randomUUID() },
  );

  assert.equal(result.statusCode, 409, JSON.stringify(result.body));
  const txns = await pool.query<{ status: string; captured_fils: string }>(
    `SELECT status, captured_fils::text FROM transactions WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(txns.rowCount, 1);
  assert.equal(txns.rows[0]!.status, "voided");
  assert.equal(txns.rows[0]!.captured_fils, "0");
});

test("public payment-link responses are never cacheable", async () => {
  const { token } = await linkForNewMerchant(500);
  const read = await app.inject({ method: "GET", url: `/v1/payment-links/${token}` });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.headers["cache-control"], "no-store");

  const missing = await app.inject({ method: "GET", url: `/v1/payment-links/no-such-${randomUUID()}` });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers["cache-control"], "no-store");

  const pay = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: APPROVED_CARD },
  });
  assert.equal(pay.statusCode, 200, pay.body);
  assert.equal(pay.headers["cache-control"], "no-store");
});
