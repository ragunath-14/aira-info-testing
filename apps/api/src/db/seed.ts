import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS, ROLE_DEFINITIONS, ROLES } from '@airaos/types';
import { eq, sql } from 'drizzle-orm';
import { orm, schema } from './drizzle.js';
import { closePool } from './pool.js';
import { config } from '../config.js';
import { hashPassword } from '../security/crypto.js';

/**
 * Seeding has two parts:
 *
 *  1. RBAC sync — roles, permissions and their mapping are generated from
 *     @airaos/types so the database can never drift from the definitions the
 *     backend actually enforces. This runs in every environment, idempotently.
 *
 *  2. Demo data — sample registry rows and a local development operator. Only
 *     with `--demo`, and refused when NODE_ENV=production.
 */
const SEEDS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../database/seeds',
);

/**
 * Human-readable descriptions for the permission catalogue. Anything missing
 * here still seeds — with a generated description — so adding a permission to
 * @airaos/types never breaks the seed.
 */
const PERMISSION_DESCRIPTIONS: Partial<Record<(typeof PERMISSIONS)[number], string>> = {
  'infra.view': 'View infrastructure inventory and health.',
  'infra.manage': 'Perform infrastructure operations, including production.',
  'digitalocean.view': 'View DigitalOcean droplets, volumes and firewalls.',
  'digitalocean.reboot': 'Reboot a droplet.',
  'digitalocean.power': 'Power a droplet on or off.',
  'digitalocean.snapshot': 'Create droplet snapshots.',
  'proxmox.view': 'View Proxmox cluster, nodes and guests.',
  'proxmox.manage': 'Start, stop, reboot and snapshot Proxmox guests.',
  'application.view': 'View the application registry and health.',
  'application.restart': 'Restart approved application services and workers.',
  'application.deploy': 'Deploy releases to non-production environments.',
  'application.deploy.production': 'Deploy to and approve production releases.',
  'database.view': 'View database connections, schemas and structure.',
  'database.query': 'Run read-only queries through the SQL editor.',
  'database.write': 'Activate write mode and run data-changing statements.',
  'database.admin': 'Administer connections and authorise production writes.',
  'logs.view': 'View application, container and infrastructure logs.',
  'logs.export': 'Export log extracts.',
  'alerts.view': 'View alerts.',
  'alerts.manage': 'Acknowledge and resolve alerts.',
  'audit.view': 'Read the audit trail.',
  'users.view': 'View console users and their roles.',
  'users.manage': 'Assign roles and deactivate users.',
  'settings.view': 'View console settings.',
  'settings.manage': 'Change console settings.',
};

export async function syncRbac(): Promise<void> {
  await orm().transaction(async (tx) => {
    await tx
      .insert(schema.permissions)
      .values(
        PERMISSIONS.map((permission) => ({
          key: permission,
          description: PERMISSION_DESCRIPTIONS[permission] ?? `Permission ${permission}.`,
        })),
      )
      .onConflictDoUpdate({
        target: schema.permissions.key,
        set: { description: sql`excluded.description` },
      });

    for (const role of ROLES) {
      const definition = ROLE_DEFINITIONS[role];
      await tx
        .insert(schema.roles)
        .values({
          key: definition.key,
          label: definition.label,
          description: definition.description,
          // ROLE_DEFINITIONS is readonly; Drizzle wants a mutable array.
          environments: [...definition.environments],
          isSystem: true,
        })
        .onConflictDoUpdate({
          target: schema.roles.key,
          set: {
            label: sql`excluded.label`,
            description: sql`excluded.description`,
            environments: sql`excluded.environments`,
          },
        });

      // Replace the mapping wholesale so a permission removed from the type
      // definition is also revoked in the database.
      await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleKey, role));
      if (definition.permissions.length > 0) {
        await tx
          .insert(schema.rolePermissions)
          .values(
            definition.permissions.map((permission) => ({
              roleKey: role,
              permissionKey: permission,
            })),
          );
      }
    }
  });
}

async function runSqlSeeds(files: string[]): Promise<void> {
  for (const file of files) {
    const contents = await readFile(path.join(SEEDS_DIR, file), 'utf8');
    // Seed files are repository-authored SQL, like migrations.
    await orm().execute(sql.raw(contents));
    process.stdout.write(`  seeded ${file}\n`);
  }
}

export async function seedLocalOperator(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@airaos.local';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'airaos-dev-password';

  const [user] = await orm()
    .insert(schema.users)
    .values({
      email,
      name: 'Local Administrator',
      isActive: true,
      mfaVerifiedAt: sql`now()`,
    })
    .onConflictDoUpdate({ target: schema.users.email, set: { name: sql`excluded.name` } })
    .returning({ id: schema.users.id });

  const userId = user?.id;
  if (!userId) throw new Error('failed to upsert local operator');

  await orm()
    .insert(schema.localCredentials)
    .values({ userId, passwordHash: hashPassword(password), mustChange: true })
    .onConflictDoUpdate({
      target: schema.localCredentials.userId,
      set: { passwordHash: sql`excluded.password_hash` },
    });

  await orm()
    .insert(schema.userRoles)
    .values({ userId, roleKey: 'owner' })
    .onConflictDoNothing();

  process.stdout.write(`  local operator: ${email}\n`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    process.stdout.write(
      '  password: airaos-dev-password (development default — change it immediately)\n',
    );
  }
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isEntrypoint) {
  const cfg = config();
  const demo = process.argv.includes('--demo');

  try {
    process.stdout.write('Syncing RBAC from @airaos/types...\n');
    await syncRbac();
    process.stdout.write(`  ${ROLES.length} roles, ${PERMISSIONS.length} permissions\n`);

    const all = (await readdir(SEEDS_DIR)).filter((file) => file.endsWith('.sql')).sort();
    // Settings defaults are safe everywhere; demo registry data is not.
    const alwaysSafe = all.filter((file) => file.includes('settings'));
    await runSqlSeeds(alwaysSafe);

    if (demo) {
      if (cfg.isProduction) {
        throw new Error('--demo is refused when NODE_ENV=production');
      }
      await runSqlSeeds(all.filter((file) => !alwaysSafe.includes(file)));
      await seedLocalOperator();
    }

    process.stdout.write('Seed complete.\n');
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
