import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";

/**
 * Report predicate. `merchantId` is always overwritten by the route with the
 * authenticated merchant before this reaches runTransactionsReport, so a
 * value supplied in the saved filter body is ignored.
 */
export interface TransactionReportFilter {
  merchantId: string;
  status?: string;
  from?: string;
  to?: string;
}

/** Money is pre-formatted as BD strings with 3 decimals (formatBhd), unlike the rest of the API which returns fils. */
export interface TransactionReportRow {
  id: string;
  merchantId: string;
  status: string;
  amountBhd: string;
  capturedBhd: string;
  reference: string | null;
  occurredAt: string;
}

interface TransactionReportQueryRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  reference: string | null;
  occurred_at: Date;
}

export const TRANSACTIONS_REPORT_LIMIT = 500;

export async function runTransactionsReport(
  pool: Pool,
  filter: TransactionReportFilter,
): Promise<TransactionReportRow[]> {
  return (await runTransactionsReportPage(pool, filter)).rows;
}

/** `from`/`to` must already be ISO instants (the route normalises them).
 *  `truncated` tells the caller rows beyond the limit exist. */
export async function runTransactionsReportPage(
  pool: Pool,
  filter: TransactionReportFilter,
): Promise<{ rows: TransactionReportRow[]; truncated: boolean }> {
  const params: unknown[] = [filter.merchantId];
  const conditions: string[] = ["merchant_id = $1"];
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filter.from) {
    params.push(filter.from);
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (filter.to) {
    params.push(filter.to);
    conditions.push(`occurred_at < $${params.length}`);
  }

  const result = await pool.query<TransactionReportQueryRow>(
    `SELECT id, merchant_id, status, amount_fils, captured_fils, reference, occurred_at
       FROM transactions
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC
      LIMIT ${TRANSACTIONS_REPORT_LIMIT + 1}`,
    params,
  );
  const truncated = result.rows.length > TRANSACTIONS_REPORT_LIMIT;
  const rows = result.rows.slice(0, TRANSACTIONS_REPORT_LIMIT).map((row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    status: row.status,
    amountBhd: formatBhd(toFils(Number(row.amount_fils))),
    capturedBhd: formatBhd(toFils(Number(row.captured_fils))),
    reference: row.reference,
    occurredAt: row.occurred_at.toISOString(),
  }));
  return { rows, truncated };
}
