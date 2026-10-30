/**
 * Fourth audit pass, admin and auth side. Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { applyAdjustmentImport } from "../admin/adjustmentImport.js";
import { parseAdjustmentCsv } from "../admin/adjustmentCsvParsing.js";
import { createCreditRequest } from "../admin/credits.js";
import { createSavedFilter, MAX_SAVED_FILTERS } from "../reporting/savedFilters.js";
import { bahrainToday } from "../lib/dateParams.js";
import { OTP_FAILURES_PER_WINDOW } from "../auth/otp.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("fourthPassAdmin.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  ACQUIRER_FAILURE_RATE: "0",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
let runBatchCalls = 0;
const app = buildApp(config, pool, {
  admin: {
    settlement: {
      runBatch: async (_cfg, input) => {
        runBatchCalls += 1;
        return { businessDate: input.date, merchantResults: [] };
      },
      rebuildBalances: async () => ({ rebuiltCount: 0, changed: [] }),
    },
  },
});

test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "fourth-pass-password-1!";
let passwordHash: string | null = null;

function cookieFrom(header: string | string[] | undefined, name: string): string {
  for (const h of Array.isArray(header) ? header : [header]) {
    if (h && h.startsWith(`${name}=`)) return h.split(";")[0]!;
  }
  throw new Error(`no ${name} cookie`);
}

async function financeAdminCookie(): Promise<{ id: string; cookie: string }> {
  passwordHash ??= await hashPassword(PASSWORD, config);
  const email = `p4-${randomUUID()}@admin.test`;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'P4 finance', 'finance') RETURNING id`,
    [email, passwordHash],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie: cookieFrom(login.headers["set-cookie"], config.adminCookieName) },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return { id: user.rows[0]!.id, cookie: cookieFrom(verify.headers["set-cookie"], config.adminCookieName) };
}

async function newMerchant(mdrBps = 250, discountBps = 0): Promise<{ merchantId: string; ownerEmail: string }> {
  passwordHash ??= await hashPassword(PASSWORD, config);
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, $2, $3) RETURNING id`,
    [`P4 admin ${randomUUID()}`, mdrBps, discountBps],
  );
  const ownerEmail = `owner-${randomUUID()}@example.test`;
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`,
    [merchant.rows[0]!.id, ownerEmail, passwordHash],
  );
  return { merchantId: merchant.rows[0]!.id, ownerEmail };
}

test("run-batch refuses a business day that has not ended in Bahrain", async () => {
  const admin = await financeAdminCookie();
  const before = runBatchCalls;
  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/settlement/run-batch",
    headers: { cookie: admin.cookie },
    payload: { date: bahrainToday() },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal((res.json() as { error: string }).error, "business_day_not_over");
  assert.equal(runBatchCalls, before, "settlement must not be called");
});

test("OTP guesses are limited per user, not per login: re-logging in does not reset them", async () => {
  const { merchantId, ownerEmail } = await newMerchant();
  let failures = 0;
  let throttled = false;
  for (let login = 0; login < 5 && !throttled; login++) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { merchantId, email: ownerEmail, password: PASSWORD },
    });
    if (res.statusCode === 429) {
      throttled = true;
      break;
    }
    assert.equal(res.statusCode, 200, res.body);
    const cookie = cookieFrom(res.headers["set-cookie"], config.cookieName);
    const real = (res.json() as { devOtpCode: string }).devOtpCode;
    const wrong = real === "000000" ? "000001" : "000000";
    for (let guess = 0; guess < config.otpMaxAttempts; guess++) {
      const verify = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: wrong } });
      if (verify.statusCode === 401) failures += 1;
      else break;
    }
  }
  assert.ok(throttled, "a further login must be refused once the per-user limit is reached");
  assert.ok(failures <= OTP_FAILURES_PER_WINDOW, `at most ${OTP_FAILURES_PER_WINDOW} wrong codes, got ${failures}`);
});

test("a new login retires the previous challenge", async () => {
  const { merchantId, ownerEmail } = await newMerchant();
  const first = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email: ownerEmail, password: PASSWORD } });
  const firstCookie = cookieFrom(first.headers["set-cookie"], config.cookieName);
  const firstCode = (first.json() as { devOtpCode: string }).devOtpCode;
  await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email: ownerEmail, password: PASSWORD } });

  const verify = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie: firstCookie }, payload: { code: firstCode } });
  assert.equal(verify.statusCode, 410, verify.body);
});

test("CSV: a thousands separator, an over-limit total and an unknown merchant are all rejected", async () => {
  const { merchantId } = await newMerchant();
  assert.throws(() => parseAdjustmentCsv(`merchantId,amount,reason\n${merchantId},1,000.00,fix\n`), /more than 3 columns/);
  assert.equal(parseAdjustmentCsv(`\uFEFFmerchantId,amount,reason\n${merchantId},1.000,x\n`).length, 1);

  const admin = await financeAdminCookie();
  await assert.rejects(
    applyAdjustmentImport(pool, {
      adminUserId: admin.id,
      originalFilename: "split.csv",
      rows: [
        { merchantId, amount: "30.000" },
        { merchantId, amount: "-25.000" },
      ],
    }),
    /single-approver limit/,
  );
  await assert.rejects(
    applyAdjustmentImport(pool, {
      adminUserId: admin.id,
      originalFilename: "ghost.csv",
      rows: [{ merchantId: randomUUID(), amount: "1.000" }],
    }),
    /existing merchant/,
  );
  const legs = await pool.query(`SELECT 1 FROM ledger_entries WHERE merchant_id = $1`, [merchantId]);
  assert.equal(legs.rowCount, 0);
});

test("credit fee reversal uses the schedule in force on the effective date and the negotiated discount", async () => {
  const { merchantId } = await newMerchant(250, 1_000);
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, 200, now() - interval '30 days')`,
    [merchantId],
  );
  const admin = await financeAdminCookie();
  const record = await createCreditRequest(pool, {
    merchantId,
    adminUserId: admin.id,
    body: { baseAmountFils: 10_000, reasonCode: "correction", reverseFee: true, effectiveDate: bahrainToday() },
  });
  assert.equal(record.feeReversalFils, 180, "10.000 BD less 10% discount = 9.000 BD @ 200 bps");
});

test("single KYC approval needs documents (under_review)", async () => {
  const admin = await financeAdminCookie();
  const { merchantId } = await newMerchant();
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/kyc-reviews`,
    headers: { cookie: admin.cookie },
    payload: { outcome: "approved" },
  });
  assert.equal(res.statusCode, 409, res.body);
  const row = await pool.query<{ kyc_passed: boolean }>(`SELECT kyc_passed FROM merchants WHERE id = $1`, [merchantId]);
  assert.equal(row.rows[0]!.kyc_passed, false);
});

test("an audit row's outcome is settled once and cannot be rewritten", async () => {
  const admin = await financeAdminCookie();
  const row = await pool.query<{ id: string }>(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_type, metadata, outcome)
     VALUES ($1, 'balance_rebuild', 'platform', '{"a":1}', 'failed') RETURNING id`,
    [admin.id],
  );
  await assert.rejects(pool.query(`UPDATE admin_audit_log SET outcome = 'succeeded' WHERE id = $1`, [row.rows[0]!.id]));

  const pending = await pool.query<{ id: string }>(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_type, metadata, outcome)
     VALUES ($1, 'balance_rebuild', 'platform', '{"a":1}', 'pending') RETURNING id`,
    [admin.id],
  );
  await assert.rejects(pool.query(`UPDATE admin_audit_log SET outcome = 'failed', metadata = '{}' WHERE id = $1`, [pending.rows[0]!.id]));
  await pool.query(`UPDATE admin_audit_log SET outcome = 'failed', metadata = metadata || '{"b":2}' WHERE id = $1`, [pending.rows[0]!.id]);
});

test("saved filters are capped per merchant", async () => {
  const { merchantId } = await newMerchant();
  for (let i = 0; i < MAX_SAVED_FILTERS; i++) {
    await createSavedFilter(pool, { merchantId, name: `f${i}`, filter: {} });
  }
  await assert.rejects(createSavedFilter(pool, { merchantId, name: "one too many", filter: {} }), /at most/);
});

test("admin logout ends the admin's impersonation grants", async () => {
  const admin = await financeAdminCookie();
  const { merchantId } = await newMerchant();
  const start = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/impersonate`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(start.statusCode, 201, start.body);
  const impersonation = cookieFrom(start.headers["set-cookie"], config.impersonationCookieName);
  const during = await app.inject({ method: "GET", url: "/v1/reporting/saved-filters", headers: { cookie: impersonation } });
  assert.equal(during.statusCode, 200, during.body);

  const logout = await app.inject({ method: "POST", url: "/v1/admin/auth/logout", headers: { cookie: admin.cookie } });
  assert.equal(logout.statusCode, 204);

  const after = await app.inject({ method: "GET", url: "/v1/reporting/saved-filters", headers: { cookie: impersonation } });
  assert.equal(after.statusCode, 401, after.body);
});

test("config refuses a misspelt NODE_ENV, the dev DB password in production, and unclear booleans", () => {
  const base = { DATABASE_URL: databaseUrl, WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=" };
  assert.throws(() => loadConfig({ ...base, NODE_ENV: "prod" }), /NODE_ENV/);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: "test", COOKIE_SECURE: "ture" }), /boolean/);
  assert.equal(loadConfig({ ...base, NODE_ENV: "test", COOKIE_SECURE: "TRUE" }).cookieSecure, true);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: "test", WEBHOOK_POLL_INTERVAL_MS: "0" }), /positive/);
  assert.throws(
    () =>
      loadConfig({
        ...base,
        NODE_ENV: "production",
        DATABASE_URL: "postgres://filspay:filspay_dev_password@db:5432/filspay",
        SETTLEMENT_INTERNAL_TOKEN: "real-secret",
        ACQUIRER_CALLBACK_SIGNING_SECRET: "real-secret",
      }),
    /development password/,
  );
});
