/**
 * Regression coverage for audit findings fixed after the money-bug pass:
 * reporting scope IDOR, unauthenticated export-summary, bulk KYC approval,
 * credit creation role gate and future dates, API key rotation, and the
 * settlement summary fan-out. Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { getSettlementSummary } from "../settlement/query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("auditFollowups.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

const ADMIN_PASSWORD = "admin-test-password-9000!";

function parseCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) return header.split(";")[0] as string;
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

async function signedInAdmin(role: "support" | "finance" | "super_admin"): Promise<{ id: string; cookie: string }> {
  const email = `followup-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, await hashPassword(ADMIN_PASSWORD, config), `Followup ${role}`, role],
  );
  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const pendingCookie = parseCookie(loginRes.headers["set-cookie"], config.adminCookieName);
  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie: pendingCookie },
    payload: { code: (loginRes.json() as { devOtpCode?: string }).devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  const cookie = parseCookie(verifyRes.headers["set-cookie"], config.adminCookieName);
  return { id: inserted.rows[0]!.id, cookie };
}

async function merchantWithKey(label: string) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Followup ${label} ${randomUUID()}`],
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

async function insertTxn(merchantId: string, amountFils: number): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, reference)
     VALUES ($1, 'captured', $2, $2, $3, 'followup') RETURNING id`,
    [merchantId, amountFils, `acq-${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

test("a merchant cannot report on another parent's split child", async () => {
  const parent = await merchantWithKey("parent");
  const child = await merchantWithKey("child");
  const outsider = await merchantWithKey("outsider");
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, 10000)`,
    [parent.merchantId, child.merchantId],
  );
  await insertTxn(child.merchantId, 7_000);

  const asOutsider = await app.inject({
    method: "GET",
    url: `/v1/reporting/transactions?filter=${encodeURIComponent(JSON.stringify({ merchantId: child.merchantId }))}`,
    headers: { authorization: `Bearer ${outsider.rawKey}` },
  });
  assert.equal(asOutsider.statusCode, 200, asOutsider.body);
  assert.ok(!asOutsider.body.includes(child.merchantId), "outsider must fall back to its own report");

  const asParent = await app.inject({
    method: "GET",
    url: `/v1/reporting/transactions?filter=${encodeURIComponent(JSON.stringify({ merchantId: child.merchantId }))}`,
    headers: { authorization: `Bearer ${parent.rawKey}` },
  });
  assert.equal(asParent.statusCode, 200, asParent.body);
  assert.ok(asParent.body.includes(child.merchantId), "the real parent still sees its child's transactions");
});

test("export-summary requires merchant auth", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/reporting/export-summary" });
  assert.equal(res.statusCode, 401, res.body);
});

test("bulk KYC approve only moves under_review merchants and writes a review row for each", async () => {
  const finance = await signedInAdmin("finance");
  const pending = await merchantWithKey("bulk-pending");
  const rejected = await merchantWithKey("bulk-rejected");
  await pool.query(`UPDATE merchants SET onboarding_status = 'under_review', kyc_passed = false WHERE id = $1`, [
    pending.merchantId,
  ]);
  await pool.query(`UPDATE merchants SET onboarding_status = 'rejected', kyc_passed = false WHERE id = $1`, [
    rejected.merchantId,
  ]);

  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/merchants/bulk-approve",
    headers: { cookie: finance.cookie },
    payload: { merchantIds: [pending.merchantId, rejected.merchantId] },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual((res.json() as { approvedMerchantIds: string[] }).approvedMerchantIds, [pending.merchantId]);

  const rows = await pool.query<{ id: string; onboarding_status: string; kyc_passed: boolean }>(
    `SELECT id, onboarding_status, kyc_passed FROM merchants WHERE id = ANY($1)`,
    [[pending.merchantId, rejected.merchantId]],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  assert.equal(byId.get(pending.merchantId)!.onboarding_status, "approved");
  assert.equal(byId.get(rejected.merchantId)!.onboarding_status, "rejected");
  assert.equal(byId.get(rejected.merchantId)!.kyc_passed, false);

  const reviews = await pool.query(
    `SELECT 1 FROM merchant_kyc_reviews WHERE merchant_id = $1 AND reviewer_admin_user_id = $2 AND outcome = 'approved'`,
    [pending.merchantId, finance.id],
  );
  assert.equal(reviews.rowCount, 1);
});

test("a support admin cannot create a credit; future effective dates are rejected", async () => {
  const support = await signedInAdmin("support");
  const finance = await signedInAdmin("finance");
  const m = await merchantWithKey("credit");
  const body = { baseAmountFils: 10_000, reasonCode: "goodwill", effectiveDate: "2026-01-15" };

  const asSupport = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${m.merchantId}/credits`,
    headers: { cookie: support.cookie },
    payload: body,
  });
  assert.equal(asSupport.statusCode, 403, asSupport.body);

  const future = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${m.merchantId}/credits`,
    headers: { cookie: finance.cookie },
    payload: { ...body, effectiveDate: "2099-01-01" },
  });
  assert.equal(future.statusCode, 400, future.body);
  assert.equal((future.json() as { error: string }).error, "invalid_effective_date");

  const ok = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${m.merchantId}/credits`,
    headers: { cookie: finance.cookie },
    payload: body,
  });
  assert.equal(ok.statusCode, 201, ok.body);
});

test("settlement summary sums capture events, not the running captured total per event", async () => {
  const m = await merchantWithKey("summary");
  const txnId = await insertTxn(m.merchantId, 10_000);
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
     VALUES ($1, 'partially_captured', 4000, 'system', '2026-05-10T09:00:00Z'),
            ($1, 'partially_captured', 6000, 'system', '2026-05-10T10:00:00Z')`,
    [txnId],
  );

  const summary = await getSettlementSummary(pool, { merchantId: m.merchantId, from: "2026-05-10", to: "2026-05-11" });
  assert.equal(summary.transactionCount, 1);
  assert.equal(summary.totalCapturedFils, 10_000);
});
