# Architecture

## The shape

```
  Browser
     │  same-origin fetch to /api/proxy/*
     ▼
  Next.js server ──────────────────────────────┐
     │  app/api/proxy/[...path]/route.ts       │  renders the console UI
     │  adds CSRF header, forwards cookies     │
     ▼                                         │
  Fastify API  ◄────────────────────────────────┘
     │
     ├── auth        session resolution, SSO exchange, MFA enforcement
     ├── rbac        permission × environment decisions
     ├── audit       hash-chained append-only trail
     ├── security    AES-256-GCM secret envelope, CSRF, rate limiting
     ├── providers   digitalocean · proxmox · prometheus · alertmanager
     │               redis · docker · databases
     └── services    applications · deployments · logs · operations
                     dashboard · users · settings
     │
     ├──► console PostgreSQL   users, roles, audit, registries, history
     ├──► console Redis        cache, rate-limit counters
     └──► managed targets      per-connection pools, read-only by default
```

## Why the browser never talks to the API directly

Everything the console does goes through `/api/proxy/*` on the Next.js origin.
That single decision buys four things:

1. **The API needs no public route.** It can sit on an internal network where the
   browser cannot reach it, so a stolen browser session cannot be replayed
   against the API from outside.
2. **The session cookie stays same-origin and httpOnly.** No cross-origin cookie
   configuration, no `SameSite=None`.
3. **One place applies CSRF.** The proxy attaches the double-submit header and
   drops hop-by-hop headers. A route cannot forget to do it.
4. **No credential is ever in reachable memory.** DigitalOcean tokens, Proxmox
   tokens and database passwords exist only inside the API process (rule 1).

The proxy rebuilds the path from validated segments rather than concatenating,
so a crafted path cannot escape the `/api/v1` prefix.

## Layer responsibilities

### `packages/types`

The domain vocabulary, and — importantly — the two registries the backend
enforces:

- `PERMISSIONS` and `ROLE_DEFINITIONS`: the permission catalogue and the role
  bundles. The database is *synced from* these by the seed, so the schema can
  never drift from what the code checks.
- `OPERATION_DEFINITIONS`: every operation the console can perform, with its
  required permission, its production permission, the environments it is allowed
  in at all, and whether it needs typed confirmation or a second approver.

Adding a capability means adding it here first. Nothing outside this file can
invent an operation.

### `packages/config`

`loadConfig()` parses and validates `process.env`, then applies cross-field rules
that a schema alone cannot express — production must not enable local login, a
disabled Proxmox TLS check requires an explicit CA path, CORS must not include
localhost in production. It throws rather than returning a partial config: a
console that boots half-configured is worse than one that refuses to start.

### `apps/api/src/rbac`

The authorisation core. One function matters:

```ts
can(user, permission, environment)   // permission AND environment must both pass
```

A developer holding `application.restart` still cannot restart a production
service, because `developer` does not list `production` among its environments.
`authoriseOperation` adds two more gates: whether the operation is permitted in
that environment *at all*, and whether production requires a second permission.

### `apps/api/src/audit`

Every privileged action writes one event. Each row stores an HMAC over its
canonical content plus the previous row's hash, taken under a Postgres advisory
lock so the chain stays linear under concurrency. Editing or deleting a row
breaks verification, which `/api/v1/audit/verify` reports with the first broken
sequence number. Triggers reject `UPDATE` and `DELETE`, and the application's
database role is granted only `INSERT` and `SELECT`.

### `apps/api/src/providers`

One directory per external system, each split the same way:

```
digitalocean/
  types.ts     wire shapes — only the fields the console reads
  client.ts    named endpoint methods; no generic passthrough
  mapper.ts    wire → domain, including environment resolution
  service.ts   caching, environment filtering, allowlisted actions, health
```

`ProviderHttpClient` handles timeout, retry, error classification and redaction
uniformly, so an outage looks the same whichever provider caused it.

### `apps/api/src/providers/databases`

The Database Manager backend, in four parts:

- `query-classifier.ts` — decides the *category* of a statement (READ / WRITE /
  DDL / DESTRUCTIVE / UNKNOWN), failing closed on anything it does not recognise.
- `policy.ts` — decides whether that category is *permitted* for this user, on
  this connection, right now.
- `connection-manager.ts` — per-target pools, credential decryption at the moment
  of use, and a public projection that omits every credential column.
- `query-executor.ts` / `data-browser.ts` — execution under session guards, with
  row caps, statement timeouts and history recording.

### `apps/api/src/services/operations.ts`

The single chokepoint for every state change. Its contract:

1. The request names an operation **key** from a fixed list. No field can carry a
   command, script, path or provider payload.
2. The target is re-resolved server-side and its environment read from the
   resolved resource — never from the request.
3. If the claimed environment disagrees with the resolved one, the operation is
   refused and the mismatch is audited (rule 12).
4. Authorisation, typed confirmation and reason requirements are checked before
   any provider call.
5. Success, failure and refusal all produce an audit event.

## Request flow: a droplet reboot

```
Browser: POST /api/proxy/operations
         { key: "reboot_droplet", resourceId: "12345", environment: "production",
           confirmation: "prod-droplet-01", reason: "..." }
   │
Next proxy: attaches CSRF header, forwards cookie, rewrites path
   │
API preHandler: CSRF check → session resolution → MFA check → idle timeout
   │
operations.execute:
   ├─ resolveTarget → digitalocean.getDroplet
   │     └─ listDroplets filtered by the caller's visible environments
   │        (a droplet the operator cannot see returns 404, not 403)
   ├─ claimed environment === resolved environment?      else refuse + audit
   ├─ authoriseOperation(user, key, environment)         else refuse + audit
   ├─ assertConfirmation("prod-droplet-01", provided)    else refuse + audit
   ├─ production + non-trivial impact → reason required
   ├─ digitalocean.executeDropletAction  (write-scoped token only)
   ├─ invalidate the inventory cache
   ├─ audit.record(SUCCESS, with the provider action id)
   └─ operation_records insert
   │
Browser: { accepted: true, status: "in_progress", auditEventId, providerActionId }
```

## Environment as a first-class concept

Every resource resolves to exactly one of `development`, `testing`, `staging`,
`production`. Resolution is by provider tag (`env:production`), falling back to a
naming convention for Proxmox guests.

**An unresolvable resource is treated as production.** That is deliberate: an
untagged droplet inherits the strictest guardrails rather than the loosest. The
cost is that an untagged development box looks like production until it is
tagged; the alternative cost is a production box treated as development.

## Caching and degradation

Provider responses are cached briefly in-process (inventory 30–45s, metrics 20s,
health 15s). `TtlCache.wrap` supports `fallbackToStale`, so a provider outage
serves last-known-good data with its age, and the UI says so rather than showing
an empty page.

`TtlCache.set` refuses a value whose redacted form differs from the original,
which catches accidental caching of secret-bearing objects.

## Two databases, two access styles

The API talks to PostgreSQL in two completely separate ways, and the split is
load-bearing.

**The console's own database** — users, roles, sessions, audit, connections,
applications, deployments, logs, settings — is reached **only through Drizzle**.
`src/db/schema.ts` is the source of truth for its shape, `src/db/drizzle.ts`
exposes the single `orm()` handle, and every query in the codebase goes through
the query builder. `src/db/pool.ts` owns the `pg` pool that Drizzle wraps and
exports no query helper, because a raw escape hatch there is how a codebase ends
up half-converted. A lint rule blocks importing `pg` anywhere else.

Where SQL outruns the builder — filtered aggregates, `pg_advisory_xact_lock`,
`to_tsvector`, the production-first environment ordering — the `sql` template is
used *inside* a Drizzle query, so values stay parameterised. `sql.raw` appears
exactly twice, in the migration and seed runners, where the input is a `.sql` file
in this repository and DDL cannot be parameterised anyway.

**External PostgreSQL targets** — the databases an operator inspects through the
Database Manager — use the **raw driver**, in `src/providers/databases`. This is
not an inconsistency:

- Their schemas are unknown. An ORM's value is compile-time knowledge of a schema;
  there is none to have here.
- The statements are operator-supplied. They pass the classifier and the write
  policy, then execute as text — there is no model to map them onto.
- The session needs driver-level control: `BEGIN READ ONLY`,
  `default_transaction_read_only`, `statement_timeout`, per-target pool caps.

Console metadata *about* those targets — the connection registry, write windows,
query history — is Drizzle like everything else. Only the target connection
itself is raw.

## What is deliberately absent

| Not present | Why |
| --- | --- |
| `POST /execute` or any shell endpoint | Rule 2. There is no code path from a request to a process. |
| Container exec | Rule 3. Only start, stop, restart and log reads exist. |
| Provider API passthrough | A passthrough is a credential-shaped hole; callers name endpoints instead. |
| PromQL from the browser | Arbitrary expressions can read any series and cost a full scan. Presets only. |
| Raw SQL in the data browser | Filters are structured and validated against the table's real columns. |
| Production schema changes | Migrations are the reviewed path. The console refuses DDL on production. |
| Redis key manipulation | Reporting has an operational need; a production key editor does not. |
| Kubernetes | Not warranted at this scale (spec §4). |
