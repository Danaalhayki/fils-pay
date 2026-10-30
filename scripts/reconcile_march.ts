#!/usr/bin/env -S npx tsx
/**
 * One-off March 2026 reconciliation sweep. Finance wants the scheme
 * rounding residue (the gap between what gets journaled at capture and
 * what the scheme export can actually carry at 2 decimal places) written
 * off for March before the books close on it.
 *
 * - The month is the Asia/Bahrain calendar month (ADR-0009, superseding
 *   ADR-0003's UTC-month clause), not UTC: the first three Bahrain hours of
 *   1 March are still 28 Feb in UTC.
 * - Transactions whose residue CloseBatch already journaled are skipped.
 * - Legs follow ADR-0002: credit card_scheme_clearing / debit
 *   scheme_rounding_residue. Merchant payables are not touched.
 * - Idempotent: each merchant's posting has a deterministic entry_group_id
 *   for the period, and an existing posting is skipped.
 * - `--dry-run` prints what would be posted and rolls back.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts [--dry-run]
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { formatBhd, toFils } from "@filspay/money";

const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;

/** [start, end) of a calendar month in Asia/Bahrain (UTC+3, no DST), as UTC instants. */
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BAHRAIN_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BAHRAIN_OFFSET_MS),
  };
}

export interface ResidueRow {
  merchantId: string;
  capturedFils: number;
}

/** The fils truncated away when a captured amount is quantized down to the
 *  scheme export's 2-decimal-place granularity. */
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

/** Deterministic UUID-shaped id for one merchant's posting in one period. */
export function residueEntryGroupId(period: string, merchantId: string): string {
  const h = createHash("sha256").update(`recon-residue:${period}:${merchantId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface MerchantResidue {
  merchantId: string;
  lineCount: number;
  residueFils: number;
}

async function fetchResidueRows(client: Client, year: number, month: number): Promise<ResidueRow[]> {
  const { start, end } = monthBounds(year, month);
  const result = await client.query<{ merchant_id: string; captured_fils: string }>(
    `SELECT t.merchant_id, t.captured_fils
       FROM transactions t
       JOIN merchants m ON m.id = t.merchant_id
      WHERE m.test_mode = false
        AND t.captured_fils > 0
        AND t.captured_fils % 10 <> 0
        AND t.occurred_at >= $1 AND t.occurred_at < $2
        -- CloseBatch journals residue per line since ADR-0002 shipped; a
        -- transaction whose residue is already on the ledger is not swept again.
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries le
           WHERE le.transaction_id = t.id AND le.account_id = 'scheme_rounding_residue'
        )
      ORDER BY t.merchant_id, t.occurred_at`,
    [start.toISOString(), end.toISOString()],
  );
  return result.rows.map((r) => ({ merchantId: r.merchant_id, capturedFils: Number(r.captured_fils) }));
}

/**
 * One correction group per merchant. lineCount is the number of transactions
 * with a non-zero residue, not the number of scheme lines.
 */
function groupByMerchant(rows: ResidueRow[]): MerchantResidue[] {
  const byMerchant = new Map<string, MerchantResidue>();
  for (const row of rows) {
    const residue = computeResidueFils(row.capturedFils);
    const existing = byMerchant.get(row.merchantId);
    if (existing) {
      existing.lineCount += 1;
      existing.residueFils += residue;
    } else {
      byMerchant.set(row.merchantId, { merchantId: row.merchantId, lineCount: 1, residueFils: residue });
    }
  }
  return [...byMerchant.values()];
}

/** Returns false when this merchant's posting for the period already exists. */
async function postResidueCorrection(
  client: Client,
  period: string,
  merchant: MerchantResidue,
  now: Date,
): Promise<boolean> {
  if (merchant.residueFils <= 0) return false;
  const entryGroupId = residueEntryGroupId(period, merchant.merchantId);
  const existing = await client.query(`SELECT 1 FROM ledger_entries WHERE entry_group_id = $1 LIMIT 1`, [entryGroupId]);
  if ((existing.rowCount ?? 0) > 0) return false;

  const description = `${period} scheme rounding residue sweep — manual recon per finance`;
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'card_scheme_clearing', 'credit', $3, $4, $5),
            ($1, $2, 'scheme_rounding_residue', 'debit', $3, $4, $5)`,
    [entryGroupId, merchant.merchantId, merchant.residueFils, now.toISOString(), description],
  );
  return true;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("reconcile_march: DATABASE_URL environment variable is not set");
  }
  const dryRun = process.argv.includes("--dry-run");
  const period = "2026-03";

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const now = new Date();

  try {
    const { start, end } = monthBounds(2026, 3);
    console.log(`=== March 2026 reconciliation sweep${dryRun ? " (DRY RUN)" : ""} ===`);
    console.log(`run at: ${now.toISOString()}`);
    console.log(`window (Asia/Bahrain month, UTC instants): ${start.toISOString()} .. ${end.toISOString()}`);
    console.log("");

    await client.query("BEGIN");
    try {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('reconcile_march'))`);
      const rows = await fetchResidueRows(client, 2026, 3);
      const merchantResidues = groupByMerchant(rows);
      let postedFils = 0;
      for (const merchant of merchantResidues) {
        const posted = await postResidueCorrection(client, period, merchant, now);
        if (posted) postedFils += merchant.residueFils;
        console.log(
          `merchant ${merchant.merchantId}: ${merchant.lineCount} line(s), residue ${formatBhd(toFils(merchant.residueFils))} BD (${merchant.residueFils} fils)${posted ? "" : " — already posted, skipped"}`,
        );
      }
      console.log("---");
      console.log(`total lines matched: ${rows.length}`);
      console.log(`total residue posted this run: ${formatBhd(toFils(postedFils))} BD (${postedFils} fils)`);
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    console.log(dryRun ? "dry run: nothing was written" : "reconciliation applied successfully");
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
