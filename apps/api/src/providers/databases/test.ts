import pg from 'pg';
import type { ConnectionTestResult } from '@airaos/types';
import { testFailure, testSuccess } from '../contract.js';

/**
 * PostgreSQL connection test (spec sections 9, 30).
 *
 * Opens one short-lived client rather than a pool, runs three catalog queries and
 * closes. Deliberately no row counts on user tables: a connection test must not
 * be the thing that puts load on a production database.
 */
export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: 'disable' | 'require' | 'verify-ca' | 'verify-full';
}

function sslFor(sslMode: PostgresConfig['sslMode'], host: string): pg.ClientConfig['ssl'] {
  switch (sslMode) {
    case 'disable':
      return undefined;
    case 'require':
      // Encrypt but accept a self-signed server certificate, matching libpq.
      return { rejectUnauthorized: false };
    case 'verify-ca':
    case 'verify-full':
      return { rejectUnauthorized: true, servername: host };
    default:
      return { rejectUnauthorized: false };
  }
}

export async function testConnection(config: PostgresConfig): Promise<ConnectionTestResult> {
  const started = Date.now();

  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: sslFor(config.sslMode, config.host),
    connectionTimeoutMillis: 6000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: 'airaos-console(test)',
  });

  try {
    await client.connect();

    const version = await client.query<{ version: string }>('SELECT version() AS version');
    const latencyMs = Date.now() - started;

    const details: Array<{ label: string; value: string }> = [
      {
        label: 'Version',
        value: version.rows[0]?.version.split(' ').slice(0, 2).join(' ') ?? 'unknown',
      },
      { label: 'Database', value: config.database },
      { label: 'TLS', value: config.sslMode },
    ];

    // Table count from the catalog: cheap, and confirms the user can actually see
    // the schema rather than merely authenticate.
    const tables = await client
      .query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')`,
      )
      .catch(() => null);
    if (tables) details.push({ label: 'Tables', value: tables.rows[0]?.count ?? '0' });

    const size = await client
      .query<{ size: string }>('SELECT pg_size_pretty(pg_database_size(current_database())) AS size')
      .catch(() => null);
    if (size?.rows[0]) details.push({ label: 'Size', value: size.rows[0].size });

    // Whether the login is read-only is worth knowing before it is used against
    // production: a read-only role means the guardrail is enforced twice.
    const writable = await client
      .query<{ writable: boolean }>(
        `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS writable`,
      )
      .catch(() => null);
    if (writable?.rows[0]) {
      details.push({
        label: 'Login',
        value: writable.rows[0].writable ? 'can write' : 'read-only (recommended)',
      });
    }

    return testSuccess('postgres', 'PostgreSQL connected.', latencyMs, details);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The database is unreachable.';
    const code = (error as { code?: string }).code;

    // PostgreSQL's own messages name the host, database or role and contain no
    // credential, so they are the most useful thing to show.
    const friendly =
      code === '28P01'
        ? 'Password authentication failed for this user.'
        : code === '3D000'
          ? `Database "${config.database}" does not exist on this server.`
          : code === '28000'
            ? 'The server rejected this user. Check pg_hba.conf and the SSL mode.'
            : message;

    return testFailure(
      'postgres',
      friendly,
      code === '28P01' || code === '28000' ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_UNAVAILABLE',
      null,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
