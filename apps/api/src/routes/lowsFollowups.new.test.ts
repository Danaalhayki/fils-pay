/**
 * Regression coverage for the Low-severity batch: client errors that used
 * to surface as 500, suspended merchants still transacting, CSV formula
 * injection, report truncation, and strict date parsing. Requires
 * `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { updateBusinessProfile } from "../onboarding/businessProfile.js";
import { csvEscape } from "../transactions/exportCsv.js";
import { isValidDateString } from "../lib/dateParams.js";
import { inlineContentDisposition } from "./kyc.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("lowsFollowups.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  OTP_DEV_EXPOSE: "true",
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

async function merchantWithKey(label: string) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Lows ${label} ${randomUUID()}`],
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

const bearer = (rawKey: string) => ({ authorization: `Bearer ${rawKey}` });

test("a suspended merchant's API key stops working and its payment links cannot be paid", async () => {
  const { merchantId, rawKey } = await merchantWithKey("suspended");
  const linkRes = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: bearer(rawKey),
    payload: { amountFils: 1_500, reference: "s-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(linkRes.statusCode, 201, linkRes.body);
  const token = (linkRes.json() as { token: string }).token;

  await pool.query(`UPDATE merchants SET status = 'suspended' WHERE id = $1`, [merchantId]);

  const list = await app.inject({ method: "GET", url: "/v1/transactions", headers: bearer(rawKey) });
  assert.equal(list.statusCode, 401, list.body);

  const pay = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: APPROVED_CARD },
  });
  assert.notEqual(pay.statusCode, 200, "a suspended merchant must not take a payment");
  const captured = await pool.query(`SELECT 1 FROM transactions WHERE merchant_id = $1 AND captured_fils > 0`, [merchantId]);
  assert.equal(captured.rowCount, 0);
});

test("transaction list/export reject unparseable dates with 400, not 500", async () => {
  const { rawKey } = await merchantWithKey("dates");
  for (const url of ["/v1/transactions?from=not-a-date", "/v1/transactions/export?to=2026-99-99"]) {
    const res = await app.inject({ method: "GET", url, headers: bearer(rawKey) });
    assert.equal(res.statusCode, 400, `${url}: ${res.body}`);
  }
});

test("a malformed id in the path is a 400, not a 500", async () => {
  const { rawKey } = await merchantWithKey("bad-id");
  const res = await app.inject({ method: "GET", url: "/v1/transactions/not-a-uuid", headers: bearer(rawKey) });
  assert.equal(res.statusCode, 400, res.body);
});

test("malformed JSON from the client is a 4xx, not a 500", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { "content-type": "application/json" },
    payload: "{not json",
  });
  assert.equal(res.statusCode, 400, res.body);
});

test("reporting filter: null / non-object / bad dates are 400; truncation is signalled", async () => {
  const { merchantId, rawKey } = await merchantWithKey("report");
  for (const filter of ["null", "5", '["x"]', '{"from":"2026-02-30"}', '{"to":"yesterday"}', '{"status":7}']) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/reporting/transactions?filter=${encodeURIComponent(filter)}`,
      headers: bearer(rawKey),
    });
    assert.equal(res.statusCode, 400, `${filter}: ${res.body}`);
  }

  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, reference)
     SELECT $1, 'captured', 1000, 1000, 'acq-' || gen_random_uuid(), 'bulk' FROM generate_series(1, 501)`,
    [merchantId],
  );
  const res = await app.inject({ method: "GET", url: "/v1/reporting/transactions", headers: bearer(rawKey) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as unknown[]).length, 500);
  assert.equal(res.headers["x-report-truncated"], "true");
});

test("a Bahrain-date report window starts at Bahrain midnight", async () => {
  const { merchantId, rawKey } = await merchantWithKey("report-window");
  // 22:30 UTC on 9 June is 01:30 Bahrain on 10 June.
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, reference, occurred_at)
     VALUES ($1, 'captured', 1000, 1000, $2, 'late-night', '2026-06-09T22:30:00Z')`,
    [merchantId, `acq-${randomUUID()}`],
  );
  const res = await app.inject({
    method: "GET",
    url: `/v1/reporting/transactions?filter=${encodeURIComponent('{"from":"2026-06-10","to":"2026-06-11"}')}`,
    headers: bearer(rawKey),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as Array<{ reference: string }>)[0]?.reference, "late-night");
});

test("business-profile patch rejects unknown fields and bad values instead of a SQL error", async () => {
  const merchantId = randomUUID();
  for (const patch of [{ nope: "x" }, { legalName: null }, { businessType: "pirate" }, { city: 42 }]) {
    await assert.rejects(
      updateBusinessProfile(pool, merchantId, patch as never),
      (err: { statusCode?: number }) => err.statusCode === 400,
      JSON.stringify(patch),
    );
  }
});

test("CSV cells that start like a formula are neutralised", () => {
  assert.equal(csvEscape("=HYPERLINK(\"http://x\")"), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvEscape("+1"), "'+1");
  assert.equal(csvEscape("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvEscape("order-1"), "order-1");
});

test("strict YYYY-MM-DD rejects impossible calendar dates", () => {
  assert.equal(isValidDateString("2026-02-28"), true);
  assert.equal(isValidDateString("2026-02-30"), false);
  assert.equal(isValidDateString("2026-13-01"), false);
  assert.equal(isValidDateString("2026-1-01"), false);
});

test("KYC download header survives quotes, newlines and non-ASCII names", () => {
  const header = inlineContentDisposition('a"b\r\nSet-Cookie: x=1 وثيقة.pdf');
  assert.ok(!/[\r\n]/.test(header));
  assert.match(header, /^inline; filename="a_b__Set-Cookie: x=1 _____\.pdf"; filename\*=UTF-8''/);
});
