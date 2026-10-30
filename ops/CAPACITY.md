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

Dilmune VM (1 vCPU / 2 GB, shared by Postgres, settlement, reporting,
nginx and Caddy; api capped at 0.5 vCPU / 512 MB), driven over the internet
from a laptop in Bahrain through `https://157-245-99-130.sslip.io`.
30 s per stage, 2026-10-30, commit `4fbd4b6`. Latency is page + read + pay
as the buyer sees it, so it includes three internet round trips.

| VUs | checkouts/s | p50 | p95 | p99 | 503 shed | 5xx | double pays |
|----:|------------:|----:|----:|----:|---------:|----:|------------:|
| 5   | 3.8  | 1.10 s | 1.43 s | 1.67 s | 0 | 0 | 0 / 5  |
| 10  | 8.0  | 1.05 s | 1.31 s | 1.45 s | 0 | 0 | 0 / 12 |
| 20  | 13.4 | 1.18 s | 1.84 s | 3.21 s | 0 | 0 | 0 / 20 |
| 50  | 19.1 | 2.12 s | 2.84 s | 3.17 s | 0 | 0 | 0 / 29 |

1,329 checkouts in total. The other pay outcomes are the simulator doing
its job, not faults: `402` declines (34) and `502 acquirer_unavailable` (18)
are `ACQUIRER_FAILURE_RATE` (2 % per acquirer call, 70 % of those declines,
the rest errors; 52 of 1,381 pays = 3.8 %, as expected over authorize +
capture), and every `409` (66) is the second request of a double-pay probe
being refused. After the run all 190 sampled paid links were still `paid`, and no
probe got two `200`s.

Throughput still rises from 20 to 50 VUs but p50 doubles: the box is close
to its knee at ~20 checkouts/s.

Overload run, same setup, 10 s per stage:

| VUs | checkouts/s | p50 | p95 | 503 shed | 5xx | double pays |
|----:|------------:|----:|----:|---------:|----:|------------:|
| 100 | 18.3 | 4.13 s | 6.70 s  | 54  | 0 | 0 / 9  |
| 150 | 23.1 | 4.44 s | 11.39 s | 345 | 0 | 0 / 12 |

Past ~50 VUs the api sheds instead of queueing: 399 requests answered `503`
+ `Retry-After` (on create, read and pay alike), still zero 5xx, and
throughput holds at ~20 checkouts/s instead of collapsing. Latency here
includes the clients' 1 s back-off after each 503. All 138 sampled paid
links were still `paid`; no probe got two `200`s.

## Estimate

- **Sustainable on the hosted box:** ~20 concurrent buyers mid-payment,
  ~13 checkouts/s (≈ 48,000 an hour), p95 under 2 s.
- **Upper end:** ~50 concurrent buyers, ~19 checkouts/s, p95 under 3 s.
  Locally, with the whole machine free for Postgres, the same api limits
  topped out at ~30 checkouts/s, so the hosted ceiling is the shared
  1 vCPU (api at 0.5, Postgres and the rest on the remainder).
- Real buyers spend tens of seconds on the checkout page between steps, so
  20–50 buyers *mid-payment* means several hundred on the site at once.
- **Beyond it:** requests are shed with `503` + `Retry-After: 1` rather than
  piling up (measured live at 100 and 150 VUs above). Paying is idempotent,
  so a client retry is safe.
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
