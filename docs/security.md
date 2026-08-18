# Security

This document states the twelve rules that govern the codebase and names the code
that enforces each one. If you change something here, change the enforcement, the
test, and this table together.

## The twelve rules

### Rule 1 — Infrastructure credentials never reach the browser

**Enforced by:**

- `apps/web/app/api/proxy/[...path]/route.ts` — the browser's only route to the
  API. The API can therefore live on a network the browser cannot address.
- `apps/api/src/providers/databases/connection-manager.ts` — `toPublic()` is the
  only projection that leaves the API. It omits `password_cipher` and
  `password_ref` entirely.
- `database/migrations/0009_grants.sql` — `database_connections_public` and
  `providers_public` views exist so a read path physically cannot select a
  credential column.
- `apps/api/src/services/settings.ts` — `runtimeSummary()` reports *whether* each
  secret is set, never its value.

**Verified by:** `tests/integration/console-database.test.ts` asserts the public
views carry no credential columns.

### Rule 2 — No unrestricted shell execution

There is no code path from an HTTP request to a process. `child_process` is not
imported anywhere, and the lint config bans it with an explanatory message.

**Enforced by:**

- `packages/types/src/operations.ts` — `OPERATION_KEYS` is the complete set of
  things the console can do. Eighteen keys, each mapped to one known routine.
- `packages/validation/src/operations.ts` — `operationRequestSchema` has no field
  that can carry a command, script or path. `metadata` accepts only strings,
  numbers, booleans and nulls.
- `.eslintrc.json` — `no-restricted-imports` on `child_process`.
- `.github/workflows/ci.yml` — greps for `child_process`, `execSync`, `spawnSync`
  and container exec paths, failing the build if any appear.

### Rule 3 — No unrestricted Docker exec

**Enforced by:** `apps/api/src/providers/docker/service.ts`. Only `inspect`,
`stats`, `logs`, `start`, `stop` and `restart` are implemented. There is no exec,
no create, no image pull, no volume access.

Every call passes through `assertAllowed()`, which checks
`DOCKER_ALLOWED_CONTAINERS` and returns **not-found** for an unlisted name — so
the console does not even confirm the existence of containers it may not touch.

`dockerConfig()` in `apps/api/src/config.ts` throws at startup if a socket path is
set without an allowlist.

### Rule 4 — Production databases default to read-only

**Enforced at four independent layers**, because this is the rule most likely to be
tested by accident:

1. `policy.ts` → `isReadOnlyByDefault()` returns true for production with no
   explicit override.
2. `policy.ts` → `evaluate()` refuses anything beyond READ without an open write
   window plus `database.admin`.
3. `connection-manager.ts` → read sessions are pooled with
   `default_transaction_read_only=on`.
4. `query-executor.ts` → reads additionally run inside `BEGIN READ ONLY`, so
   PostgreSQL itself refuses a misclassified write.

Production **schema** changes (DDL, DROP, TRUNCATE) are refused outright, window or
not. Migrations are the supported path.

`console_settings.database.production_read_only` cannot be turned off:
`settings.ts` → `updateSetting()` rejects the change with an explanation.

**Verified by:** `tests/security/policy.test.ts` (19 cases).

### Rule 5 — Production destructive actions require explicit authorisation

**Enforced by:** `packages/types/src/operations.ts` and
`apps/api/src/rbac/index.ts` → `authoriseOperation()`, which applies three gates:

1. Is the operation permitted in this environment at all?
   `power_off_droplet` and `stop_vm` are not available in production for anyone.
2. Does the user's role cover this environment?
3. For production, does the user hold the operation's `productionPermission`?

Plus, in `services/operations.ts`: typed confirmation of the resource name, and a
mandatory reason for any production operation with non-trivial impact.

### Rule 6 — Every privileged operation is audited

**Enforced by:** `apps/api/src/audit/service.ts`, called on every path in
`services/operations.ts` — success, failure **and** refusal.

Tamper evidence: each row stores an HMAC over its canonical content plus the
previous row's hash, appended under a Postgres advisory lock. `verifyChain()`
recomputes and reports the first broken sequence.

Immutability: triggers in `0002_audit.sql` reject `UPDATE` and `DELETE`; the
grants in `0009_grants.sql` give the application role only `INSERT` and `SELECT`.

One case uses `{ strict: true }`: opening a database write window. If that audit
write fails, the window is rolled back — an unaudited write window is precisely
what this rule forbids.

### Rule 7 — No plaintext secrets at rest

**Enforced by:** `apps/api/src/security/crypto.ts`. AES-256-GCM with a random
96-bit IV, and associated data binding each ciphertext to its row id — so a stolen
blob cannot be pasted into a different connection to redirect the console at
another host.

`AUDIT_LOG_SECRET` is separate from `ENCRYPTION_KEY` so neither key alone allows
both reading secrets and forging history.

Local development passwords use scrypt (N=16384, r=8, p=1).

**Verified by:** `tests/unit/crypto.test.ts` (21 cases, including AAD mismatch and
ciphertext tampering).

### Rule 8 — No secrets in git

**Enforced by:** `.gitignore` (`.env`, `.env.*` except the example, `*.pem`,
`*.key`, `secrets/`) and two CI checks: a grep for the credential shapes this
project uses, and an assertion that `.env` is untracked while `.env.example`
exists.

### Rule 9 — The frontend never bypasses RBAC

The frontend hides controls an operator cannot use. That is a courtesy, not a
control — and the code says so in comments where it matters, so nobody mistakes
`useSession().can()` for a security boundary.

### Rule 10 — The backend independently enforces every permission

Every route declares its permission via `app.requirePermission(...)`. Service
functions re-check rather than trusting the route. The operations endpoint
requires only a session at the route level and does the real authorisation inside
`execute()`, where the resolved resource's environment is known.

Roles are never read from a request. They come from `user_roles` in the console
database, resolved on every session lookup — so a revoked role takes effect within
one session refresh, not at next login.

### Rule 11 — Never trust a client-supplied environment or resource id

Every resolver re-reads the resource and takes its environment from the stored
record:

| Resource | Resolver | Behaviour |
| --- | --- | --- |
| Droplet | `digitalocean.getDroplet` | Filters by visible environments; invisible → 404 |
| Proxmox guest | `proxmox.getGuest` | Same, and the node comes from inventory |
| Application | `applications.requireApplication` | Environment from the registry row |
| Database connection | `connections.requireConnection` | Environment from the row |
| Deployment | `deployments.getDeployment` | Environment from the record |

Not-found and not-permitted deliberately return the same response, so ids cannot
be probed to discover what exists in another environment.

### Rule 12 — A developer must not hit production while aiming at staging

**Enforced by:**

- `services/operations.ts` compares the request's claimed environment against the
  resolved one and refuses on mismatch — with an audit event recording the
  attempt. A stale page cannot act on the wrong target.
- Typed confirmation compares the **exact** resource name after trimming, so
  confirming `airaos-api` when the target is `airaos-api-worker` fails.
- `EnvironmentBadge` and `EnvironmentBanner` use colour **and** an icon **and** a
  text label, so production is unmistakable in greyscale or with colour blindness.
- Unresolvable resources default to `production`, inheriting the strictest
  guardrails rather than the loosest.

## Transport and session security

| Control | Implementation |
| --- | --- |
| CSRF | Double-submit cookie plus header, checked in `security/plugins.ts` for every non-safe method. Origin is also validated against `CORS_ORIGINS`. |
| CORS | Explicit allowlist with credentials. No wildcard. |
| Headers | Helmet on the API; a strict CSP on the web app with no external hosts, `frame-ancestors 'none'` and `object-src 'none'`. |
| Rate limiting | 300/min globally, 30/min on operations, 10 per 5 min on local login. Redis-backed when available so limits hold across replicas. |
| Sessions | Opaque 32-byte token; only an HMAC of it is stored. Absolute TTL plus a sliding idle timeout. Revocation is immediate on role change or deactivation. |
| MFA | Enforced from `amr`/`acr` claims on every session resolution, not just at login. |
| Cookies | httpOnly, `SameSite=Lax` (SSO needs a top-level GET), `Secure` outside development. |

## Data handling

**Secret redaction** (`utils/redaction.ts`) runs on log fields, forwarded log
lines and audit metadata. It matches connection-string passwords, bearer and basic
credentials, JWTs, DigitalOcean and GitHub tokens, AWS key ids, Proxmox token
secrets, private key blocks, and `key=value` assignments. Log lines are redacted on
**both** ingest and read, so a line written before a pattern was added is still
protected.

**Query history** stores a literal-stripped preview. Full SQL is retained only for
statements that changed data — those need to be reconstructable during an
incident, whereas storing full `SELECT` text would mean keeping customer data in
the console's database.

**CSV export** escapes leading `=`, `+`, `-`, `@` and tab so opening a file in a
spreadsheet cannot execute a formula.

**Error responses** carry a stable code plus operator-facing prose. Stack traces,
provider payloads and credentials stay in the log. The single error boundary in
`app.ts` is the only place a response is shaped.

## SQL injection defence

Three layers, in the order they apply:

1. **Validation.** Identifiers must match `^[A-Za-z_][A-Za-z0-9_$]*$`.
2. **Catalog verification.** The data browser checks every column against the
   table's real column list read from `pg_attribute`. A column the table does not
   have is rejected — there is no path from client text to an unverified
   identifier.
3. **Quoting and binding.** Verified identifiers are quoted with PostgreSQL's own
   rules; every filter value is a bound parameter.

The classifier additionally refuses `pg_read_file`, `pg_ls_dir`, `lo_import`,
`dblink`, `pg_terminate_backend` and similar — functions that reach outside the
database.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Stolen browser session | httpOnly cookie, idle timeout, immediate revocation on role change, MFA re-checked per request |
| XSS in the console | Strict CSP with no external hosts; React escapes by default; no `dangerouslySetInnerHTML` |
| CSRF | Double-submit token plus origin validation |
| Compromised console host | Credentials are encrypted at rest with AAD binding; a scoped read token limits blast radius |
| Malicious insider | Hash-chained audit trail, environment-scoped RBAC, second approver for production deploys, no destructive production operations at all |
| SQL injection | Three-layer defence above |
| Data exfiltration | Row caps, per-target connection caps, export behind a separate permission, all exports audited |
| Provider credential theft | Read/write token split; write actions refused when no write token is configured |
| Audit tampering | HMAC chain, append-only triggers, restricted grants, on-demand verification |

## Reviewing a change

- Does it add a route? It must declare a permission and validate its input.
- Does it add an operation? It must be in `OPERATION_DEFINITIONS` with an
  environment allowlist and a production permission.
- Does it touch a credential? It must not appear in a response, a log, a cache or
  a setting.
- Does it query a managed database? Identifiers must be verified against the
  catalog and values must be bound.
- Does it change what the frontend shows? The backend must enforce the same thing
  independently.

## Reporting a vulnerability

Do not open a public issue. Contact the platform team directly with the request id
from the console if one is relevant, and preserve the database if the audit chain
is implicated.
