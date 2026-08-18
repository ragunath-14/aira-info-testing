# Troubleshooting

Every API response carries `x-request-id`, and the same id appears in the log line
and in the audit record. Quote it when reporting a problem — it makes the whole path
retrievable.

```bash
docker compose -f docker/docker-compose.yml logs -f api | grep <request-id>
```

## Startup

### The API exits immediately with "Invalid configuration"

`loadConfig` failed. The message lists every problem. Common ones:

| Message | Fix |
| --- | --- |
| `ENCRYPTION_KEY: Must be 32 random bytes, base64 encoded` | `openssl rand -base64 32` |
| `LOCAL_AUTH_ENABLED must be false when NODE_ENV=production` | Set it to false and configure SSO |
| `No authentication method configured` | Set `AIRAOS_AUTH_URL` or enable local auth for development |
| `CORS_ORIGINS must not include localhost in production` | Use the real console origin |
| `PROXMOX_API_URL is set but PROXMOX_TOKEN_ID / SECRET are missing` | Add both, or unset the URL |
| `PROXMOX_TLS_REJECT_UNAUTHORIZED=false requires PROXMOX_CA_CERT_PATH` | Trust the cluster CA explicitly |

This is intentional: a console that boots half-configured is worse than one that
refuses to start.

### "DOCKER_SOCKET_PATH is set but DOCKER_ALLOWED_CONTAINERS is empty"

A console with blanket container control is what security rule 3 forbids, so the
configuration will not express it. List the containers, or unset the socket.

### Migration aborts with "has changed after being applied"

Someone edited an applied migration. Restore the original file and add a new
migration instead — that message is the guard against schema drift between
environments.

## Authentication

### Redirected to /login in a loop

The session cookie is not surviving the round trip.

1. Is the console on HTTPS? Cookies are `Secure` outside development.
2. Does `APP_URL` match the browser's origin exactly, including scheme?
3. Is `CORS_ORIGINS` set to that origin?
4. Is the reverse proxy forwarding cookies?

### "Your AIRAOS account is not yet assigned a console role"

Authenticated but not authorised. An owner grants the role in Security → Users. For
the very first owner:

```sql
INSERT INTO user_roles (user_id, role_key)
SELECT id, 'owner' FROM users WHERE email = 'you@airaos.example';
```

### "This console requires multi-factor authentication"

The ID token's `amr`/`acr` claims did not indicate MFA. Enrol a second factor in
AIRAOS. For local development only, set `AUTH_REQUIRE_MFA=false`.

### "The AIRAOS identity token could not be verified"

Check `AIRAOS_AUTH_ISSUER` matches the `iss` claim exactly, `AIRAOS_AUTH_CLIENT_ID`
matches `aud`, and `AIRAOS_AUTH_JWKS_URL` is reachable from the API container. The
log line carries the underlying reason; the response deliberately does not.

### "Sign-in could not be completed. Start again from the login page."

The `state` cookie was missing or did not match — usually because the flow was
started in one browser and finished in another, or the 10-minute cookie expired.
Start again from `/login`.

### Signed out unexpectedly

Either the idle timeout elapsed (`SESSION_IDLE_TIMEOUT_MINUTES`, default 60), or a
role change revoked the session. Both are by design: a permission change takes
effect immediately, not at next login.

## Permissions

### A page says "You do not have access to this page"

The permission it needs is named in the message. Security → Roles shows exactly what
each role grants and in which environments.

### An operation button is disabled with a reason beside it

The reason comes from the server. Three distinct causes:

1. *"…is not available in production"* — a console-wide policy, not a permission.
   Hard power-off and hard VM stop are not available in production for anyone.
2. *"Your role does not permit actions in production"* — your role's environment
   list excludes it.
3. *"…requires the X permission"* — you lack the permission itself.

### "This resource is in production, not staging. Reload the page and try again."

The page was stale and the resource's real environment differs from what the request
claimed. The refusal is recorded in the audit trail. Reload and re-check the target
before retrying — this is security rule 12 working.

## Providers

### "DigitalOcean is not configured on this console instance"

`DIGITALOCEAN_API_TOKEN` is unset. The page shows this rather than an empty list, so
a missing provider is not mistaken for an empty estate.

### "DigitalOcean rejected the console's credentials"

The token is revoked, expired, or lacks a scope. Rotate it and restart the API so
the client is rebuilt with the new value.

### Droplet or guest missing from the list

Check the environment tag first, then your role. An **untagged** resource resolves to
production, which a developer or intern cannot see. This surprises people; it is
deliberate (see [architecture.md](architecture.md#environment-as-a-first-class-concept)).

### Metrics show "Not collected"

- DigitalOcean memory/disk/load: the monitoring agent is not installed on the
  droplet.
- Prometheus presets: the exporter is not scraped, or the `environment` /`job` label
  does not match what the preset filters on.

The console reports this rather than showing `0`, because an unmonitored resource
must not look healthy.

### Proxmox TLS errors

Trust the cluster CA via `PROXMOX_CA_CERT_PATH`, or install a real certificate.
Disabling verification in production requires the CA path anyway.

### Containers list is empty

Either `DOCKER_SOCKET_PATH` is unset (the page says so), or the names in
`DOCKER_ALLOWED_CONTAINERS` do not match what is running. The allowlist is displayed
on the page so the boundary is visible.

## Database manager

### "Activate a write window before running statements that change data"

Expected. Open one from Database → Connections or from the banner in the SQL editor.
It needs the connection name retyped and a reason, and it expires on its own.

### "Schema changes to production are not permitted from the console"

Not a permission problem — the console will not do it. Use a reviewed migration.

### "The console could not classify this statement as a permitted operation"

The classifier failed closed. Either the statement uses a verb the console does not
run (`GRANT`, `SET`, `VACUUM`, `DO`, transaction control), or it calls a function
that reaches outside the database (`pg_read_file`, `dblink`, `pg_terminate_backend`).
Split the work: do the permitted part here, the rest through a migration or a DBA
session.

### "The query exceeded the 15000ms limit and was cancelled"

Add a `LIMIT`, narrow the filter, or check for a missing index in the Explorer's
index list. Raising `DB_QUERY_TIMEOUT_MS` treats the symptom.

### "The query could not acquire a lock within 3 seconds"

Something else holds a conflicting lock. `lock_timeout` is deliberately short so a
console query never queues behind a long transaction. Find the blocker:

```sql
SELECT pid, state, wait_event_type, left(query, 120)
FROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start;
```

### Results say "truncated at the row cap"

The result hit `DB_QUERY_MAX_ROWS`. Add a `LIMIT` or filter — that is the cap doing
its job, not an error.

### Row count shows an "estimate" badge

The table is over 500,000 rows by the planner's estimate and no filter is applied, so
an exact `count(*)` would be a sequential scan. Apply a filter for an exact count.

### "stored credential could not be decrypted"

`ENCRYPTION_KEY` changed. Restore the previous key, or re-enter each connection's
password and each provider token under the new one.

## Logs

### The Logs page is empty

The buffer only holds what has been pushed to it, for 14 days. For container output,
select a container source — those are read live from Docker. Confirm your role covers
the environment you filtered on.

### Live tail shows nothing

It needs a **single** source and environment; the button is disabled otherwise. Also
confirm the reverse proxy has `proxy_buffering off` — buffering holds SSE events until
the response closes.

## Alerts

### The Alerts page says Alertmanager is not configured

`ALERTMANAGER_URL` is unset. The page stays empty and says so rather than implying
nothing is firing.

### An alert shows "unlabelled"

The rule emits no `environment` label. Alerts without one are shown to everyone
rather than hidden — fix the label in the rule.

### "Acknowledge the alert before recording a resolution"

Resolution is recorded against an acknowledgement. Acknowledge first.

## Audit

### Chain verification fails

Treat it as a security incident.

1. Note the reported sequence number.
2. **Do not** modify the database.
3. Preserve a snapshot for investigation.
4. Check whether `AUDIT_LOG_SECRET` changed — a rotated key invalidates every prior
   hash, which produces the same symptom without tampering.
5. Escalate.

### Audit page is empty for a user who performed an action

Filters may exclude it. Note that reads are recorded in *query history*, not the
audit trail; the audit trail covers privileged actions.

## Health

### /health returns 503

The console's own database is unreachable. Readiness fails deliberately, because
serving traffic without it would mean serving unaudited requests.

```bash
docker compose -f docker/docker-compose.yml exec postgres pg_isready
```

### /health returns "degraded"

A configured provider is unreachable. The console still works for everything that
does not depend on it. This is not a rollback trigger — Monitoring → Health names the
subsystem.

### A subsystem shows "Not reported"

Unconfigured or unreachable, and therefore excluded from the health score. The
Overview and Health pages list these explicitly, because a score of 100% across half
an estate is worse than an honest lower number.

## Performance

### Pages feel slow

Check `x-request-id` timings in the API log. Provider calls are cached (inventory
30–45s, metrics 20s); a slow first load after idle is a cold cache. Persistent
slowness usually means a provider is timing out — the 10–12 second provider timeout
is the ceiling.

### Rate limited

300 requests/minute per session, 30/minute for operations, 10 per 5 minutes for local
login. Without `REDIS_URL` these are per-process, so multiple API replicas allow
N times the intended budget — configure Redis if you run more than one.

## Escalation

Include: the request id, the operator's email, the environment, what was attempted,
the exact message shown, and the API log lines for that request id. For anything
touching the audit chain, preserve the database before acting.
