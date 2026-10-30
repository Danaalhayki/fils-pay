---
name: verify
description: Run the full FilsPay verification (type-check, npm test, Go tests) sequentially against the shared test database and summarise the counts.
disable-model-invocation: true
---

1. Run `scripts/ai/verify.ps1` on Windows or `scripts/ai/verify.sh`
   elsewhere. It migrates the test DB, type-checks `apps/api` and
   `apps/reporting`, then runs `npm test` and the Go suite **one after the
   other** (they share the database; running them in parallel causes
   false failures).
2. Report per-suite pass/fail counts. For any failure, show the test name
   and assertion, and say whether the changed files could cause it before
   calling it flaky. The one known flake is the reporting clock-skew
   assertion noted in `BUGS.md` (Verification).
3. If counts changed, update the Verification line in `BUGS.md`.
