# Development

## Getting productive

```bash
npm install
cp .env.example .env          # fill in the three keys — see setup.md
npm run build -w @airaos/types && npm run build -w @airaos/config && npm run build -w @airaos/validation
npm run migrate -w @airaos/api
npm run seed -w @airaos/api -- --demo
npm run dev
```

`npm run dev` starts the API on :4000 and the web app on :3000 concurrently.

The shared packages compile to `dist/`, so after changing one you either rebuild it
or run `npm run dev -w @airaos/types` in a second terminal to watch it. Forgetting
this produces confusing type errors against a stale build — it is the most common
first-day stumble in this repo.

## Verifying a change

```bash
npm run typecheck                    # every workspace
npm run lint                         # includes the banned-import checks
npm run test:unit -w @airaos/api     # fast, no external services
npm run test:security -w @airaos/api # write policy and refusal paths
npm run build                        # API + web production builds
```

Integration tests need real services and are opt-in — see
[`apps/api/tests/integration/README.md`](../apps/api/tests/integration/README.md).

## Conventions

**Comments explain why, not what.** The code says what it does. A comment earns its
place when it records a decision, a constraint, or a trap — *"Not found and not
visible deliberately return the same response"* is worth writing; *"loop over
droplets"* is not.

**Errors are written for an operator.** `AppError`'s `message` is displayed
verbatim, so it should say what happened and what to do. Anything sensitive goes in
`internal`, which only reaches the log.

**Nulls mean "not known".** A metric that could not be collected is `null` with an
`unavailableReason`, never `0`. An unreported subsystem is `unknown`, never
`healthy`. This is load-bearing: a console that shows a green zero is worse than
one that admits it cannot see.

**Validate at the boundary.** Every route body, query and params object goes
through `parse(schema, input)`. Nothing reaches a service layer unvalidated.

**Environment comes from the resource.** Never from the request. See security rule
11.

## Adding a provider

1. Create `apps/api/src/providers/<name>/` with the four-file split:
   `types.ts` (wire shapes — only fields you read), `client.ts` (named endpoint
   methods, no generic passthrough), `mapper.ts` (wire → domain, including
   environment resolution), `service.ts` (caching, environment filtering, health).
2. Add its configuration to `packages/config/src/index.ts`, including a
   `providers.<name>` boolean so the rest of the code can ask whether it is
   configured.
3. Use `ProviderHttpClient` so timeout, retry, error classification and redaction
   behave like every other provider.
4. Export a `health(): Promise<SubsystemHealth>` that returns `unknown` when
   unconfigured and `down` with a reason when unreachable — never `healthy` by
   default.
5. Add it to `services/dashboard.ts` and `routes/health.ts`.
6. Add mapper tests, especially for environment resolution.

Do **not** add a passthrough method. A caller naming an endpoint is the difference
between a provider module and a credential-shaped hole.

## Adding an operation

Operations are the only way the console changes anything, so the path is
deliberately narrow.

1. Add the key to `OPERATION_KEYS` and a definition to `OPERATION_DEFINITIONS` in
   `packages/types/src/operations.ts`. Decide honestly:
   - `requiredPermission` and `productionPermission`
   - `allowedEnvironments` — if it should never run in production, leave production
     out. That is a stronger guarantee than a permission.
   - `impact`, `requiresTypedConfirmation`, `requiresSecondApproval`
2. Handle the key in `resolveTarget()` in `apps/api/src/services/operations.ts`.
   Resolve the resource, read its environment from the resolved record, and return
   a `run()` that performs exactly one provider call.
3. Add a case to `tests/unit/rbac.test.ts` proving it is refused where it should
   be.
4. The UI needs no change: pages render whatever
   `/api/v1/operations/capabilities` reports.

The exhaustiveness guard in `resolveTarget()` means TypeScript will refuse to
compile until step 2 is done.

## Adding a metric

Add a preset to `apps/api/src/providers/prometheus/presets.ts` and its key to
`METRIC_PRESETS` in `packages/validation/src/observability.ts`. Use `$target` for
the selector; it is substituted with an escaped label value.

Do not accept PromQL from the browser. Arbitrary expressions can read any series
in the TSDB and are trivially expensive.

## Adding a page

```
apps/web/app/<section>/<page>/page.tsx
```

```tsx
export default function Page() {
  return (
    <PermissionGate permission="infra.view">
      <Content />
    </PermissionGate>
  );
}
```

Then: `PageShell` for the frame, `useQuery` for data, `QueryError` for failures,
`DataTable` for lists, `EnvironmentBadge` wherever a resource's environment is
shown, and `useOperation` + `ConfirmDialog` for anything that changes state.

Add it to `NAVIGATION` in `components/layout/sidebar.tsx` with its permission, so
it is hidden rather than shown broken.

`PermissionGate` is a courtesy. The API still enforces access if someone types the
URL.

## Migrations

Forward-only, and immutable once applied. The runner records a checksum and aborts
if an applied file changes:

```
Migration 0004_applications_deployments.sql has changed after being applied.
Applied migrations are immutable — add a new migration instead.
```

That message is the point: editing an applied migration is how schema drift between
environments starts.

```bash
# database/migrations/0010_your_change.sql
npm run migrate -w @airaos/api
```

If a change affects the permission catalogue, re-run `npm run seed -w @airaos/api`
so the database matches `@airaos/types`.

## Debugging

```bash
LOG_LEVEL=debug npm run dev:api      # provider calls, cache misses, probe failures
```

Every response carries `x-request-id`, and the same id appears in the log line and
the audit record. Quoting it in a bug report makes the whole path retrievable.

The `internal` field on an `AppError` is logged but never sent to the client — put
provider status codes, response previews and cause chains there.

## Testing notes

Unit tests import modules lazily inside `beforeAll` when they need configuration,
because `config()` caches on first call:

```ts
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  crypto = await import('../../src/security/crypto.js');
});
```

`tests/security/policy.test.ts` mocks only the `orm()` round trip in
`db/drizzle.js`, passing the real schema through — so the filter the policy builds
is the real one and only the database call is stubbed. Prefer that shape over
mocking the thing you are testing.

`tests/unit/drizzle-queries.test.ts` goes one step further and asserts on the SQL
Drizzle emits, using `PgDialect` with no connection. Reach for it when a query's
correctness is not obvious from the builder call — the write-window predicate is
the example: dropping either half of it would silently grant writes.

Write tests for **refusals**. The valuable case is not that a write succeeds with
permission; it is that it fails without one.

## Repository layout

```
apps/api/src/
  app.ts            Fastify assembly, single error boundary
  index.ts          entrypoint, graceful shutdown
  config.ts         cached configuration
  auth/             session, SSO, local dev login, hooks
  rbac/             permission × environment decisions
  audit/            hash-chained trail
  security/         crypto, CSRF, CORS, rate limiting
  providers/        one directory per external system
  services/         cross-provider logic
  routes/           HTTP surface
  utils/            errors, logger, cache, http, redaction, reply, validate
  db/               pool, migrate, seed, retention

apps/web/
  app/              App Router pages + the API proxy route
  components/ui/    primitives
  components/shared/ environment badge, status, data table, metric, confirm dialog
  components/layout/ session provider, sidebar, topbar, page shell
  features/         cross-page feature pieces
  hooks/            useOperation
  lib/              api client, formatters
```
