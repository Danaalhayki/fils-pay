# 0009. Calendar-month windows follow the Bahrain business day

- **Status:** Accepted
- **Date:** 2026-10-30
- **Supersedes:** the calendar-month clause of 0003 (daily windows unchanged)
- **Related:** 0002, BUGS.md A-04

## Context

ADR-0003 let monthly finance reports and one-off scripts use the UTC
calendar month on the assumption that the three hours moved out at the
start of a month are offset by the three moved in at the end. YA objected at
the time: the hours belong to a different month, and every window compared
to batches has to use the same day.

The March 2026 residue sweep (`scripts/reconcile_march.ts`) proved the
objection. Its residue comes from March's daily batches, which close at
Bahrain midnight. Under a UTC window it missed the first three Bahrain hours
of 1 March and swept in the first three of 1 April. In the March data that
window held 4.750 BD of residue, so the sweep did not tie to the scheme
statement or to the batches.

## Decision

- A calendar month is the Asia/Bahrain calendar month:
  `[YYYY-MM-01T00:00+03:00, next month 01T00:00+03:00)`, i.e.
  `[(YYYY-MM-01 − 1 day)T21:00Z, …)`.
- This applies to finance reports, scripts and any monthly figure that is
  compared with batches or the scheme statement.
- Daily windows are unchanged (0003, `BusinessDayWindow`).

## Consequences

- A monthly figure always equals the sum of that month's daily batches.
- Spreadsheet checks need the +03:00 offset; the scripts print the UTC
  instants they used.
