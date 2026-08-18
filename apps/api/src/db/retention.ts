import path from 'node:path';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { orm, schema } from './drizzle.js';
import { closePool } from './pool.js';

/**
 * Trims the short-retention tables. Intended to run from cron or a CI schedule.
 *
 * Deliberately never touches audit_events or query_history: those are the record
 * of who did what, and the database grants forbid deleting from them anyway.
 */
async function numericSetting(key: string, fallback: number): Promise<number> {
  const [row] = await orm()
    .select({ value: schema.consoleSettings.value })
    .from(schema.consoleSettings)
    .where(eq(schema.consoleSettings.key, key))
    .limit(1);

  const raw = row?.value;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** `now() - N days`, with the day count bound as a parameter rather than inlined. */
function olderThanDays(days: number) {
  return sql`now() - (${days} || ' days')::interval`;
}

export async function runRetention(): Promise<Record<string, number>> {
  const logDays = await numericSetting('logs.retention_days', 14);
  const healthDays = await numericSetting('health_history.retention_days', 30);

  const logs = await orm()
    .delete(schema.logEntries)
    .where(
      and(
        lt(schema.logEntries.occurredAt, olderThanDays(logDays)),
        isNull(schema.logEntries.deploymentId),
      ),
    );

  const health = await orm()
    .delete(schema.applicationHealthChecks)
    .where(lt(schema.applicationHealthChecks.checkedAt, olderThanDays(healthDays)));

  // Expired sessions are pruned aggressively; revoked rows are kept 30 days so
  // "which device was signed in" questions remain answerable.
  const sessions = await orm()
    .delete(schema.sessions)
    .where(
      or(
        lt(schema.sessions.expiresAt, olderThanDays(7)),
        and(
          isNotNull(schema.sessions.revokedAt),
          lt(schema.sessions.revokedAt, olderThanDays(30)),
        ),
      ),
    );

  return {
    log_entries: logs.rowCount ?? 0,
    application_health_checks: health.rowCount ?? 0,
    sessions: sessions.rowCount ?? 0,
  };
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isEntrypoint) {
  try {
    const deleted = await runRetention();
    for (const [table, count] of Object.entries(deleted)) {
      process.stdout.write(`  ${table}: removed ${count} row(s)\n`);
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
