import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * Orders an `environment` column production-first.
 *
 * The enum's own declaration order is alphabetical, which would put development
 * above production — the wrong way round for every list in the console, where the
 * environment an operator most needs to see belongs at the top. Shared so the
 * ordering cannot drift between pages.
 */
export function environmentRank(column: PgColumn): SQL {
  return sql`case ${column}
    when 'production' then 0
    when 'staging' then 1
    when 'testing' then 2
    else 3
  end`;
}
