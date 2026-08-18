# Runbook

Operational procedures for the AIRAOS Infra Console and the estate it watches.

Two things before any procedure below: the console records every privileged action
with your identity, and every response carries a request id that appears in the log
and the audit trail. Quote it in incident notes.

## Daily

1. **Overview** — health score, and read the *"Not counted"* list. A subsystem that
   did not report is a monitoring gap, not a healthy one.
2. **Alerts** — anything unowned? Acknowledge what you are taking, with a note.
3. **Deployments** — anything stuck in `awaiting_approval` or `running`?
4. **Databases** — any open write window that should have been closed? The topbar
   shows your own; Connections shows each one's state.

## Weekly

1. **Security → Audit → Verify chain.** Should report the chain intact.
2. **Security → Users.** Anyone who has left? Deactivate them — it revokes their
   sessions immediately.
3. **Backups.** Check the verified badge on each database connection and each
   Proxmox guest. An "unverified" badge means the console has not seen a completed
   backup; go and confirm in your backup tooling.
4. **Certificates.** Alerts fire at 21 and 7 days, but a glance costs nothing.

## Monthly

1. **Rotate provider tokens.** DigitalOcean and Proxmox tokens are cheap to rotate.
   Update `.env`, restart the API, verify `/health`.
2. **Review roles** against who actually needs production access.
3. **Test a console database restore** into a scratch database, then verify the audit
   chain against the restored copy — that proves the restore is *intact*, not merely
   present.
4. **`npm audit --omit=dev --audit-level=high`** and update.

## Incident: a service is down

1. **Confirm scope.** Overview → is it one service, one host, or a provider?
2. **Applications → Services.** Look at the health message, the container state, the
   restart count, and dependency health from the service's own `/health`.
3. **Logs.** Filter to that source and environment, tick *Errors only*, and start at
   the first error rather than the most recent.
4. **Decide:**

   | Symptom | Action |
   | --- | --- |
   | Crash loop, restart count climbing | Read the logs first — restarting hides the cause |
   | Hung, no logs | Restart the service (typed confirmation, reason recorded) |
   | Started failing right after a deploy | Roll back to the previous release |
   | Dependency down | Fix the dependency; restarting this service will not help |

5. **Restart** from Applications → Services → the service → Operations. The dialog
   states the environment, the impact, and any services that depend on it.
6. **Verify** the health badge returns to healthy and the error rate falls.
7. **Resolve the alert** with a description of what fixed it.

## Incident: a droplet is unreachable

1. **DigitalOcean** → open the droplet. Status, and whether metrics stopped.
2. If metrics stopped but status is `active`, the host is up and something on it is
   wrong — SSH is outside the console; use your normal access path.
3. If status is `off`, power it on (no typed confirmation needed).
4. If it is `active` but unresponsive, reboot it. Typed confirmation and a reason are
   required in production; the dialog says everything on the droplet is interrupted.
5. Follow the action to completion — the console polls the DigitalOcean action id.
6. Confirm the services on it recover in Applications → Services.

**Hard power-off is not available in production.** If a graceful reboot does not
recover it, that is a provider-side problem: use the DigitalOcean console and record
what you did.

## Incident: a Proxmox guest is down

1. **Proxmox** → check cluster quorum first. Without quorum, HA and migrations are
   unavailable and individual guest actions may fail — fix quorum first.
2. Check the node: online, and not out of memory or disk.
3. Open the guest. Status, uptime, and its backup state.
4. Start or reboot from Operations. Hard stop is limited to development and testing
   because it risks unflushed writes.
5. Follow the UPID in the cluster task log.

## Incident: production database problem

**Read-only first.** Production is read-only by default and it should stay that way
while you are diagnosing.

1. **Database → Connections.** Reachable? Latency? Connection count against the
   maximum? Cache hit ratio? Replication role and lag?
2. **Connections saturated:**

   ```sql
   SELECT state, count(*) FROM pg_stat_activity
   WHERE datname = current_database() GROUP BY state;
   ```

   Look for `idle in transaction` — that is usually an application leaking
   connections, not a database problem.
3. **Something blocking:**

   ```sql
   SELECT pid, state, wait_event_type, wait_event, left(query, 120) AS query
   FROM pg_stat_activity
   WHERE state <> 'idle' AND datname = current_database()
   ORDER BY query_start;
   ```

   The console cannot terminate a backend (`pg_terminate_backend` is refused). That
   is a DBA action through a direct session, deliberately.
4. **Only if a data change is genuinely required:**
   - Confirm there is no migration path. A migration is almost always the right
     answer.
   - Open a write window: retype the connection name, give a reason referencing the
     incident.
   - Run the statement. Schema changes will still be refused.
   - **Close the window immediately.** Do not leave it to expire.
   - Record the statement in the incident notes; it is in query history with your
     identity either way.

## Deploying to production

1. Verify the release succeeded in staging — Deployments filtered to staging.
2. Applications → Services → the service → Operations → Deploy release. Pick the
   candidate; only releases that succeeded in a lower environment are offered.
3. Confirm with the typed service name and a reason.
4. The deployment is recorded as `awaiting_approval`. **A different operator**
   approves it from Deployments → Review. The console will refuse a self-approval.
5. CI performs the rollout and reports status back.
6. Verify: health badge, error rate on Metrics, logs for new errors.

## Rolling back

1. Deployments → find the failing release, note the previous successful version.
2. Applications → Services → Operations → Roll back. The console offers the last
   successful release automatically.
3. Production rollbacks still need approval — a rollback is a deployment.
4. Verify health, then write up what happened.

If the release included a non-backwards-compatible migration, a code rollback alone
will not work. That is why migrations are written backwards-compatible: add a column,
deploy code that uses it, make it required later.

## Rotating a credential

### Provider token (DigitalOcean, Proxmox)

1. Create the new token with the same scopes.
2. Update `.env`, restart the API.
3. `curl -s <console>/api/health | jq` — the provider should report `ok`.
4. Revoke the old token.

### Database password

1. Change it on the database.
2. Database → Connections → edit the connection, enter the new password.
3. Test connection.

### SESSION_SECRET

Rotating it invalidates every session; everyone signs in again. Do it deliberately —
for example after a suspected session compromise.

### AUDIT_LOG_SECRET

**Rotating this makes every prior audit hash unverifiable**, which looks identical to
tampering. Only rotate it if the key itself is compromised, and record the rotation
(date, who, why) outside the database so a future verification failure can be
explained.

### ENCRYPTION_KEY

Not rotatable in place. Every stored provider token and database password must be
re-entered afterwards. Back up the current key before changing it.

## Suspected compromise

1. **Contain.** Security → Users → deactivate the account, or revoke its sessions.
   Both take effect immediately.
2. **Assess.** Security → Audit, filtered to that user. Every privileged action they
   took, including refusals, is there.
3. **Check query history** for that operator: what they read, what they changed, and
   against which environment.
4. **Verify the audit chain.** If it fails, preserve the database and escalate
   immediately.
5. **Rotate** every credential the account could have used. Assume provider tokens
   are compromised if the API host is.
6. **Write it up**: timeline from the audit trail, what was accessed, what was
   rotated, what changed as a result.

## Onboarding an operator

1. They sign in once through AIRAOS. The console mirrors the identity.
2. Security → Users → assign the least role that fits. Security → Roles shows exactly
   what each grants and where.
3. Point them at Security → Roles and this runbook.
4. Confirm the environment badges in their topbar match what you intended.

Do not grant `owner` for convenience. `infrastructure_admin` covers operations,
`database_admin` covers databases, `developer` covers non-production work.

## Offboarding an operator

1. Security → Users → deactivate. Sessions are revoked immediately.
2. Rotate any shared credential they had access to.
3. Leave the user record in place — it keeps their audit history attributable.

## Escalation

| Situation | Action |
| --- | --- |
| Audit chain verification fails | Preserve the database, escalate immediately, do not modify anything |
| Credential leak suspected | Rotate first, investigate second |
| Production data changed in error | Query history has the exact statement; restore from backup, do not attempt an inverse write |
| The console itself is down | Providers are unaffected; use provider consoles directly and record what you did |

The last one is worth remembering: the console being down never blocks operating the
estate. It blocks doing so *with an audit trail*, so write down what you did and why.
