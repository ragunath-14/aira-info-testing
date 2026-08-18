# Setup

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | 20.11+ (22 recommended) | The lockfile is generated with npm 10. |
| PostgreSQL | 14+ | For the console's own database, not the ones it monitors. |
| Redis | 7+ | Optional. Without it, rate limiting is per-process. |
| Docker | 24+ | Only if you want container status or the compose deployment. |

## 1. Install and create the environment file

```bash
npm install
cp .env.example .env
```

## 2. Generate the three required keys

The console refuses to start without these. They are independent on purpose: one
key alone should not let an attacker both read secrets and forge history.

```bash
openssl rand -base64 32   # ENCRYPTION_KEY   — must decode to exactly 32 bytes
openssl rand -base64 32   # AUDIT_LOG_SECRET — HMAC key for the audit chain
openssl rand -base64 48   # SESSION_SECRET   — signs session cookies
```

**`ENCRYPTION_KEY` is not rotatable in place.** It is the key for every stored
provider token and database password. Changing it makes existing ciphertext
undecryptable, and the console will report *"stored credential could not be
decrypted; it may need re-entering after a key rotation"* rather than failing
silently. To rotate: re-enter each database connection's password and each
provider token after the change. Back the old key up somewhere you can retrieve
it before you change it.

## 3. Create the database

```bash
createdb airaos_console
```

Set `DATABASE_URL` in `.env`, then:

```bash
# Shared packages must be compiled before the API can run.
npm run build -w @airaos/types
npm run build -w @airaos/config
npm run build -w @airaos/validation

npm run migrate -w @airaos/api
npm run seed -w @airaos/api            # RBAC + policy defaults, safe everywhere
```

The seed's RBAC sync generates roles, permissions and their mapping from
`@airaos/types`. Run it after any deploy that changes the permission catalogue, or
the database will describe a different set of roles than the code enforces.

### Development data

```bash
npm run seed -w @airaos/api -- --demo
```

This adds a sample application registry and a local operator. It refuses to run
with `NODE_ENV=production`. The default password is printed by the command; set
`SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` to choose your own.

## 4. Run it

```bash
npm run dev          # API on :4000, web on :3000
```

Open <http://localhost:3000>. With `LOCAL_AUTH_ENABLED=true` you get the
development login form; otherwise you get the AIRAOS SSO button.

## Authentication

### Development

```env
LOCAL_AUTH_ENABLED=true
AUTH_REQUIRE_MFA=false
```

Local login is protected three ways so it cannot leak into production:
`loadConfig` refuses to boot with it enabled when `NODE_ENV=production`, the route
is not registered when it is unavailable, and the handler re-checks at request
time.

### Production — AIRAOS SSO

```env
LOCAL_AUTH_ENABLED=false
AIRAOS_AUTH_URL=https://auth.airaos.example
AIRAOS_AUTH_CLIENT_ID=infra-console
AIRAOS_AUTH_SECRET=...
AIRAOS_AUTH_ISSUER=https://auth.airaos.example
AIRAOS_AUTH_JWKS_URL=https://auth.airaos.example/.well-known/jwks.json
AUTH_REQUIRE_MFA=true
```

Register the console in AIRAOS with:

- **Redirect URI**: `https://console.airaos.example/auth/callback`
- **Grant type**: authorization code with PKCE
- **Scopes**: `openid profile email airaos.roles`

The flow is standard OIDC: the console redirects, receives a code, and exchanges
it server-side. It never sees a password, and the browser never holds a token.

MFA is enforced from the ID token's `amr` or `acr` claims, not from a query
parameter. `amr` containing `mfa`, `otp` or `hwk` counts, as does any two distinct
factors, as does an `acr` ending in `/loa2` or `/loa3`.

### Roles on first login

An operator's console role can be bootstrapped from an `airaos_roles`, `roles` or
`groups` claim, but **only when they hold no role yet**. After that the console's
own grants (Security → Users) are authoritative, so revoking a role is not
silently undone at the next sign-in. Unknown claim values are dropped rather than
mapped to something permissive.

A user with no role can authenticate but gets a clear message rather than an empty
console. Grant the first owner directly:

```sql
INSERT INTO user_roles (user_id, role_key)
SELECT id, 'owner' FROM users WHERE email = 'you@airaos.example';
```

## Provider credentials

### DigitalOcean

Two tokens, and the split matters:

```env
DIGITALOCEAN_API_TOKEN=dop_v1_...        # read scope — all monitoring
DIGITALOCEAN_WRITE_API_TOKEN=dop_v1_...  # write scope — power actions only
```

Omit the write token and droplet actions are **refused**, not silently downgraded
to the read token. That is how you run a genuinely read-only console.

See [digitalocean.md](digitalocean.md) for scoping and environment tagging.

### Proxmox

```env
PROXMOX_API_URL=https://proxmox.internal:8006/api2/json
PROXMOX_TOKEN_ID=console@pve!infra
PROXMOX_TOKEN_SECRET=...
PROXMOX_TLS_REJECT_UNAUTHORIZED=true
PROXMOX_CA_CERT_PATH=/etc/ssl/certs/proxmox-ca.pem
```

Use a scoped API token, never root password auth. In production, disabling TLS
verification requires `PROXMOX_CA_CERT_PATH` — `loadConfig` rejects the
combination of `PROXMOX_TLS_REJECT_UNAUTHORIZED=false` and no CA path, because
that is an unverified TLS session dressed up as a configuration choice.

See [proxmox.md](proxmox.md) for the exact token permissions.

### Monitoring

```env
PROMETHEUS_URL=http://prometheus:9090
ALERTMANAGER_URL=http://alertmanager:9093
GRAFANA_URL=https://grafana.airaos.example
```

Grafana is linked to, not embedded, so no Grafana credential is needed for the
console to work.

### Containers (optional)

```env
DOCKER_SOCKET_PATH=/var/run/docker.sock
DOCKER_ALLOWED_CONTAINERS=airaos-api,airaos-web,airaos-worker
```

Setting the socket without an allowlist is a **startup error**. A console with
blanket container control is exactly what security rule 3 forbids, so the
configuration refuses to express it.

## Database connections

Managed targets are registered in the UI (Database → Connections) by a user with
`database.admin`, or by API:

```bash
curl -X POST https://console.airaos.example/api/proxy/databases/connections \
  -H 'content-type: application/json' \
  -H "x-airaos-csrf: $CSRF" -b "$COOKIES" \
  -d '{
    "name": "Production",
    "environment": "production",
    "provider": "digitalocean_managed",
    "host": "db.internal", "port": 25060,
    "database": "airaos", "username": "console_ro",
    "password": "...", "sslMode": "verify-full"
  }'
```

The password is encrypted with AES-256-GCM, bound to the connection's row id, and
never returned by any endpoint.

### Give the console its own database user

Do not point the console at a superuser. Create a read-only role per target:

```sql
CREATE ROLE console_ro LOGIN PASSWORD 'strong-random-value';
GRANT CONNECT ON DATABASE airaos TO console_ro;
GRANT USAGE ON SCHEMA public TO console_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO console_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO console_ro;

-- Optional: enables slow-query counts on the connection status card.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
GRANT pg_read_all_stats TO console_ro;
```

With a read-only database user, production read-only is enforced twice: by the
console's policy layer and by PostgreSQL itself. That is the recommended setup —
if you need a write window later, register a second connection with a role that
has the grants, rather than widening this one.

## Verify the install

```bash
curl -s localhost:4000/health | jq
```

`status` is `ok` when the console database is reachable and every configured
provider answers, `degraded` when a provider is unreachable, and `error` only when
the console's own database is down. An unconfigured provider shows as `skipped`,
never as healthy.

Then in the UI: Monitoring → Health lists every subsystem and, importantly, the
ones that did not report.

## Configuration reference

`loadConfig` enforces these cross-field rules and refuses to start otherwise:

| Rule | Reason |
| --- | --- |
| `LOCAL_AUTH_ENABLED` must be false in production | Development login is not an authentication method for production. |
| SSO must be configured in production | Otherwise there is no way to sign in at all. |
| At least one auth method must be configured | A console nobody can enter is a misconfiguration, not a secure state. |
| `CORS_ORIGINS` must not include localhost in production | A localhost origin in production is almost always a copy-paste error. |
| `SESSION_IDLE_TIMEOUT_MINUTES` ≤ `SESSION_TTL_MINUTES` | An idle timeout longer than the session is meaningless. |
| `PROXMOX_API_URL` requires both token fields | A half-configured provider fails at first use instead of at boot. |
| Disabled Proxmox TLS verification requires a CA path | Makes the trust decision explicit. |
| `ENCRYPTION_KEY` must decode to 32 bytes | AES-256 requires it; a short key would silently weaken every stored secret. |

Every value is documented inline in [`.env.example`](../.env.example).
