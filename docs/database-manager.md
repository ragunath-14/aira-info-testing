# Database Manager

A controlled, DBeaver-style interface for PostgreSQL. It covers the parts of a
database client that infrastructure work actually needs — structure, data,
ad-hoc reads — without becoming an unrestricted client pointed at production.

## The path a query takes

```
Browser  →  /api/proxy/databases/execute
              │
API       classify         category: READ / WRITE / DDL / DESTRUCTIVE / UNKNOWN
              │
          authorise        permission × environment × write window
              │
          bind session     statement_timeout, lock_timeout, read-only
              │
          execute          inside BEGIN READ ONLY for reads
              │
          cap rows         LIMIT injected in SQL, then truncate as a backstop
              │
          record           query_history always; audit_events for non-reads
```

**The browser never connects to PostgreSQL.** Every statement is executed by the
API process, which holds the credential.

## Classification

`providers/databases/query-classifier.ts` decides the *category* of a statement.
Its rules:

| Category | Verbs |
| --- | --- |
| `READ` | `SELECT`, `EXPLAIN`, `SHOW`, `TABLE`, `VALUES`, `FETCH`, read-only `WITH` |
| `WRITE` | `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY` |
| `DDL` | `CREATE`, `ALTER`, `COMMENT`, `REINDEX`, `CLUSTER`, `REFRESH` |
| `DESTRUCTIVE` | `DROP`, `TRUNCATE` |
| `UNKNOWN` | anything else — **always refused** |

Design decisions worth knowing:

- **Fails closed.** An unrecognised statement is `UNKNOWN`, and `UNKNOWN` is
  refused under every configuration. There is no setting that permits it.
- **The strictest statement in a batch wins.** `SELECT 1; DROP TABLE users`
  classifies as `DESTRUCTIVE`.
- **`UNKNOWN` outranks everything.** A recognised statement cannot downgrade an
  unrecognised one sitting beside it.
- **Comments and literals are neutralised first.** A `DROP` inside a comment or a
  string stays `READ`; a comment inserted between `DROP` and `TABLE` does not
  disguise a destructive statement. Nested block comments and dollar-quoted blocks
  are handled.
- **`WITH` is inspected.** `WITH x AS (DELETE ... RETURNING *) SELECT * FROM x` is
  a `WRITE`, not a `READ`.
- **`EXPLAIN ANALYZE` inherits what it wraps**, because it actually executes it.
  Plain `EXPLAIN` stays `READ`.

Refused outright, whatever the role: `GRANT`, `REVOKE`, `SET`, `ALTER SYSTEM`,
role and user management, `DO`, `CALL`, `VACUUM`, `CHECKPOINT`, `LOCK`, explicit
transaction control, and filesystem or control functions such as `pg_read_file`,
`pg_ls_dir`, `lo_import`, `dblink` and `pg_terminate_backend`.

53 unit tests cover this file, including the evasion attempts above.

## Policy

`providers/databases/policy.ts` decides whether a category is *permitted* for this
user, on this connection, right now.

| Environment | READ | WRITE | DDL | DESTRUCTIVE |
| --- | --- | --- | --- | --- |
| development | `database.query` | `database.write` + window | `database.write` + window | `database.admin` + window |
| testing | `database.query` | `database.write` + window | `database.write` + window | `database.admin` + window |
| staging | `database.query` | `database.write` + window | `database.write` + window | `database.admin` + window |
| **production** | `database.query` | `database.admin` + window | **refused** | **refused** |

Production schema changes are not a permission question — the console will not do
them. Use a reviewed migration.

### Write windows

A write window is per connection, per operator, and time-boxed.

Opening one requires:

1. `database.write` (or `database.admin` for production).
2. Retyping the connection name exactly — this is what makes "I thought I was on
   staging" impossible to do silently.
3. A reason of at least 10 characters, which lands in the audit record.

The window expires on its own (default 15 minutes, maximum 60). It can be closed
early from Database → Connections, and the topbar shows an open window at all
times so it cannot be forgotten.

Rows in `database_write_windows` are never deleted — expiry is by timestamp so the
history of who opened what stays intact.

## Session guards

Applied before any statement runs, so they hold even if application logic is
bypassed:

| Guard | Default | Purpose |
| --- | --- | --- |
| `statement_timeout` | 15s | Kills a runaway query server-side |
| `lock_timeout` | 3s | A console query never waits behind a long lock |
| `idle_in_transaction_session_timeout` | timeout + 5s | No abandoned open transaction |
| `default_transaction_read_only` | on for read sessions | PostgreSQL refuses a misclassified write |
| `BEGIN READ ONLY` | reads | A second, independent barrier |
| Pool size | 5 per target | The console cannot exhaust a production database's slots |
| `application_name` | `airaos-console(ro\|rw)` | Identifies console sessions in `pg_stat_activity` |

## Row caps

The cap is applied in SQL where possible — a single `SELECT` is wrapped in
`SELECT * FROM (...) LIMIT n+1`, so the database stops producing rows rather than
streaming a million to the API and discarding them. The extra row is how
truncation is detected and reported.

Anything that is not a single, unlimited `SELECT` is left alone (wrapping it could
change its meaning) and truncated after the fact.

## Explorer

Inspection only — schema editing is not offered, because a console is the wrong
place to change a schema.

- **Schemas** with table, view, function and sequence counts. System schemas are
  hidden by default.
- **Tables and views** with the planner's row estimate and total size.
- **Structure**: columns with type, nullability, default, primary key, unique and
  foreign key markers.
- **Indexes** with definition, uniqueness and size.
- **Constraints**, **outbound foreign keys**, and — importantly — **inbound**
  references, so the consequences of a destructive change are visible before it is
  attempted.
- **Functions, sequences, extensions and triggers** per schema.

Every introspection query is parameterised against the catalog and runs on a
read-only session.

## Data browser

Structured intent, never SQL:

```json
{
  "schema": "public", "table": "customers",
  "page": 1, "pageSize": 100,
  "orderBy": "created_at", "orderDirection": "desc",
  "filters": [{ "column": "email", "operator": "contains", "value": "@airaos" }]
}
```

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `starts_with`,
`ends_with`, `is_null`, `is_not_null`. LIKE metacharacters in values are escaped,
so searching for `50%` finds a literal `50%`.

Every column named is verified against the table's real column list before it
reaches the query builder. Values are bound parameters.

**Row counts** are exact when filters are applied, or when the planner's estimate
is under 500,000. Above that the estimate is shown and labelled as one — an exact
`count(*)` on a large table is a sequential scan, which is the accidental load this
console exists to avoid.

**Default ordering** is the primary key, falling back to `ctid`, so paging is
deterministic within a browsing session.

## SQL editor

- Classification appears as you type, from the server, with the environment beside
  it. The browser never decides what is safe.
- A non-READ statement against a read-only connection explains that a window is
  needed and offers to open one, through the same confirmation dialog as any other
  privileged operation.
- `Ctrl`/`Cmd`+`Enter` runs. Plain `Enter` inserts a newline — a keystroke must
  never execute a statement.
- `Explain` runs `EXPLAIN` without `ANALYZE`, so nothing is executed.
- Results export to CSV client-side, with formula-injection escaping.
- Multiple tabs; each keeps its own statement and result.

## Query history

Every attempt is recorded, including refusals.

| Stored | Not stored |
| --- | --- |
| Operator, connection, environment | Raw `SELECT` text |
| SHA-256 of the normalised statement | Result rows |
| Literal-stripped preview | Credentials (redaction runs first) |
| Classification, success, error code | |
| Duration, rows returned, rows affected | |
| Full SQL **for non-reads only** | |

Full text for writes is kept because an incident review needs to reconstruct what
changed. Keeping full `SELECT` text would mean storing customer data in the
console's database, so it is not kept.

`query_history` is append-only at the grant level.

## Backup reporting

The console does not claim a backup exists unless it has read something that says
so.

- **DigitalOcean managed databases**: the cluster's backup list is read and, if a
  completed backup is found, reported as verified with its timestamp.
- **Everything else**: reported as unverified, with an explanation the UI shows
  verbatim — *"Backup state is not exposed for this provider. Verify it in your
  backup tooling."*

An unverified state is displayed as a warning badge, never as an absence of
information.

## Operational limits

| Setting | Default | Where |
| --- | --- | --- |
| `DB_QUERY_TIMEOUT_MS` | 15000 | env |
| `DB_QUERY_MAX_ROWS` | 1000 | env |
| `DB_QUERY_MAX_CONNECTIONS_PER_TARGET` | 5 | env |
| `DB_WRITE_MODE_TTL_MINUTES` | 15 | env |
| `database.max_result_rows` | 1000 | `console_settings` |
| `database.statement_timeout_ms` | 15000 | `console_settings` |
| `database.production_read_only` | true | `console_settings`, **not changeable** |

Idle target pools are closed after five minutes, so the console holds no
long-lived production sessions between uses.
