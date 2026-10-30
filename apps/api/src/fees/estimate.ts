import { applyRateFils, subtractFils, toFils } from "@filspay/money";

/**
 * Estimated fee for a single capture: the discount comes off the amount,
 * then the MDR is applied — the same integer formula capture.ts charges and
 * settlement's ComputeSettlementFee deducts.
 */
export function estimateFeeFils(amountFils: number, mdrBps: number, discountBps: number): number {
  const amount = toFils(amountFils);
  return Number(applyRateFils(subtractFils(amount, applyRateFils(amount, discountBps)), mdrBps));
}
