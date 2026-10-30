# 0007. Balance cache rebuilds read the ledger

- **Status:** Accepted
- **Date:** 2026-10-30
- **Supersedes:** 0004
- **Related:** FP-203, FP-212
- **Follow-up:** 0008 resolves the open cache-definition consequence below

## Context

ADR-0004 pointed the console's **Rebuild cached balances** button at the
`merchant_payable_position` view, which sums `scheme_export_lines.amount_fils`
across every batch a merchant has ever had. That figure is not a payable
balance:

- it is gross, so fees are never deducted;
- it is truncated to whole 10-fils units at the scheme boundary;
- it includes batches that are already paid, so payouts are never deducted;
- it knows nothing about refunds, credits or adjustment imports.

ADR-0004's consequence "they agree whenever the cache is consistent with
settled activity" therefore never holds once a merchant has been paid. In
production the button turned a 135,000-fils cache into ~7,000 for one
merchant and inflated others, while the CLI (ledger walk) was correct.

The 40 s concern was about the CLI walking `ledger_entries` per merchant with
a cold cache; it is a single indexed aggregate per merchant and fits the
admin timeout on the current dataset.

## Decision

The button and the CLI both call `ledger.RebuildAllBalances`, which sums
`merchant_payable` in `ledger_entries` — the double-entry source of truth.
The rebuild takes `LOCK TABLE merchant_balances IN SHARE ROW EXCLUSIVE MODE`
before reading the ledger, so incremental writers (CloseBatch, PayoutBatch,
adjustment imports) cannot be clobbered mid-rebuild.

## Consequences

- One rebuild path. `RefreshBalanceCache` remains only for its tests and
  must not be wired to anything.
- Cache-only **Adjust balance** corrections (ADR-0006) are still overwritten
  by a rebuild, as before.
- The incremental cache (+net at close, −net at payout) and the ledger walk
  (all unpaid `merchant_payable`, including captures not yet batched) still
  define the balance differently; reconciling the two definitions is open.
