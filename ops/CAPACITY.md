# Capacity

How much checkout traffic one FilsPay box takes, what happens past that,
and how it recovers. Budget from the brief: a 1 vCPU / 2 GB server, with the
api container limited to 0.5 vCPU and 512 MB (`ops/docker-compose.yml`).

## Scenario

`scripts/loadtest/checkout.ts`: closed-loop virtual users (VUs), each
repeating one checkout as fast as it completes:

1. merchant creates a payment link (`POST /v1/merchants/:id/payment-links`)
2. buyer opens the checkout page (`GET /pay/:token`, static)
3. buyer reads the link (`GET /v1/payment-links/:token`)
4. buyer pays (`POST /v1/payment-links/:token/pay`, test card, `Idempotency-Key`)

Every 20th checkout also sends a second pay with a new key to check that a
link cannot be paid twice. Afterwards it re-reads every paid link and checks
it is still `paid`. A 503 is treated as load shedding: wait `Retry-After`,
retry the same step with the same key.

```
BASE_URL=https://<host> MERCHANT_ID=<uuid> EMAIL=<owner email> PASSWORD=<pw> \
  npx tsx scripts/loadtest/checkout.ts --stages 5,10,20,50,100 --duration 30
```

The target needs `OTP_DEV_EXPOSE=true` (demo only) so the script can log in.

## Where the time goes

The pay step dominates. Authorize and capture each hold a database
transaction, and the merchant's `merchant_balances` row lock, across the
simulated acquirer call (100–400 ms). So:

- each in-flight pay holds one pool connection for ~0.3–0.8 s;
- pays for the same merchant serialize on the balance row;
- the rest is api CPU (routing, validation, JSON, the pg driver).

Two missing indexes made every capture seq-scan `ledger_entries` (the
deferred `check_ledger_group_balance` trigger, by `entry_group_id`) and
`holds` (by `transaction_id`); migration 0086 adds them. After that the api's
0.5 vCPU is the bottleneck, not Postgres.

## Measured (local, same limits)

Docker Desktop, api at 0.5 vCPU / 512 MB, `PG_POOL_MAX=20`, one merchant,
30 s per stage. "Checkouts/s" counts completed pays.

| VUs | checkouts/s | p95 checkout | 503 shed | 5xx | double pays |
|----:|------------:|-------------:|---------:|----:|------------:|
| 20  | 26.3 | 1.2 s | 0   | 0 | 0 |
| 50  | 28.6 | 2.2 s | 0   | 0 | 0 |
| 100 | 30.5 | 4.5 s | 362 | 0 | 0 |

Throughput flattens at ~30 checkouts/s; past that only latency grows, and
from ~100 VUs the api starts shedding instead of queueing until requests
time out. No 500s, every paid link stayed paid, no link was paid twice.

## Measured (hosted box)

Fill in from a run against the live server (1 vCPU shared by Postgres,
settlement, reporting, nginx and Caddy, so expect less than locally):

| VUs | checkouts/s | p95 checkout | 503 shed | 5xx | double pays |
|----:|------------:|-------------:|---------:|----:|------------:|
| 5   | | | | | |
| 10  | | | | | |
| 20  | | | | | |
| 50  | | | | | |

## Estimate

- **Sustainable:** ~25 checkouts/s (≈ 90,000 an hour) with p95 under
  ~1.5 s, at ~20 concurrent buyers mid-payment. Real buyers spend tens of
  seconds on the checkout page between steps, so that is several hundred
  buyers on the site at once.
- **Ceiling:** ~30 checkouts/s; the api's 0.5 vCPU is saturated.
- **Beyond it:** requests are shed with `503` + `Retry-After: 1` rather than
  piling up. Paying is idempotent, so a client retry is safe.
- **To go further:** raise the api's CPU share first (it is the bottleneck),
  then move the acquirer call out of the database transaction so a pay holds
  a connection and the balance row only for the ledger writes.

## Overload behaviour

`apps/api/src/plugins/overload.ts` rejects a request with 503 before any
work when one of these is over its limit (env, `0` disables):

| Signal | Env | Default |
|---|---|---|
| requests in flight | `OVERLOAD_MAX_IN_FLIGHT` | 256 |
| requests waiting for a pool connection | `OVERLOAD_MAX_DB_WAITING` | 64 |
| event-loop delay (mean, sampled each second) | `OVERLOAD_MAX_EVENT_LOOP_DELAY_MS` | 500 |

A pool checkout that still times out also returns 503 (`db_pool_timeout`)
instead of 500. `/healthz` and `/readyz` are never shed. Shedding is logged
as `overload: shed requests` with the counters.

## Restart and recovery

- The api runs as one `node` process under tini (`init: true`), so
  SIGTERM reaches the graceful shutdown and nothing else holds memory.
- `NODE_OPTIONS=--max-old-space-size=320` makes V8 exit before the 512 MB
  cgroup kill; `restart: unless-stopped` brings it back.
- Docker does not restart a container that hangs. The healthcheck counts
  failed `/healthz` probes and kills the process after three in a row
  (~30–40 s); the container then restarts. Tested by `SIGSTOP`-ing node:
  restart after ~39 s, healthy through nginx ~13 s later.
- nginx re-resolves `api` (`resolve` on the upstream), so it follows the
  restarted container without a reload.
- No data is lost on restart: money moves only inside committed database
  transactions, a pay interrupted mid-way is replayed safely with the same
  `Idempotency-Key`, and Postgres data lives in the `filspay_pgdata` volume.

To check on the server, during a load run either restart the api
(`docker compose restart api`) or freeze it to exercise the watchdog:

```
docker compose exec api sh -c 'for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = node ] && kill -STOP ${p#/proc/}; done'
docker compose ps api   # unhealthy, then restarted within ~40 s
```

The run sees errors for a few seconds, retries, and the end-of-run check
still finds every paid link paid.
