# Deploying FilsPay (Dilmune Cloud)

The stack is one compose file, so any Dilmune offering that runs Docker works.
Two shapes are covered: a VM with Docker (simplest), or a container platform.

## Sizing

The old demo box (0.5 vCPU / 2 GB RAM / 2 GB disk) is too small to *build*
on. Either use at least 1 vCPU / 2 GB RAM / 10 GB disk, or build the images
elsewhere and push them to a registry (see the last section).

## Option A: a VM with Docker

1. Create an Ubuntu VM, open inbound **80/443 only** (plus 22 for SSH from
   your IP). Do not open 5432, 3000 or 8091; compose keeps them on loopback
   or the internal network anyway.
2. Install Docker Engine + the compose plugin, then:

   ```
   git clone <repo> filspay && cd filspay/ops
   cp .env.example .env
   ```

3. Fill in `ops/.env`:

   ```
   NODE_ENV=production
   POSTGRES_PASSWORD=$(openssl rand -hex 24)
   SETTLEMENT_INTERNAL_TOKEN=$(openssl rand -hex 32)
   WEBHOOK_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)
   ACQUIRER_CALLBACK_SIGNING_SECRET=<from the acquirer; NOT the old sandbox one>
   PUBLIC_WEB_URL=https://pay.example.bh
   OTP_DEV_EXPOSE=true        # demo only: there is no email/SMS provider yet
   ```

   `POSTGRES_PASSWORD` is applied only when the volume is first created;
   changing it later needs `ALTER ROLE` inside Postgres.

4. `docker compose up -d --build`, then check `docker compose ps`: `migrate`
   should show `Exited (0)` and the api `healthy`.

5. Put TLS in front. With `NODE_ENV=production` cookies are `Secure`, so
   login does not work over plain http. Caddy on the VM is the shortest path:

   ```
   pay.example.bh {
       reverse_proxy 127.0.0.1:8080
   }
   admin.pay.example.bh {
       reverse_proxy 127.0.0.1:8081
   }
   ```

   The web ports are already bound to loopback by default (`WEB_PORT`,
   `ADMIN_PORT`), so only Caddy faces the internet. Set `TRUST_PROXY_HOPS=2`
   (Caddy, then nginx) so session records carry the client's address, not
   the proxy's. With two hostnames, merchant and
   admin cookies are fully separate. Admin impersonation sets its cookie
   from the admin host, so if you rely on impersonation, serve both sites
   from the same host (e.g. the admin on a path or a port behind the same name).

   Only for a throwaway http-only demo: `COOKIE_SECURE=false`.

## Option B: a managed container platform

Build and push the four images, then recreate the compose services there:

| Image | Dockerfile | Command | Needs |
|---|---|---|---|
| node | `ops/Dockerfile.node` | `npm run migrate` (one-off job, run first) | `DATABASE_URL` |
| node | `ops/Dockerfile.node` | `npx tsx apps/api/src/index.ts` | api settings from `.env.example`, a persistent volume at `/app/data/kyc` |
| node | `ops/Dockerfile.node` | `npx tsx apps/reporting/src/index.ts` | `DATABASE_URL` |
| settlement | `ops/Dockerfile.go` | `./settlement daemon` | `DATABASE_URL`, `SETTLEMENT_INTERNAL_TOKEN` |
| web | `ops/Dockerfile.web` (build arg `PUBLIC_WEB_URL`) | nginx | api reachable as `api:3000` |

Build context is the repository root for all of them. A managed Postgres 16
works; use `sslmode=require` in `DATABASE_URL` if it is not on a private
network. The api must reach settlement at `SETTLEMENT_INTERNAL_URL`
(default `http://settlement:8091`); never expose 8091 publicly.

If the platform has its own ingress, nginx in the web image can be replaced
by any router that serves the two static builds and forwards `/v1/` to the
api with `X-Forwarded-*` headers.

## After deploying

- `curl https://pay.example.bh/healthz` and `/readyz` (proxied to the api).
- Demo data: `docker compose --profile seed run --rm seed` refuses
  `NODE_ENV=production`; create merchants through signup instead, or seed
  a separate non-production instance.
- Backups: `docker compose exec postgres pg_dump -U filspay filspay`.
