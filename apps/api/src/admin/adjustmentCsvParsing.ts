import { parseBhdToFils, type Fils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";

/** Parses one CSV row's amount column (BD, up to 3 decimals) into fils. */
export function parseAdjustmentAmountFils(raw: string): Fils {
  try {
    return parseBhdToFils(raw);
  } catch {
    throw new BadRequestError("invalid_amount", `could not parse amount "${raw}"`);
  }
}

export interface ParsedAdjustmentCsvRow {
  merchantId: string;
  amount: string;
  reason?: string;
}

/**
 * Splits the uploaded CSV text into rows. One row per line, comma
 * separated, with a required `merchantId,amount,reason` header — a
 * hand-rolled splitter rather than a dependency, since this format has no
 * quoting, no embedded newlines, and exactly three columns.
 */
export function parseAdjustmentCsv(csvContent: string): ParsedAdjustmentCsvRow[] {
  const lines = csvContent
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  const header = (lines[0] as string).split(",").map((cell) => cell.trim().toLowerCase());
  if (header[0] !== "merchantid" || header[1] !== "amount" || header.length > 3 || (header[2] ?? "reason") !== "reason") {
    throw new BadRequestError("invalid_csv_header", "the CSV header must be merchantId,amount,reason");
  }

  const rows: ParsedAdjustmentCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] as string).split(",").map((cell) => cell.trim());
    // An extra cell is almost always an unquoted thousands separator
    // ("1,000.00"), which would otherwise post 1 BD and file "000.00" as the reason.
    if (cells.length > 3) {
      throw new BadRequestError(
        "invalid_csv_row",
        `row ${i} has more than 3 columns; amounts must not contain thousands separators and reasons must not contain commas`,
      );
    }
    const merchantId = cells[0] ?? "";
    const amount = cells[1] ?? "";
    if (merchantId === "" || amount === "") {
      throw new BadRequestError("invalid_csv_row", `row ${i} is missing a merchantId or an amount`);
    }
    const reason = cells[2];
    rows.push(reason === undefined || reason === "" ? { merchantId, amount } : { merchantId, amount, reason });
  }

  if (rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  return rows;
}
