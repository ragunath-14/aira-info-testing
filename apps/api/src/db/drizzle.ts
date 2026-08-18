import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db as pgPool } from './pool.js';
import * as schema from './schema.js';

/**
 * Drizzle client for the console's own database.
 *
 * Built on the `pg` pool from ./pool.js so there is one connection budget and one
 * shutdown path. Every query against the console's own tables goes through here;
 * `pool.ts` no longer exposes a raw query helper.
 *
 * Only ever pointed at the console's database. External PostgreSQL targets go
 * through providers/databases, which uses the raw driver because their schemas
 * are unknown and their statements are operator-supplied (spec section 11).
 */
let client: NodePgDatabase<typeof schema> | null = null;

export function orm(): NodePgDatabase<typeof schema> {
  if (!client) {
    client = drizzle(pgPool(), { schema, logger: false });
  }
  return client;
}

/** The console database handle. */
export type Db = NodePgDatabase<typeof schema>;

/** The handle passed to a `transaction()` callback. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Accepts either handle, for helpers that are called both standalone and inside
 * a transaction. The query-builder surface is identical across the two.
 */
export type DbOrTx = Db | Tx;

export { schema };
