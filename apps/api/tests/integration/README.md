# Integration tests

These tests talk to real services, so they are not part of `npm test`. Run them
against **test or staging infrastructure only** — never production.

```bash
npm run test:integration -w @airaos/api
```

## What each suite needs

| Suite | Requires | Skips when absent |
| --- | --- | --- |
| `console-database.test.ts` | `DATABASE_URL` pointing at a migrated test database | yes |
| `digitalocean.test.ts` | `DIGITALOCEAN_API_TOKEN` with read scope | yes |
| `proxmox.test.ts` | `PROXMOX_API_URL` + token for a test cluster | yes |
| `prometheus.test.ts` | `PROMETHEUS_URL` | yes |
| `redis.test.ts` | `REDIS_URL` | yes |
| `managed-database.test.ts` | `TEST_TARGET_DATABASE_URL` for a throwaway database | yes |

Every suite starts with a guard that skips it when its dependency is not
configured, so a partial environment produces skipped tests rather than failures.

## Rules for anything added here

1. **No production credentials.** The suites assert on shape and behaviour, not on
   the contents of a real estate. A test that only passes against production is a
   test that will eventually change production.
2. **Read-only against providers.** The one exception is `managed-database`, which
   creates and drops its own schema inside a database named in
   `TEST_TARGET_DATABASE_URL`. It refuses to run if that DSN's database name does
   not contain `test`.
3. **Assert on refusals too.** The valuable cases are the ones where the console
   *declines*: a production write without a window, an operation in a forbidden
   environment, an unclassifiable statement.

## Fixture database

```bash
createdb airaos_console_test
DATABASE_URL=postgres://localhost/airaos_console_test npm run migrate -w @airaos/api
DATABASE_URL=postgres://localhost/airaos_console_test npm run seed -w @airaos/api
```

The seed's RBAC sync is required: the policy and session tests read roles and
permissions from the database.
