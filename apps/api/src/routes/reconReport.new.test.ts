/**
 * Fourth pass: reconciliation after an MDR recalculation, batch refund
 * figures, and the dashboard's /me under "view as merchant". Requires
 * `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../auth/passwords.js";
import { getReconciliationReport, getSettlementBatch } from "../settlement/query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("reconReport.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

function cookieFrom(header: string | string[] | undefined, name: string): string {
  for (const h of Array.isArray(header) ? header : [header]) {
    if (h && h.startsWith(`${name}=`)) return h.split(";")[0]!;
  }
  throw new Error(`no ${name} cookie`);
}

async function newMerchant(): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Recon report ${randomUUID()}`],
  );
  return merchant.rows[0]!.id;
}

test("an MDR recalculation posted after the period still reconciles that period to zero", async () => {
  const merchantId = await newMerchant();
  const capturedAt = "2026-03-20T12:00:00+03:00";
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'card_scheme_clearing', 'debit',  10000, $3, 'capture: gross'),
            ($1, $2, 'merchant_payable',     'credit', 10000, $3, 'capture: gross'),
            ($4, $2, 'merchant_payable',     'debit',    250, $3, 'capture: MDR fee'),
            ($4, $2, 'platform_fee_revenue', 'credit',   250, $3, 'capture: MDR fee')`,
    [randomUUID(), merchantId, capturedAt, randomUUID()],
  );
  // Recalculated from 250 to 300 bps: the batch's fee and net moved, and the
  // 50 fils difference was journaled today against the batch.
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, '2026-03-20', 'closed', 10000, 300, 9700, $2) RETURNING id`,
    [merchantId, "2026-03-21T00:15:00+03:00"],
  );
  await pool.query(
    `INSERT INTO ledger_entries
       (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, $3, 'merchant_payable',     'debit',  50, now(), 'MDR recalculation adjustment'),
            ($1, $2, $3, 'platform_fee_revenue', 'credit', 50, now(), 'MDR recalculation adjustment')`,
    [randomUUID(), merchantId, batch.rows[0]!.id],
  );

  const report = await getReconciliationReport(pool, { merchantId, from: "2026-03-20", to: "2026-03-21" });
  assert.equal(report.ledgerMerchantPayableNetFils, 9700);
  assert.equal(report.settlementNetPayoutFils, 9700);
  assert.equal(report.gapFils, 0);
  assert.equal(report.explained, true);
});

test("the batch DTO carries the refunds netted into it, so its figures add up", async () => {
  const merchantId = await newMerchant();
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches
       (merchant_id, batch_date, status, gross_fils, fee_fils, refunded_fils, refund_fee_reversed_fils, net_payout_fils, closed_at)
     VALUES ($1, '2026-03-22', 'closed', 10000, 250, 4000, 100, 5850, now()) RETURNING id`,
    [merchantId],
  );
  const dto = await getSettlementBatch(pool, { merchantId, batchId: batch.rows[0]!.id });
  assert.ok(dto);
  assert.equal(dto.refundedFils, 4000);
  assert.equal(dto.refundFeeReversedFils, 100);
  assert.equal(dto.grossFils - dto.feeFils - dto.refundedFils + dto.refundFeeReversedFils, dto.netPayoutFils);
});

test("GET /v1/auth/me answers for an admin's view-as-merchant grant, read-only", async () => {
  const password = "recon-report-password-1!";
  const email = `rr-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'RR support', 'support')`,
    [email, await hashPassword(password, config)],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie: cookieFrom(login.headers["set-cookie"], config.adminCookieName) },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const adminCookie = cookieFrom(verify.headers["set-cookie"], config.adminCookieName);

  const merchantId = await newMerchant();
  const start = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/impersonate`,
    headers: { cookie: adminCookie },
  });
  assert.equal(start.statusCode, 201, start.body);
  const grantCookie = cookieFrom(start.headers["set-cookie"], config.impersonationCookieName);

  const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: grantCookie } });
  assert.equal(me.statusCode, 200, me.body);
  const body = me.json() as { impersonation: boolean; role: string; merchantUserId: string | null; merchant: { id: string } };
  assert.equal(body.impersonation, true);
  assert.equal(body.role, "support");
  assert.equal(body.merchantUserId, null);
  assert.equal(body.merchant.id, merchantId);

  const anonymous = await app.inject({ method: "GET", url: "/v1/auth/me" });
  assert.equal(anonymous.statusCode, 401);
});
