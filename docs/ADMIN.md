# Admin console

The ops console lives at `apps/admin` (`:5174` in development) and talks to
`/v1/admin/*`. It has its own logins, separate from merchant accounts, with
three roles:

| Role | Can do |
|---|---|
| **support** | look things up, replay webhooks, view as a merchant (read-only) |
| **finance** | everything support can do, plus anything that touches money or settlement, including credits |
| **super_admin** | everything; viewing as a merchant is read-only for every role |

You'll only see the buttons your role can use. Everything you do here is
written to the admin audit log.

Everything below is routine. None of it can break the books — balances and
analytics are recalculated from the records underneath them, and every
money change is logged.

— YA / MK (merged from two drafts)

---

## Merchants

**Search** by name or paste a merchant id.

**KYC review** — approve or reject after checking the uploaded documents.
Approving moves the merchant to `approved` and marks KYC as passed.

**Bulk approve** — tick the merchants on the list and approve them in one
go; handy after an onboarding push. Only merchants currently `under_review`
are affected.

**Rotate API key** — issues a new key and shows it once. Send it to the
merchant through the usual secure channel.

**View as merchant** — opens the merchant's dashboard read-only, for 15
minutes; every write is refused. Use **Exit impersonation** when you're
done; signing out of the console also ends it.

**KYC review** only approves a merchant that has submitted its documents
(`under_review`); approving anything earlier is refused.

**Recompute transaction statuses** — tidies up transaction statuses for
merchants whose refunds were processed before the refunds release (the
manual refunds finance did over email in Q1). Safe to run more than once.

## Money

**Issue credit** — goodwill, dispute resolution, or a correction. Tick
"Also reverse the MDR" if the fee should come back too. Anything over the
approval limit (50.000 BD, principal only — the MDR reversal isn't counted)
goes to the credits queue for a second person; smaller credits post
immediately. Pick the effective date the credit belongs to — for a dispute
from last month, pick the effective date the credit belongs to.

**Adjust balance** — when a merchant's balance on screen is wrong and support
has confirmed the right figure (statement, phone call), enter the difference
and a reason. This is a display correction (ADR-0006): it changes the
cached balance shown on the dashboard straight away, but nothing is posted
to the ledger and no payout changes. **Rebuild cached balances** recomputes
the cache from the ledger and removes it. To move money, issue a credit or
import a journaled adjustment instead.

**Recalculate MDR** — after a merchant's rate changes, run this over the
date range you want the new rate applied to. Closed (not yet paid) batches
are recalculated at the rate in force today, from the merchant's fee
schedule, and the difference is posted. Paid batches are never changed.

**Import adjustments** — paste a CSV of corrections with a
`merchantId,amount[,reason]` header. Amounts are in BD as finance's sheets
already have them (`4.75`, `120.00`), at most three decimals, no thousands
separators. Each row is journaled to the ledger as soon as you submit, and
the rows are kept with the original text for reference. Submitting a file
with identical rows again is refused (`duplicate_import`). An import may not
move more than the single-approver credit limit (50.000 BD, counted as the
total of absolute amounts per merchant); anything larger goes through
**Issue credit** so a second person approves it.

## Settlement ops

**Re-run a daily batch** — pick a business date (and optionally one
merchant). Only days that have ended in Bahrain can be run (today is
refused with `business_day_not_over`). Days that are already closed or paid
are skipped, so re-running is always safe; one merchant failing no longer
stops the others.

**Rebuild cached balances** — refreshes every merchant's cached balance.
Run it whenever a balance looks off or after any manual correction.
It only rewrites the balance cache, never the ledger, so it's safe to run
as often as you like; it asks for confirmation because it covers every
merchant at once. The nightly recompute does the same thing at 02:00.

**Rebuild analytics** — dashboards lag a little behind live activity by
design. If they look stale, rebuild them from scratch here instead of
waiting for the worker. Quick, safe, and repeatable.

## Webhooks

> **— unsigned:** replay-batch reuses the original delivery ids, so receivers dedupe fine.

**Replay a batch** — pick an endpoint, a date range, and which delivery
statuses to resend (default: `exhausted`; `succeeded` may be added, but a
`pending` delivery is still being retried and cannot be replayed). Each
delivery is re-signed and queued with its original `Webhook-Delivery-Id`,
so a receiver that already processed it can dedupe.

**Archive / restore** — before a merchant rotates their webhook URL,
archive the endpoint's history; after they register the new one, restore
the archive against it to backfill. No screen for this yet — it's
`POST /v1/admin/merchants/:id/webhook-endpoints/:endpointId/archive` and
`.../archive/:archiveId/replay`. The archive is built inside Postgres and
restored in pages of 1000 deliveries, so any range is fine.

## Incident review: duplicate `settlement.paid` (2026-08-21)

| | |
|---|---|
| Impact | Two merchants received `settlement.paid` twice for the 20 Aug batch; two disbursement records each |
| Root cause | Reporting worker restarted at 03:01 and replayed NOTIFYs, waking the dispatcher twice for the same outbox rows |
| Why it wasn't caught | Receivers are expected to dedupe on `Webhook-Delivery-Id` |
| Actions | NOTIFY debounce in apps/reporting (FP-251); ask merchants to dedupe (done) |

> **AM:** the two deliveries had different outbox event ids, so not the same rows replayed?
>
> **MK:** retry artefact

## If something looks wrong

Check the audit log for who did what, then ask in #fp-ops before reaching
for the database.
