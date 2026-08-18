import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * Generated migrations land in database/drizzle alongside the hand-written SQL in
 * database/migrations. The existing runner applies the hand-written set (which
 * created the schema this file describes); drizzle-kit owns everything from here
 * on, so the two never touch the same object.
 *
 *   npm run db:generate -w @airaos/api   # diff the schema into a new migration
 *   npm run db:push     -w @airaos/api   # development only, no migration file
 *   npm run db:studio   -w @airaos/api   # inspect the console's own database
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: '../../database/drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Keeps generated SQL reviewable in a pull request rather than opaque.
  verbose: true,
  // Refuses to generate a migration that would silently drop data.
  strict: true,
});
