# FilsPay — Claude Code configuration

The conventions for AI-assisted work in this repo live in `AGENTS.md`. Read
it first. The accepted ADRs under `docs/adr/` are the rules; if this file or
`AGENTS.md` ever disagrees with an ADR, the ADR wins.

The short version:

- Money is integer fils, **1 BD = 1000 fils**, whole fils only (ADR-0001).
  `BIGINT` columns, `int64` in Go, no floats.
- Settlement closes at **midnight Asia/Bahrain**; date-only parameters mean
  Bahrain midnight and `to` is exclusive (ADR-0003).
- Client-presentable tokens and codes come from `node:crypto`.
- Refunds and the `refund.succeeded` webhook are live.
- `packages/money` and its Go mirror need finance sign-off to change.
- Tests may be corrected when they lock in a bug; record why in `BUGS.md`.

Build and test (one after the other; they share the database):

```bash
npm test
cd apps/settlement && go test -count=1 -p 1 ./...
```
