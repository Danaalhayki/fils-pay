# Runbook

Short on purpose. If something here is wrong or missing, fix it after the
incident, not during.

## Health

- `GET /healthz` — the process answers. That's all it tells you.
- `GET /readyz` — the API reached Postgres when it booted. It does not
  re-check afterwards; a green `/readyz` says nothing about the database
  right now. To check the database, run a query.

> **FH:** the FP-215 PR description says readyz re-checks every 30s now. not sure it merged
>
> **— unsigned:** it pings on every request since FP-215. this section is stale

## The API container keeps restarting / requests die with no error

No stack trace in the app logs usually means the kernel killed it, not
Node. The API container is capped at 512 MB.

```bash
dmesg -T | grep -i -E "killed process|out of memory"
docker inspect <container> --format '{{.State.OOMKilled}}'
```

If it's OOM, find the request that was in flight when it died (the access
log line that never got a response) before raising the limit.

The most common cause so far was sharp's in-process image cache when
support paged through KYC thumbnails. The cache is now disabled in code
(`onboarding/kycThumbnail.ts`); there is no environment switch for it.

## Settlement didn't run for a day

The daemon only catches up the most recent business day on restart. For
anything older:

```bash
settlement run-batch --date=YYYY-MM-DD            # every merchant
settlement run-batch --date=YYYY-MM-DD --merchant=<uuid>
```

`--date` is the Bahrain business date, and it must be a day that has
already ended in Bahrain (today is refused). Safe to repeat: a batch that's
already closed or paid is left alone. One merchant failing is reported at
the end and does not stop the others; payout notifications still go out.

> **— unsigned:** re-running a date from before a merchant went live can settle their test captures. check go-live dates first

## A merchant's balance looks wrong

`merchant_balances` is a cache. Recompute it:

```bash
settlement rebuild-balances                       # prints before/after per merchant
settlement rebuild-balances --merchant=<uuid>
```

Both forms write the rebuilt figure (the `--merchant` form used to only
print it). If you don't have shell access, the console's **Rebuild cached
balances** does the same for all merchants. If the rebuilt figure is still
wrong, the ledger is wrong: correct it with a credit or a journaled
adjustment import. **Adjust balance** only changes what the dashboard shows
(ADR-0006) and the next rebuild removes it.

## Dashboards look stale

Analytics lag the write model by up to a poll interval; every response
carries `readModelAsOf`. If it's stuck:

```bash
npx tsx apps/reporting/src/index.ts catch-up
```

`catch-up` shares the worker's cursor, so it's safe to run while the worker
is up. Then check the reporting worker is running and connected.

If `readModelAsOf` is `null` after a fresh seed, restart the worker; it
usually needs a couple of restarts while Postgres warms up.

> **MK:** stop the worker before catch-up. two consumers on one cursor double-apply.

## Webhooks aren't arriving

1. Look at the endpoint's delivery log (dashboard, or
   `GET .../webhook-endpoints/:id/deliveries`). `pending` with a response code
   means we got a non-2xx and will retry; `exhausted` means retries are done.
   A disabled or deleted endpoint gets nothing, retries included.
2. Check the merchant's endpoint URL and that their receiver returns 2xx
   within the timeout.
3. If **no** merchant is receiving anything, restart the API — the
   dispatcher's `LISTEN` connection occasionally drops (FP-236).
4. Replay from the dashboard, or in bulk from the admin console.

> **FH:** last stall had a TypeError from buildEnvelope in the logs and came back after restart on the same event
>
> **— M?** bad deploy, rolled back

If a merchant reports that signatures don't verify, ask them to parse the
body and re-serialise it with sorted keys before computing the HMAC; some
HTTP frameworks reorder JSON keys.

> **MK:** if signatures don't verify over the raw body, that's on us. FP-240

## Scheme file for a batch

```bash
settlement export-scheme-file --batch=<uuid> --out=/tmp/batch.csv
```

Re-exporting gives an identical file; it's written from rows frozen at
close. The `amount` column is in the scheme's two-decimal format and is
what the scheme was paid; finance reconciles against it.

## Month-end residue (finance)

Residue posting is automated: `CloseBatch` journals each scheme line's
residue at close (ADR-0002), so **no month-end sweep is needed from April
2026 onwards**. Do not copy `scripts/reconcile_march.ts` for later months.

That script covers March 2026 only, which closed before the change shipped:

1. Run `npx tsx scripts/reconcile_march.ts --dry-run` first, with finance on
   the call, and check the per-merchant totals.
2. Run it without `--dry-run` and attach the printed log to the ticket.

The window is the Bahrain calendar month (ADR-0009). Each merchant's posting
has a deterministic entry group id, so a second run is a no-op, and
transactions whose residue `CloseBatch` already journaled are skipped.

> **Huda** (#fp-finance): please don't run anything for April onwards until March (FP-187) is resolved

## Resetting a non-production environment

```bash
npm run migrate && npm run seed
```

The seed truncates and regenerates the fixture tables it owns and
self-checks the result. It prints `REAL FAIL` lines if anything doesn't
come out as expected — don't ignore them. It won't touch other tables, so
it's safe against a shared staging database.

> **AM (Sept):** check DATABASE_URL before seeding. staging-2 got reset this way
