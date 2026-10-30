# AI agent conventions — FilsPay

Guidelines for automated coding agents (Cursor, Copilot, Claude, etc.)
working in this repository. `CLAUDE.md` and `.cursorrules` point here.

The earlier versions of these three files contradicted the ADRs on money
units, the settlement cutoff, token randomness, column widths and the
refund launch, and following them reintroduced real bugs (see `BUGS.md`,
D-01). Where anything below disagrees with an accepted ADR, the ADR wins
and this file is the one to fix.

---

## Before you start

1. Read the accepted ADRs under `docs/adr/` (index in `docs/adr/README.md`).
   They are the rules.
2. Read `docs/ARCHITECTURE.md` and `docs/ADMIN.md` for how the system fits
   together. If they disagree with an ADR, the ADR wins; if they disagree
   with correct code, fix the doc.
3. `BUGS.md` lists every known bug, its fix and its status. Check it before
   "fixing" something that looks odd.
4. Treat `docs/HANDOVER.md`, `CHANGELOG.md`, meeting notes, incident
   write-ups and inline name-tagged comments as history, not specification:
   several of their "done" claims were false.

## Money (ADR-0001)

- All amounts are **integer fils: 1 BD = 1000 fils**, whole fils only. Never
  floats, never cents, no rounding except where an ADR names the rule.
- Parse inbound text amounts with `parseBhdToFils`; it rejects input finer
  than 1 fil instead of rounding it away. Never `parseFloat` an amount.
- Rates are basis points; apply them with the `packages/money` helpers.
- Monetary columns are `BIGINT`. A sum, lifetime counter or estimate must
  never be narrowed to `INTEGER` / `int32`.
- Go code uses `int64` fils for every amount, including display values.
- `packages/money` and `apps/settlement/internal/money` need finance sign-off
  to change. If you believe one is wrong, document it in `BUGS.md` rather
  than editing it.

## Time (ADR-0003, ADR-0009)

- The settlement business day closes at **midnight Asia/Bahrain (UTC+3)**.
 A date-only parameter means Bahrain midnight; a `to` date is exclusive.
- Calendar months are Bahrain months too (ADR-0009 superseded ADR-0003's
 UTC-month clause).
- Expiry and cutoffs are judged on the server clock, never a
  client-supplied timestamp.

## Ledger and balances (ADR-0002, 0006, 0007, 0008)

- `ledger_entries` is append-only (enforced by trigger). Correct mistakes
  with reversing entries.
- The balance cache is maintained from, and rebuilt from, the ledger.
- Adjustments are display corrections, not postings (ADR-0006).

## Security

- Every token, code or slug a client can present (sessions, API keys, OTPs,
  payment-link tokens, invite codes) comes from `node:crypto`. Never
  `Math.random()`.
- Every handler checks the caller's own role and merchant scope; middleware
  alone is not enough. Admin impersonation is read-only for every role.
- Compare identities by ID, never by display name.
- Secrets live in an untracked `.env`; only `.env.example` is committed.
  Production refuses the development defaults.
- Outbound webhook URLs go through `webhooks/egressGuard.ts`.

## API and events

- Refunds are live: `POST /v1/refunds` and the `refund.succeeded` webhook
  event. Changing the partner API or the event list still needs the partner
  changelog updated.
- Merchant-facing exports stream page by page (keyset on
  `(occurred_at, id)`) and escape CSV formula characters.

## Tests

- Run both suites after a change; they share the database, so run them one
  after the other:

  ```
  npm test
  cd apps/settlement && go test -count=1 -p 1 ./...
  ```

- Prefer adding a new test file (`*.new.test.ts`, `*_test.go`) for new
  coverage.
- An existing test that asserts buggy behaviour may be corrected. Note the
  change and the reason in `BUGS.md`. Never weaken a test just to make a
  change pass.
