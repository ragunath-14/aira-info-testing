# AIRAOS Infra Console

An internal infrastructure control plane for the AIRAOS estate: one authenticated
interface that answers *what is running, where, is it healthy, what changed, what
is failing, what was deployed, what is happening in the database* — and lets an
operator take a small set of safe, audited actions.

It is **not** a general server-management tool. There is no shell, no container
exec, no arbitrary API passthrough, and no way to run an unrecognised SQL
statement. Those omissions are the design, not gaps.

```
                         AIRAOS INFRA CONSOLE
                                  │
        ┌─────────────────────────┼──────────────────────────┐
   DIGITALOCEAN                PROXMOX                  APPLICATIONS
   Production droplets      Physical VMs / LXC          AIRAOS services
        └─────────────────────────┼──────────────────────────┘
                           MONITORING LAYER
                    Prometheus · Grafana · Alertmanager
                                  │
                      PostgreSQL · Redis · Audit
                                  │
                          DATABASE MANAGER
                    controlled, DBeaver-style access
```

## What it does

| Area | Capability |
| --- | --- |
| DigitalOcean | Droplet inventory, metrics, volumes, firewalls, snapshots, backup state, allowlisted power actions |
| Proxmox | Cluster and node health, VM/LXC inventory, storage, snapshots, backup state from the vzdump log, allowlisted lifecycle actions |
| Applications | Registry, health probes, container status, dependency health, versions and commits |
| Deployments | Recorded releases with a production approval gate; CI performs the rollout |
| Monitoring | Prometheus summaries from a fixed preset catalogue, Grafana deep links, Alertmanager alerts with ownership |
| Logs | Search, filter, live tail and export, with secret redaction on ingest and read |
| Database | Connections, schema explorer, structure viewer, data browser, SQL editor, query history — production read-only by default |
| Redis | Memory, hit rate, evictions, keyspace. Reporting only |
| Connections | One place to configure DigitalOcean, Proxmox, PostgreSQL, Redis, Prometheus and Grafana — test before save, encrypted at rest, no `.env` editing |
| Security | AIRAOS SSO with MFA, role-based access scoped per environment, hash-chained audit trail |

The console's own database is accessed entirely through [Drizzle ORM](https://orm.drizzle.team);
external PostgreSQL targets use the raw driver, because their schemas are unknown.
See [architecture.md](docs/architecture.md#two-databases-two-access-styles).

## Quick start

Requires Node 20.11+ (22 recommended), PostgreSQL 14+, and optionally Redis.

```bash
npm install
cp .env.example .env
```

Generate the three keys the console refuses to start without:

```bash
printf 'ENCRYPTION_KEY=%s\nAUDIT_LOG_SECRET=%s\nSESSION_SECRET=%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" "$(openssl rand -base64 48)"
```

Then set `DATABASE_URL`, leave `LOCAL_AUTH_ENABLED=true` for development, and:

```bash
npm run build -w @airaos/types && npm run build -w @airaos/config && npm run build -w @airaos/validation
npm run migrate -w @airaos/api
npm run seed -w @airaos/api -- --demo
npm run dev
```

Then add your infrastructure under **Settings → Connections** — provider
credentials no longer belong in `.env`. If you already have them there, migrate:

```bash
npm run connections:import -- --apply
```

The console is at <http://localhost:3000>. The demo seed creates
`admin@airaos.local` with the password printed by the seed command — change it
immediately, and never enable local auth outside development.

Full setup, including SSO and provider credentials, is in [docs/setup.md](docs/setup.md).

## Repository layout

```
apps/
  api/          Fastify API — the only component that holds credentials
  web/          Next.js console, talks to the API through a same-origin proxy
packages/
  types/        Domain types, the permission catalogue, the operation registry
  validation/   Zod schemas shared by the API and the web forms
  config/       Validated environment loading; fails fast on a bad config
  ui/           Tailwind preset and design tokens
database/       Forward-only migrations and seeds
monitoring/     Prometheus, Alertmanager and Grafana provisioning
docker/         Images and a single-host compose file
docs/           Architecture, setup, security, runbook and per-provider guides
```

## Security posture

Twelve rules govern this codebase. They are stated in full, with the code that
enforces each one, in [docs/security.md](docs/security.md). In short:

- Infrastructure credentials never leave the API process, and never reach a
  browser.
- There is no shell execution and no container exec. Operations come from a fixed
  allowlist, each mapped to one known routine.
- Production databases are read-only by default; a write needs an explicit,
  time-boxed, audited window, and production schema changes are refused outright.
- Every privileged action — including every refusal — is recorded in a
  hash-chained audit trail that the console can verify on demand.
- The frontend hides what an operator cannot use; the backend independently
  re-derives every permission on every request.

## Verifying a change

```bash
npm run typecheck                    # every workspace
npm run lint                         # includes checks for banned imports
npm run test:unit -w @airaos/api     # 185 tests: classifier, RBAC, crypto, redaction, mappers, emitted SQL
npm run test:security -w @airaos/api # write policy and refusal paths
npm run build                        # API + web production builds
```

Integration tests need real services and are opt-in — see
[apps/api/tests/integration/README.md](apps/api/tests/integration/README.md).

## Documentation

| Document | Contents |
| --- | --- |
| [architecture.md](docs/architecture.md) | Layers, request flow, why the proxy exists |
| [connections.md](docs/connections.md) | The Connection Manager: types, testing, resolution order, `.env` migration |
| [setup.md](docs/setup.md) | Environment, keys, provider credentials, first run |
| [development.md](docs/development.md) | Working in the repo, conventions, adding a provider or operation |
| [deployment.md](docs/deployment.md) | Images, compose, promotion path, rollback |
| [security.md](docs/security.md) | The twelve rules and where each is enforced |
| [digitalocean.md](docs/digitalocean.md) | Token scoping, environment tagging, metrics caveats |
| [proxmox.md](docs/proxmox.md) | API token setup, TLS, permitted operations |
| [database-manager.md](docs/database-manager.md) | Classification, write windows, limits |
| [monitoring.md](docs/monitoring.md) | Exporters, presets, alert conventions |
| [troubleshooting.md](docs/troubleshooting.md) | Symptoms, causes, fixes |
| [runbook.md](docs/runbook.md) | Operational procedures and incident response |

## Scope

V1 is monitoring-first: infrastructure visibility, application health, controlled
database inspection, and a small set of safe operations. It does not attempt to
be a cloud provider console, a Kubernetes dashboard, a DBeaver replacement, a
Grafana replacement, or a terminal.
