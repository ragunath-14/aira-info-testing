import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { orm, schema } from './drizzle.js';
import { closePool } from './pool.js';
import { config } from '../config.js';

/**
 * Forward-only migration runner.
 *
 * Each file runs once, inside a transaction, and its checksum is recorded. A
 * changed checksum aborts the run: editing an applied migration is how schema
 * drift between environments starts.
 */
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../database/migrations',
);

async function ensureMigrationsTable(): Promise<void> {
  // Bootstrap only: this one table must exist before any migration file can be
  // recorded, so it cannot itself come from a migration.
  await orm().execute(sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL
    )
  `);
}

function checksum(contents: string): string {
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n')).digest('hex');
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureMigrationsTable();

  const rows = await orm()
    .select({ name: schema.schemaMigrations.name, checksum: schema.schemaMigrations.checksum })
    .from(schema.schemaMigrations);
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const appliedNow: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const contents = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const sum = checksum(contents);
    const previous = applied.get(file);

    if (previous) {
      if (previous !== sum) {
        throw new Error(
          `Migration ${file} has changed after being applied.\n` +
            'Applied migrations are immutable — add a new migration instead.',
        );
      }
      skipped.push(file);
      continue;
    }

    const started = Date.now();
    try {
      await orm().transaction(async (tx) => {
        // A migration file is operator-authored DDL, executed verbatim. sql.raw
        // is the only correct tool here: DDL cannot be parameterised, and the
        // input is a file in this repository, never a request.
        await tx.execute(sql.raw(contents));
        await tx.insert(schema.schemaMigrations).values({
          name: file,
          checksum: sum,
          durationMs: Date.now() - started,
        });
      });
      appliedNow.push(file);
      process.stdout.write(`  applied ${file} (${Date.now() - started}ms)\n`);
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }

  return { applied: appliedNow, skipped };
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isEntrypoint) {
  const cfg = config();
  process.stdout.write(`Running migrations against ${redactDsn(cfg.DATABASE_URL)}\n`);
  try {
    const result = await runMigrations();
    process.stdout.write(
      result.applied.length === 0
        ? `Up to date (${result.skipped.length} migrations already applied).\n`
        : `Applied ${result.applied.length} migration(s).\n`,
    );
    if (cfg.LOCAL_AUTH_ENABLED) {
      process.stdout.write('Seeding RBAC and default admin operator...\n');
      const { syncRbac, seedLocalOperator } = await import('./seed.js');
      await syncRbac();
      await seedLocalOperator();
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

function redactDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    url.password = '';
    url.username = url.username ? '***' : '';
    return url.toString();
  } catch {
    return '[unparseable DSN]';
  }
}
