# Deployment

> **This document describes the Docker/self-hosted production path.** The
> current live Phase 1 test deployment runs on Render instead — see
> [render-deployment.md](render-deployment.md) for that setup, its test URL,
> and its testing/security/cost reports.

## Topology

```
Internet
   │  TLS terminated by Cloudflare / nginx / Caddy
   ▼
web (:3000, bound to 127.0.0.1)
   │  internal Docker network only
   ▼
api (no published port)
   │
   ├── console PostgreSQL
   ├── console Redis
   └── providers: DigitalOcean · Proxmox · Prometheus · Alertmanager · managed databases
```

Only the web service is reachable from outside, and only through a reverse proxy.
The API has no published port — that is what keeps infrastructure credentials off
the host's listening interfaces.

## Images

```bash
docker build -f docker/Dockerfile.api -t airaos-infra-api:1.0.0 .
docker build -f docker/Dockerfile.web -t airaos-infra-web:1.0.0 .
```

Both are multi-stage: dependencies installed once, workspace compiled, then only
production dependencies and build output copied into a slim runtime. Neither ships
a build toolchain. Both run as the `node` user under `tini`, so `SIGTERM` reaches
the graceful shutdown handler instead of being swallowed by npm.

The web image uses Next.js standalone output, so its runtime layer carries the
server bundle and traced dependencies only.

## Single-host deployment

```bash
cp .env.example .env    # fill in everything, including POSTGRES_PASSWORD
docker compose -f docker/docker-compose.yml --env-file .env up -d
```

Services: `postgres`, `redis`, `migrate` (runs once), `api`, `web`, `prometheus`,
`alertmanager`, `grafana`, `node-exporter`, `cadvisor`.

The `api` service waits for `migrate` to complete successfully, so a schema change
is applied before any code that depends on it starts.

### Reverse proxy

```nginx
server {
  listen 443 ssl http2;
  server_name console.airaos.example;

  # The console is internal. Restrict by source where you can.
  allow 10.0.0.0/8;
  deny all;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # The log tail is Server-Sent Events: buffering would hold events until close.
    proxy_buffering off;
    proxy_read_timeout 3600s;
  }
}
```

`X-Forwarded-For` matters: the API trusts it for the audit trail's IP field, and it
is configured on the assumption that only this proxy sets it. Do not expose the web
service directly.

## Promotion path

```
commit → CI (lint · typecheck · unit · integration · security · build)
   ↓
development  (automatic on merge to develop)
   ↓
testing
   ↓
staging
   ↓
manual approval — GitHub environment with required reviewers
   ↓
production
```

Production deployment is gated twice, deliberately:

1. **GitHub environment protection** — required reviewers on the `production`
   environment. A developer machine has no path to production; only the workflow
   has the credentials.
2. **The console's own approval** — a production deployment record is created in
   `awaiting_approval` and does not progress until a *different* authorised
   operator approves it. Enforced in the service layer, by the
   `deployments_approver_distinct` constraint, and by the
   `deployments_production_gate` trigger.

`.github/workflows/deploy.yml` also refuses a production release whose tag is not
an ancestor of `main`.

## Migrations in a deploy

Run the migrate container against the target database before rolling out:

```bash
docker run --rm \
  -e DATABASE_URL="$DATABASE_URL" \
  -e ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  -e AUDIT_LOG_SECRET="$AUDIT_LOG_SECRET" \
  -e SESSION_SECRET="$SESSION_SECRET" \
  airaos-infra-api:1.0.0 npx tsx apps/api/src/db/migrate.ts
```

Migrations are forward-only and refuse to re-apply a changed file, so this is safe
to run repeatedly. Write migrations to be backwards-compatible with the currently
running version — add a column, deploy code that writes it, then make it required
in a later migration. That is what makes a rollback possible without a database
restore.

After a deploy that changes the permission catalogue, re-run the seed's RBAC sync:

```bash
docker run --rm -e DATABASE_URL="$DATABASE_URL" ... airaos-infra-api:1.0.0 \
  npx tsx apps/api/src/db/seed.ts
```

## Health and readiness

| Endpoint | Use | Behaviour |
| --- | --- | --- |
| `/health/live` | Liveness probe | Process is up. Touches no dependency. |
| `/health/ready` | Readiness probe | 503 unless the console database is reachable — serving traffic without it would mean serving unaudited requests. |
| `/health` | Status page | Full report: `ok`, `degraded` (a provider is down) or `error` (own database is down). |

All three are unauthenticated so a load balancer can reach them, and therefore
deliberately sparse: no hostnames, no dependency versions, no error detail.

Wait for `/health/ready` before shifting traffic. A `degraded` status is not a
rollback trigger — it usually means a provider is having a bad minute.

## Scaling

The API is stateless apart from its in-process provider cache. To run more than one
replica, configure `REDIS_URL` — without it, rate limiting is per-process, which
means N replicas allow N times the intended request budget.

Each replica keeps its own provider cache, so two operators may briefly see
inventory a few seconds apart. That is acceptable for 30–45 second TTLs; if it ever
is not, move the cache to Redis rather than raising the TTL.

## Retention

```bash
docker run --rm -e DATABASE_URL="$DATABASE_URL" ... airaos-infra-api:1.0.0 \
  npx tsx apps/api/src/db/retention.ts
```

Run daily from cron. It trims the log buffer (14 days by default), application
health history (30 days) and expired sessions. It never touches `audit_events` or
`query_history` — those are the record of who did what, and the grants forbid
deleting from them anyway.

## Backups

Back up the console's own PostgreSQL. It holds the audit trail, role assignments
and encrypted credentials.

```bash
pg_dump --format=custom --file=airaos_console_$(date +%F).dump "$DATABASE_URL"
```

**A dump is useless without `ENCRYPTION_KEY`.** Store the key in a secret manager
with its own backup and access trail, separate from the database dumps. Restoring
the database with a lost key means re-entering every provider token and database
password.

Test a restore periodically, and verify the audit chain afterwards
(`/api/v1/audit/verify`) — that confirms the restore is intact, not merely present.

## Rollback

1. Redeploy the previous image tag for `api` and `web`.
2. Do **not** roll the database back unless the release included a
   non-backwards-compatible migration. Restoring the console database loses audit
   records for everything that happened since the dump.
3. Record the rollback in the console so the deployment history shows it.
4. Verify `/health` and the audit chain.

## Deploy checklist

- [ ] CI green on the exact ref being deployed
- [ ] Migrations reviewed and backwards-compatible with the running version
- [ ] `.env` complete on the target; the three keys present and unchanged
- [ ] `ENCRYPTION_KEY` backed up and retrievable
- [ ] Production deployment approved by a second operator in the console
- [ ] Reverse proxy passes `X-Forwarded-For` and has SSE buffering off
- [ ] `/health/ready` returns 200 after rollout
- [ ] Audit chain verifies
- [ ] Retention cron scheduled
