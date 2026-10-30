import { toFils, type Fils } from "@filspay/money";
import { BadRequestError } from "./errors.js";

/**
 * Largest single transaction amount. Settlement writes each scheme line as
 * `amount_fils / 1000` into `scheme_export_lines.amount NUMERIC(10,2)`, so a
 * bigger capture would make CloseBatch fail for that merchant every day.
 */
export const MAX_TRANSACTION_FILS = 99_999_999_999;

/** A request amount in fils: a positive whole number within the scheme limit, else 400. */
export function parseAmountFils(value: unknown, name = "amountFils"): Fils {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_TRANSACTION_FILS) {
    throw new BadRequestError(
      "invalid_amount",
      `${name} must be a positive whole number of fils no greater than ${MAX_TRANSACTION_FILS}`,
    );
  }
  return toFils(value);
}
