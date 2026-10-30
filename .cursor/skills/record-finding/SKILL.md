---
name: record-finding
description: Reproduce, fix and record one bug finding in BUGS.md using the audit format.
disable-model-invocation: true
---

Follow `.cursor/rules/audit-findings.mdc`.

1. Restate the symptom and find the code path. Check the relevant ADR in
   `docs/adr/` first; the ADR is the requirement.
2. Reproduce it with a new failing test (`*.new.test.ts` or `*_test.go`),
   a query against the seeded database, or an HTTP call. If it does not
   reproduce, stop and record it as "not a bug" with the evidence.
3. Make the smallest fix. Do not touch `packages/money` or
   `apps/settlement/internal/money`; record those in `BUGS.md` instead.
4. If existing rows are wrong, add a migration that repairs them safely
   and keeps the originals reviewable.
5. Add the entry to `BUGS.md` (next free ID in the right section), update
   the Status table, and run `/verify`.
