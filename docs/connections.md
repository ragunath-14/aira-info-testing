# Connection Manager

**Settings → Connections** is where every infrastructure integration is configured.
Adding a connection there is all that is required — the dashboards pick it up
automatically. No `.env` editing, no per-module setup, no restart.

## Supported types

| Type | Reached over | Credential |
| --- | --- | --- |
| DigitalOcean | DigitalOcean REST API | read token, optional write token |
| Proxmox | Proxmox VE REST API | scoped API token |
| PostgreSQL | PostgreSQL wire protocol | password |
| Redis | Redis protocol | optional password |
| Prometheus | Prometheus HTTP API | optional basic auth |
| Grafana | Grafana HTTP API | optional API token |

**There is no SSH type, deliberately.** Each system is reached over its own native
protocol. SSH would be a general-purpose remote shell — precisely what security
rule 2 forbids — and none of the above needs it.

## Adding a connection

1. **Settings → Connections → Add connection.**
2. Pick a type. Only that provider's fields are shown.
3. Fill them in and press **Test connection**.
4. Save is disabled until a test succeeds. A saved connection that has never
   connected is a trap for whoever relies on it next, so the flow refuses to
   create one.

A successful test reports something recognisable, so you can tell you connected to
the right place:

```
✓ Connection successful

Nodes      2 online / 3 total
TLS        verified
Cluster    airaos-pve (quorate)
Latency    42 ms
```

Tests are deliberately cheap (spec §30): `/account` for DigitalOcean, `/nodes` for
Proxmox, `PING` plus one `INFO` section for Redis, `count(up)` for Prometheus,
`/api/health` for Grafana, and three catalog queries for PostgreSQL. None of them
puts load on a production system.

## Status

| Status | Meaning |
| --- | --- |
| **Connected** | The last probe succeeded cleanly. |
| **Degraded** | Reachable, but the probe reported a caveat — Prometheus scraping nothing, Redis refusing `INFO`, a token without droplet scope. |
| **Offline** | The last probe failed. The reason is shown on the card. |
| **Not tested** | Never probed, or the configuration changed since the last probe. |

`Not tested` is never rendered as healthy. Changing a connection's configuration or
credential resets it to `not tested`, because the previous result no longer
describes what is stored.

## How credentials are handled

- Sealed with AES-256-GCM before storage, with the connection's row id as
  associated data — so a stolen ciphertext cannot be pasted into a different
  connection to point the console at another host.
- Never returned by any endpoint. `connections_public` (the view every read path
  uses) has no credential column, and the `Connection` type has no field for one.
- On edit, secret inputs start blank. Type a value only to replace it; leaving it
  blank keeps what is stored.
- Every add, edit, test, enable, disable and delete is audited, and a credential
  replacement is recorded as `CHANGE_CONNECTION_CREDENTIAL` so it is findable.

`ENCRYPTION_KEY` decrypts every stored credential. Rotating it means re-entering
each connection's secret — see [security.md](security.md#rule-7--no-plaintext-secrets-at-rest).

## Resolution order

When a provider needs its configuration, the resolver checks, in order:

1. An **enabled connection** in the Connection Manager, preferring an exact
   environment match.
2. The matching **`.env` variables**.
3. Nothing — the provider reports "not configured" and the UI says so rather than
   showing an empty dashboard.

Step 2 is why this change does not break an existing install: an instance still
configured through `.env` keeps working untouched. The Connections page shows which
providers are still on environment variables and suggests migrating them.

Resolved configurations are cached in-process for 15 seconds. They contain
decrypted secrets, so that cache is never written to Redis or logged, and it is
cleared the moment a connection changes — which is why a save takes effect almost
immediately without a restart.

## Migrating from .env

```bash
npm run connections:import               # dry run: reports what it would create
npm run connections:import -- --apply    # writes them
```

The command tests each candidate before writing it, skips types that already have a
connection for that environment (so it is safe to re-run), and never prints a
secret. Your `.env` variables are left in place as the fallback; remove them once
you have confirmed the console works.

PostgreSQL is not part of the import: database targets have always lived in their
own table with write policy attached.

## Environments

Every connection has an environment, and it is **immutable after creation** —
environment drives the guardrails, so moving a connection between environments
would silently change what is permitted against it. Create a new connection
instead.

Production connections are visually marked throughout, and for PostgreSQL a
production connection is read-only by default regardless of the credential's own
grants. See [database-manager.md](database-manager.md#policy).

## Two connection tables

There are two, on purpose:

- **`connections`** — the Connection Manager. Everything above.
- **`database_connections`** — PostgreSQL targets for the Database Manager. These
  carry policy no other type has: read-only override, time-boxed write windows and
  query history.

The Connections page presents both under one list, so an operator sees one place to
configure things. Merging the tables would mean pushing database-only policy
columns onto every connection type.

## Adding a new provider

The core is provider-neutral, so a new type needs no changes to the routes, the
service, or the UI:

1. Add the type to `CONNECTION_TYPES` and `CONNECTION_TYPE_PRESENTATION` in
   `packages/types/src/connections.ts`.
2. Add its schema to `packages/validation/src/connections.ts` and include it in the
   discriminated union.
3. Create `apps/api/src/providers/<name>/` with the usual split, including a
   `testConnection(config)` that honours the contract in `providers/contract.ts`.
4. Register it in `apps/api/src/providers/registry.ts`.
5. Add its field list to `FIELDS` in `apps/web/features/connections/connection-form.tsx`.
6. Teach the resolver how to assemble its config, and how to read it from `.env` if
   that applies.

The Add Connection form renders from the field list, so no new component is needed.

AWS, GCP, Azure and Hetzner would each be an adapter plus a schema. None of them is
implemented, and none should be added speculatively.
