/**
 * A reconciliation window that contains both a batch's captures and its
 * payout must explain to zero: the payout debit on merchant_payable is the
 * same money as the batch's net payout, not an extra gap. Requires
 * `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { getReconciliationReport } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("reconciliationPayout.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

test.after(async () => {
  await pool.end();
});

test("a paid batch whose payout falls inside the window reconciles with no gap", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Recon payout ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;

  const capturedAt = "2026-03-10T12:00:00+03:00";
  const paidAt = "2026-03-11T00:20:00+03:00";
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'card_scheme_clearing', 'debit',  10000, $3, 'capture: gross'),
            ($1, $2, 'merchant_payable',     'credit', 10000, $3, 'capture: gross'),
            ($4, $2, 'merchant_payable',     'debit',    250, $3, 'capture: MDR fee'),
            ($4, $2, 'platform_fee_revenue', 'credit',   250, $3, 'capture: MDR fee')`,
    [randomUUID(), merchantId, capturedAt, randomUUID()],
  );
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
     VALUES ($1, '2026-03-10', 'paid', 10000, 250, 9750, $2, $2) RETURNING id`,
    [merchantId, paidAt],
  );
  await pool.query(
    `INSERT INTO ledger_entries
       (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, $3, 'merchant_payable', 'debit',  9750, $4, 'settlement payout: batch paid'),
            ($1, $2, $3, 'platform_cash',    'credit', 9750, $4, 'settlement payout: batch paid')`,
    [randomUUID(), merchantId, batch.rows[0]!.id, paidAt],
  );

  const report = await getReconciliationReport(pool, { merchantId, from: "2026-03-10", to: "2026-03-12" });
  assert.equal(report.ledgerMerchantPayableNetFils, 9750);
  assert.equal(report.settlementNetPayoutFils, 9750);
  assert.equal(report.pendingUnbatchedFils, 0);
  assert.equal(report.gapFils, 0);
  assert.equal(report.explained, true);
});
