/**
 * "Recompute statuses" must only rewrite amount-derived statuses and must
 * never flip a merchant out of test_mode (which would pull sandbox volume
 * into real settlement).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("adminMerchantsRecompute.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

async function signedInFinanceAdmin(): Promise<string> {
  const email = `recompute-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Test finance', 'finance')`,
    [email, await hashPassword(ADMIN_PASSWORD, config)],
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
  return parseCookie(verifyRes.headers["set-cookie"], config.adminCookieName);
}

async function insertTxn(merchantId: string, status: string, amount: number, captured: number, refunded = 0) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [merchantId, status, amount, captured, refunded, `acq-${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

test("recompute keeps test_mode, leaves chargebacks alone, and counts open authorizations", async () => {
  const cookie = await signedInFinanceAdmin();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode) VALUES ($1, 250, 'active', true) RETURNING id`,
    [`Recompute ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;

  const stale = await insertTxn(merchantId, "captured", 10_000, 10_000, 4_000);
  const chargeback = await insertTxn(merchantId, "chargeback", 5_000, 5_000);
  await insertTxn(merchantId, "authorized", 2_000, 0);

  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/transactions/recompute-statuses`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { updated: number; openAuthorizations: number; flagsUpdated: string[] };
  assert.equal(body.updated, 1);
  assert.equal(body.openAuthorizations, 1);
  assert.deepEqual(body.flagsUpdated, []);

  const statuses = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM transactions WHERE id = ANY($1)`,
    [[stale, chargeback]],
  );
  const byId = new Map(statuses.rows.map((r) => [r.id, r.status]));
  assert.equal(byId.get(stale), "partially_refunded");
  assert.equal(byId.get(chargeback), "chargeback");

  const m = await pool.query<{ test_mode: boolean }>(`SELECT test_mode FROM merchants WHERE id = $1`, [merchantId]);
  assert.equal(m.rows[0]!.test_mode, true);
});
