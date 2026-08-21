# Render Test Deployment (Phase 1)

Current, live Phase 1 test deployment for the intern deployment assignment. This
covers the free-tier Render Blueprint setup; see [deployment.md](deployment.md)
for the Docker/self-hosted production path this may graduate to later.

Phase 2 (company domain) is **not** covered here — intentionally deferred until
this Phase 1 environment is fully signed off.

## 1. Deployment Documentation

| Item | Value |
| --- | --- |
| Cloud Provider | Render (render.com), free tier |
| Region | Singapore |
| Compute | 2× Render free web service (`airaos-infra-api`, `airaos-infra-web`) |
| Database | Render-managed PostgreSQL, free plan, instance `airaos-console-db` |
| Node.js Version | >=20.11 (per root `package.json` `engines`) |
| PostgreSQL Version | 18.4 (Debian, Render-provisioned) |
| Nginx | None — Render's own edge proxy terminates TLS and routes to each service; no self-managed reverse proxy in this topology |
| ORM / Migrations | Drizzle ORM (`drizzle-orm`), forward-only custom migration runner (`apps/api/src/db/migrate.ts`) tracking applied files in a `schema_migrations` table — not `drizzle-kit migrate` |
| Authentication | Pre-existing AIRAOS SSO/session auth with a `LOCAL_AUTH` development fallback (this app does not use Better Auth — kept as-is per the assignment's "do not rewrite unnecessarily" instruction) |
| RBAC | Project's existing `roles` / `permissions` / `role_permissions` / `user_roles` tables. Role keys: `owner`, `infrastructure_admin`, `developer`, `database_admin`, `viewer`, `intern`, mapping to the assignment's SUPER_ADMIN / ADMIN / USER tiers respectively |
| Frontend Hosting | Second Render web service running Next.js in `standalone` SSR mode — not Netlify/Cloudflare Pages, because the app needs server-side rendering and a same-origin API proxy route (`apps/web/app/api/proxy`), which a static host cannot provide |
| Test URL (web) | `https://airaos-infra-web.onrender.com` |
| Test URL (api, internal-use only) | `https://airaos-infra-api.onrender.com` — the browser never calls this directly; only the web service's server-side proxy does |
| Production URL | Not yet configured — Phase 2 |

Blueprint source of truth: [render.yaml](../render.yaml) at the repo root.

## 2. Architecture Diagram

```
                         INTERNET
                            │
                            ▼
                    ┌───────────────┐
                    │    Browser    │
                    └───────┬───────┘
                            │ HTTPS (Render-issued TLS)
                            ▼
        ┌───────────────────────────────────────┐
        │     Render edge / managed proxy        │
        └───────┬─────────────────────┬──────────┘
                 │                     │
                 ▼                     ▼
     ┌─────────────────────┐  ┌─────────────────────┐
     │  airaos-infra-web    │  │  airaos-infra-api    │
     │  Next.js standalone  │  │  Fastify + Drizzle   │
     │  /api/proxy/* route  │──▶  session auth + RBAC │
     └─────────┬─────────────┘  └───────────┬─────────┘
               HTTPS (server-to-server,          │
               API is never reached from          │ Drizzle ORM
               the browser directly)               ▼
                                          ┌─────────────────────┐
                                          │  airaos-console-db   │
                                          │  Render Postgres 18  │
                                          │  (free, same account)│
                                          └─────────────────────┘
```

Browser → PostgreSQL is architecturally impossible here: the browser only ever
calls the web service's same-origin `/api/proxy/*` route, which forwards
server-side to the API over HTTPS, which is the only thing holding the database
credential.

## 3. Security Report

| Area | Status |
| --- | --- |
| Open ports | N/A in the VM sense — no self-managed host. Both services expose only HTTPS (443) via Render's edge; there is no way to reach either service's raw listening port from outside Render |
| Firewall configuration | Managed by Render; not independently configurable in this topology, which is the free-tier trade-off for not self-hosting Nginx |
| PostgreSQL exposure | Reachable only via `DATABASE_URL`, entered as a Render dashboard secret (`sync: false` in `render.yaml`), never committed. Not reachable from the browser under any code path |
| SSH | N/A by architecture — there is no persistent VM to secure. Render does offer its own SSH key feature for a debug shell into a running container (Account Settings → SSH Keys), which can be configured for completeness, but it isn't equivalent to securing remote administration on a self-managed host — there's no `sshd` config, no fail2ban, no host to harden, because the platform never exposes one |
| Authentication | Session-cookie based; `LOCAL_AUTH_ENABLED=true` intentionally enabled for this Phase 1 test deployment only, gated by `NODE_ENV=test` (not `production`) — see the comment block in `render.yaml` for why. **Must be reverted to real AIRAOS SSO + `NODE_ENV=production` before any Phase 2 / company-domain work.** |
| RBAC | Enforced backend-side (`loadConfig`/route guards), not just hidden in the UI — confirmed via live test: unauthenticated request to `/api/v1/auth/session` returns `401` |
| Secret handling | `ENCRYPTION_KEY`, `AUDIT_LOG_SECRET`, `SESSION_SECRET`, `DATABASE_URL` are all `sync: false` in `render.yaml` (dashboard-only). **Known issue:** the original values were committed in plaintext in commit `d16ef40`, and this repository is confirmed **public** on GitHub. The values have since been rotated in the Render dashboard, so the leaked values are no longer live credentials, but they remain visible in git history. Recommended follow-up: make the repository private, and/or scrub history with `git filter-repo` before treating this as fully closed. |

## 4. Testing Report

| Test (assignment §19) | Result | How verified |
| --- | --- | --- |
| 1. Unauthenticated API → 401 | **PASS** | `curl` against `/api/v1/auth/session` and `/api/v1/users` with no cookie, both returned `401 UNAUTHENTICATED` |
| CORS scoped to the web origin | **PASS** | Preflight from `https://airaos-infra-web.onrender.com` returns matching `Access-Control-Allow-Origin`; a spoofed origin is rejected |
| HTTPS + HTTP→HTTPS redirect | **PASS** | `http://airaos-infra-web.onrender.com/` returns `301` to the `https://` URL |
| Security headers | **PASS** | CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` present on API responses |
| Migrations applied | **PASS** | All 10 files in `database/migrations` applied, checksums match; confirmed both via deploy logs and a direct read-only DB query |
| RBAC seeded | **PASS** | 6 roles, 25 permissions synced; confirmed via direct DB query |
| 2. USER → ADMIN API → 403 | **PASS** | `viewer`-role test account (`test-user@airaos.local`) authenticated live (real session cookie + CSRF token), then `GET /api/v1/users` → `403 FORBIDDEN` ("requires the users.view permission") |
| 3. ADMIN → authorized endpoint → success | **PASS** | `infrastructure_admin`-role test account (`test-admin@airaos.local`): `GET /api/v1/users` → `200` (has `users.view`); `PUT /api/v1/users/:id/roles` → `403` (correctly lacks `users.manage`) |
| 4. SUPER_ADMIN → success | **PASS** | `owner`-role test account (`test-superadmin@airaos.local`, created for this test since the real seeded owner's password wasn't available to the assistant): `GET /api/v1/users` → `200`; `PUT /api/v1/users/:id/roles` (`users.manage`-gated) → `200` |
| 5. Logout invalidates session | **PASS** | `POST /api/v1/auth/logout` → `200 {signedOut:true}`, then `GET /api/v1/auth/session` → `401` |
| 6. Refresh preserves session | **PASS** | Repeated `GET /api/v1/auth/session` on the same session returns `200` with the same `sessionId` — the curl-level equivalent of a page refresh |
| VM reboot recovery (§30) | **PASS** (Render equivalent) | Pushed an empty commit to trigger a real redeploy of `airaos-infra-api`; the service came back and answered `/api/v1/auth/methods` cleanly afterward, no manual intervention beyond the git push |
| Database persistence (§31) | **PASS** | Inserted a marked test record, triggered the same redeploy, confirmed the record present afterward with its original `created_at` unchanged, then cleaned it up |

All six §19 tests plus the reboot/persistence pair were run directly against the
live API (cookie jar + double-submit CSRF token + `Origin` header, matching what
the browser does) rather than through the browser UI itself — the mechanism is
proven end to end. A visual pass in an actual browser is still worthwhile before
final sign-off, but is no longer blocking.

## 5. Cost Report

| Resource | Provider | Plan | Cost |
| --- | --- | --- | --- |
| `airaos-infra-api` | Render | Free web service | $0 |
| `airaos-infra-web` | Render | Free web service | $0 |
| `airaos-console-db` | Render | Free PostgreSQL | $0 |
| TLS certificates | Render (automatic) | Included, free | $0 |

```
Infrastructure cost: $0
Paid resources: None
Paid upgrade: None
```

Known free-tier behaviors, not costs: Render free web services spin down after
~15 minutes idle (first request after that takes ~30-60s); Render free Postgres
instances are suspended, not deleted, after 90 days of total inactivity, and can
be resumed from the dashboard at no charge.
