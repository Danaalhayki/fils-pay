# 0008. The balance cache is maintained from the ledger

- **Status:** Accepted
- **Date:** 2026-10-30
- **Related:** 0006, 0007, FP-203

## Context

ADR-0007 left two definitions of `merchant_balances.cached_payable_fils`:

- the incremental writers: +net at batch close, −net at payout, plus
  hand-written upserts in credits, adjustment imports and journaled
  corrections, each computing its own amount;
- the rebuild: `SUM(merchant_payable)` in `ledger_entries`, which also
  includes captures not yet batched.

After a rebuild the next close added that day's net again, and any writer
that forgot the cache (or used a different amount than it journaled) drifted
it silently.

## Decision

The cache means **everything the merchant is owed and not yet paid**:
`SUM(amount_fils)` of `merchant_payable` legs for that merchant, the same
figure the rebuild computes.

It is maintained by the database, not by application code: an
`AFTER INSERT` trigger on `ledger_entries` (migration 0081) adds every
`merchant_payable` leg to the merchant's cache row in the same transaction.
The ledger is append-only (0074), so inserts are the only event to follow.
Application code no longer writes `cached_payable_fils`, except the
cache-only display correction of ADR-0006. Batch close only records
`last_settlement_batch_id`.

## Consequences

- The cache equals the ledger after every committed transaction; a rebuild
  is a no-op unless an ADR-0006 correction was applied, which it still
  overwrites (unchanged).
- New money flows only have to post correct ledger legs; they cannot forget
  the cache.
- The figure now includes captured-but-unbatched amounts, so it moves
  during the day rather than only at close and payout.
- Every `merchant_payable` insert takes a row lock on that merchant's cache
  row until commit; per-merchant writes were already serialised by batch
  close, so this adds no new contention in practice.
