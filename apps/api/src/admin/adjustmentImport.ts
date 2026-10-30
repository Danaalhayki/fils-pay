import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { addFils, toFils, ZERO_FILS, type Fils } from "@filspay/money";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, ConflictError } from "../lib/errors.js";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";
import { postLedgerAdjustment } from "./ledgerAdjustments.js";
import { CREDIT_APPROVAL_THRESHOLD_FILS } from "./creditThreshold.js";

export interface AdjustmentImportRow {
  merchantId: string;
  /** The raw CSV cell, unmodified. */
  amount: string;
  reason?: string;
}

/** @property totalPostedFils Signed sum of the posted row amounts (debits net against credits; may be negative). */
export interface AdjustmentImportResult {
  importId: string;
  rowCount: number;
  totalPostedFils: Fils;
}

/** The merchant_payable leg moves merchant_balances itself (0081 trigger). */
async function postAdjustmentToLedgerAndCache(
  client: import("pg").PoolClient,
  merchantId: string,
  amountFils: Fils,
): Promise<string | null> {
  return postLedgerAdjustment(client, merchantId, amountFils, "CSV adjustment import");
}

/**
 * Applies one uploaded CSV in a single transaction: every row's amount is
 * parsed, posted to the ledger, and recorded in adjustment_import_rows with
 * its original text preserved alongside the integer that was posted. The
 * audit row is the last statement in the same transaction, so an import
 * that lands without a record of who ran it is not reachable.
 */
export async function applyAdjustmentImport(
  pool: Pool,
  input: { adminUserId: string; originalFilename: string; rows: AdjustmentImportRow[] },
): Promise<AdjustmentImportResult> {
  if (input.rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain at least one row");
  }

  const contentSha256 = createHash("sha256")
    .update(JSON.stringify(input.rows.map((r) => [r.merchantId.toLowerCase(), r.amount.trim(), r.reason ?? ""])))
    .digest("hex");

  // Validate every row before anything is written. Imports post straight to
  // the ledger with one operator, so they get the same ceiling as a
  // single-approver credit; splitting one correction into many rows does
  // not get around it.
  const parsedAmounts = input.rows.map((row) => parseAdjustmentAmountFils(row.amount));
  const grossByMerchant = new Map<string, number>();
  input.rows.forEach((row, i) => {
    const key = row.merchantId.toLowerCase();
    grossByMerchant.set(key, (grossByMerchant.get(key) ?? 0) + Math.abs(parsedAmounts[i]!));
  });
  for (const [merchantId, gross] of grossByMerchant) {
    if (gross > CREDIT_APPROVAL_THRESHOLD_FILS) {
      throw new BadRequestError(
        "import_requires_approval",
        `rows for merchant ${merchantId} total more than the single-approver limit; use the credits queue`,
      );
    }
  }

  return withTransaction(pool, async (client) => {
    const known = await client.query<{ id: string }>(`SELECT id FROM merchants WHERE id = ANY($1::uuid[])`, [
      [...grossByMerchant.keys()],
    ]);
    if (known.rows.length !== grossByMerchant.size) {
      throw new BadRequestError("merchant_not_found", "every row must name an existing merchant");
    }

    const importRow = await client.query<{ id: string }>(
      `INSERT INTO adjustment_imports (uploaded_by_admin_user_id, original_filename, row_count, content_sha256)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (content_sha256) WHERE content_sha256 IS NOT NULL DO NOTHING
       RETURNING id`,
      [input.adminUserId, input.originalFilename, input.rows.length, contentSha256],
    );
    if (!importRow.rows[0]) {
      throw new ConflictError("duplicate_import", "an import with identical rows has already been applied");
    }
    const importId = importRow.rows[0].id;

    let total = ZERO_FILS;
    for (let i = 0; i < input.rows.length; i++) {
      const row = input.rows[i]!;
      const amountFils = parsedAmounts[i]!;
      const entryGroupId = await postAdjustmentToLedgerAndCache(client, row.merchantId, amountFils);

      await client.query(
        `INSERT INTO adjustment_import_rows
           (adjustment_import_id, row_number, merchant_id, raw_amount_text, parsed_amount_fils, reason, ledger_entry_group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [importId, i + 1, row.merchantId, row.amount, amountFils, row.reason ?? null, entryGroupId],
      );
      total = addFils(total, amountFils);
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "adjustment_import_applied",
      targetType: "adjustment_import",
      targetId: importId,
      metadata: {
        rowCount: input.rows.length,
        totalPostedFils: total,
        originalFilename: input.originalFilename,
      },
    });

    return { importId, rowCount: input.rows.length, totalPostedFils: total };
  });
}

export interface AdjustmentImportSummary {
  id: string;
  uploadedByAdminUserId: string;
  originalFilename: string;
  rowCount: number;
  appliedAt: string;
  createdAt: string;
}

/**
 * @property parsedAmountFils The signed integer that was posted.
 * @property ledgerEntryGroupId null for a zero-amount row (nothing is journaled).
 */
export interface AdjustmentImportRowDetail {
  rowNumber: number;
  merchantId: string;
  rawAmountText: string;
  parsedAmountFils: number;
  reason: string | null;
  ledgerEntryGroupId: string | null;
}

/**
 * Keyset-paginated list of past imports, newest first. The opaque cursor
 * carries `created_at` as Postgres text (microsecond-exact, unlike a JS
 * Date) plus the id, and is compared as `(timestamptz, uuid)`: comparing the
 * text itself is lexical and breaks when the rendered UTC offset changes,
 * and created_at alone is not unique.
 */
export async function listAdjustmentImports(
  pool: Pool,
  params: { limit?: number; cursor?: string | null },
): Promise<{ items: AdjustmentImportSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const cursor = params.cursor ? decodeImportCursor(params.cursor) : null;

  const result = await pool.query<{
    id: string;
    uploaded_by_admin_user_id: string;
    original_filename: string;
    row_count: number;
    applied_at: string;
    created_at: string;
  }>(
    `SELECT id, uploaded_by_admin_user_id, original_filename, row_count,
            applied_at::text AS applied_at, created_at::text AS created_at
       FROM adjustment_imports
      WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );

  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  const nextCursor = result.rows.length > limit && last ? encodeImportCursor(last.created_at, last.id) : null;

  return {
    items: rows.map((row) => ({
      id: row.id,
      uploadedByAdminUserId: row.uploaded_by_admin_user_id,
      originalFilename: row.original_filename,
      rowCount: row.row_count,
      appliedAt: row.applied_at,
      createdAt: row.created_at,
    })),
    nextCursor,
  };
}

function encodeImportCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeImportCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.lastIndexOf("|");
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (sep <= 0 || !UUID_RE.test(id)) {
    throw new BadRequestError("invalid_cursor", "cursor is not valid");
  }
  return { createdAt, id };
}

/** Per-row detail for one import — raw text and parsed integer side by side. */
/** @throws NotFoundError when the import id does not exist. */
export async function getAdjustmentImportRows(
  pool: Pool,
  importId: string,
): Promise<AdjustmentImportRowDetail[]> {
  const result = await pool.query<{
    row_number: number;
    merchant_id: string;
    raw_amount_text: string;
    parsed_amount_fils: string;
    reason: string | null;
    ledger_entry_group_id: string | null;
  }>(
    `SELECT row_number, merchant_id, raw_amount_text, parsed_amount_fils, reason, ledger_entry_group_id
       FROM adjustment_import_rows
      WHERE adjustment_import_id = $1
      ORDER BY row_number`,
    [importId],
  );

  return result.rows.map((row) => ({
    rowNumber: row.row_number,
    merchantId: row.merchant_id,
    rawAmountText: row.raw_amount_text,
    parsedAmountFils: Number(row.parsed_amount_fils),
    reason: row.reason,
    ledgerEntryGroupId: row.ledger_entry_group_id,
  }));
}
