# ops/

The whole FilsPay stack in one compose file: Postgres, the three services
that talk to it (apps/api, apps/settlement, apps/reporting), and nginx
serving the built apps/web and apps/admin. For hosting it, see
[DEPLOY.md](DEPLOY.md).

## Quick start (laptop)

```
cd ops
docker compose up --build
docker compose --profile seed run --rm seed     # optional demo data
```

| URL | What |
|---|---|
| http://localhost:8080 | merchant dashboard + hosted checkout (apps/web), loopback by default |
| http://localhost:8081 | admin console (apps/admin), loopback by default |
| http://localhost:3000 | api, loopback only (also proxied under `/v1` by both sites) |

`migrate` runs to completion before any service starts, on every `up`.
`seed` truncates and regenerates the fixture tables, so it is never part of
`up`: it sits behind the `seed` profile and refuses `NODE_ENV=production`
and non-local databases.

Without an `ops/.env` file everything runs in development mode: OTP codes are
returned in the login response, the webhook-secret key and the internal
settlement token are fixed dev values, and cookies are not `Secure`.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack |
| `.env.example` | every setting; copy to `ops/.env` (gitignored) |
| `Dockerfile.node` | api, reporting, migrate and seed (`node:22`, runs TypeScript via tsx, non-root) |
| `Dockerfile.go` | multi-stage build of `apps/settlement` into a small non-root alpine image |
| `Dockerfile.web` | builds apps/web and apps/admin, serves them from nginx |
| `nginx.conf` | port 8080 = web, 8081 = admin; both proxy `/v1/` to the api (`/v1/admin/` only on 8081), no framing, CSP |

The api has no CORS support, so the dashboards must reach it on their own
origin. nginx (and the Vite dev servers, via `API_PROXY_TARGET`) proxy `/v1`
for that reason. Session cookies are host-scoped, so the web and admin ports
share one host without interfering (merchant and admin cookies have
different names).

## Database

Every service and job connects as the `filspay` role with the same
`DATABASE_URL`. Postgres is published on `127.0.0.1` only. `sslmode=disable`
is acceptable because the connection never leaves the compose bridge
network.

`PGCONN_SETTLEMENT` is not set by compose. If you set it, it **overrides**
`DATABASE_URL` for the settlement service (see
`apps/settlement/internal/config/config.go`), so leave it unset unless you
mean to point settlement at a different database.

## Settings per service

| Service | Setting | Notes |
|---|---|---|
| all | `DATABASE_URL` | built from `POSTGRES_PASSWORD` |
| api | `NODE_ENV` | `development` by default; `production` turns on every check below |
| api, settlement | `SETTLEMENT_INTERNAL_TOKEN` | shared bearer token; dev default is rejected in production |
| api | `WEBHOOK_SECRET_ENCRYPTION_KEY` | base64 of 32 bytes; required in production |
| api | `ACQUIRER_CALLBACK_SIGNING_SECRET` | required in production |
| api | `COOKIE_SECURE` | defaults to `true` in production; needs https |
| api | `OTP_DEV_EXPOSE` | demo only, see `.env.example` |
| api, web | `PUBLIC_WEB_URL` | checkout links and the web build's base URL |

## Resource sizing

The api container is limited to 512 MB. The Go and frontend images are
multi-stage, so build caches stay in the builder layers. On a small disk run
`docker builder prune` after the first build.
