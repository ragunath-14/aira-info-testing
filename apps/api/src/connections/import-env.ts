import path from 'node:path';
import { CONNECTION_TYPES, type ConnectionType } from '@airaos/types';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { orm } from '../db/drizzle.js';
import { connections } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { aad, seal } from '../security/crypto.js';
import * as registry from '../providers/registry.js';
import { resolve } from './resolver.js';

/**
 * Migrates .env provider configuration into saved connections (spec section 29).
 *
 *   npm run connections:import -w @airaos/api            # report what it would do
 *   npm run connections:import -w @airaos/api -- --apply # write the connections
 *
 * Behaviour that matters:
 *
 *  - Dry-run by default. It prints what it would create and nothing else.
 *  - Idempotent: a connection of the same type and environment is skipped, so
 *    re-running after a partial import is safe.
 *  - Tests each candidate before writing it, and reports failures rather than
 *    saving a connection that has never worked.
 *  - Never prints a secret. Values are sealed on the way in and the output only
 *    ever says whether one was present.
 *
 * The .env variables are left in place. They keep working as the fallback until
 * they are removed, so this migration cannot break a running instance.
 */

interface Candidate {
  type: ConnectionType;
  name: string;
  environment: string;
  configuration: Record<string, unknown>;
  secrets: Record<string, string>;
}

/**
 * Reads candidates from the environment via the resolver, so this command and the
 * running application agree on exactly what .env provides.
 */
async function collect(): Promise<Candidate[]> {
  const cfg = config();
  const candidates: Candidate[] = [];

  for (const type of CONNECTION_TYPES) {
    // PostgreSQL targets are not configured through .env; they already live in
    // database_connections with their own write policy.
    if (type === 'postgres') continue;

    const resolved = await resolve(type);
    // Only environment-sourced configuration is a migration candidate.
    if (!resolved || resolved.connectionId !== null) continue;

    const source = resolved.config as Record<string, unknown>;
    const secrets: Record<string, string> = {};
    const configuration: Record<string, unknown> = {};

    // Split the resolved shape back into settings and secrets. Which keys are
    // secret is a property of the provider, so it is spelled out per type.
    const secretKeys: Record<ConnectionType, string[]> = {
      digitalocean: ['apiToken', 'writeApiToken'],
      proxmox: ['tokenSecret'],
      postgres: ['password'],
      redis: ['password'],
      prometheus: ['password'],
      grafana: ['apiToken'],
    };

    for (const [key, value] of Object.entries(source)) {
      if (value === null || value === undefined || value === '') continue;
      if (secretKeys[type].includes(key)) {
        // Grafana's secret is stored under a distinct name in the bundle.
        secrets[type === 'grafana' && key === 'apiToken' ? 'grafanaToken' : key] = String(value);
      } else {
        configuration[key] = value;
      }
    }

    candidates.push({
      type,
      name: `${type.charAt(0).toUpperCase()}${type.slice(1)} (imported)`,
      environment: cfg.APP_ENV,
      configuration,
      secrets,
    });
  }

  return candidates;
}

async function alreadyExists(type: ConnectionType, environment: string): Promise<boolean> {
  const rows = await orm()
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.type, type),
        eq(connections.environment, environment as 'development' | 'testing' | 'staging' | 'production'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function run(apply: boolean): Promise<void> {
  const out = (line: string) => process.stdout.write(`${line}\n`);

  out('');
  out(apply ? 'Importing .env configuration into connections' : 'Dry run — nothing will be written');
  out('Pass --apply to write the connections.');
  out('');

  const candidates = await collect();

  if (candidates.length === 0) {
    out('  No provider configuration found in the environment.');
    out('  Either everything is already in the Connection Manager, or nothing is configured.');
    out('');
    return;
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const secretCount = Object.keys(candidate.secrets).length;
    out(`  ${candidate.type} → "${candidate.name}" (${candidate.environment})`);
    out(
      `    settings: ${Object.keys(candidate.configuration).join(', ') || 'none'}; secrets: ${
        secretCount === 0 ? 'none' : `${secretCount} present`
      }`,
    );

    if (await alreadyExists(candidate.type, candidate.environment)) {
      out(`    skipped — a ${candidate.type} connection already exists for ${candidate.environment}`);
      skipped += 1;
      out('');
      continue;
    }

    // Test before writing: importing a broken configuration would just move the
    // problem somewhere less obvious.
    const probe = await registry.testConnection(candidate.type, {
      ...candidate.configuration,
      ...candidate.secrets,
      // Grafana's tester expects `apiToken`, not the bundle's storage name.
      ...(candidate.secrets.grafanaToken ? { apiToken: candidate.secrets.grafanaToken } : {}),
    });

    if (!probe.ok) {
      out(`    test FAILED — ${probe.message}`);
      out('    not imported. Fix the configuration, or add it by hand in Settings → Connections.');
      failed += 1;
      out('');
      continue;
    }

    out(`    test passed${probe.latencyMs === null ? '' : ` in ${probe.latencyMs}ms`}`);

    if (!apply) {
      out('    would be created');
      created += 1;
      out('');
      continue;
    }

    const inserted = await orm()
      .insert(connections)
      .values({
        name: candidate.name,
        type: candidate.type,
        environment: candidate.environment as 'development' | 'testing' | 'staging' | 'production',
        description: 'Imported from environment variables.',
        configuration: candidate.configuration,
        status: 'connected',
        lastCheckedAt: new Date(),
        lastSuccessAt: new Date(),
        latencyMs: probe.latencyMs,
        credentialRef: secretCount > 0 ? 'pending' : null,
      })
      .returning({ id: connections.id });

    const id = inserted[0]?.id;
    if (!id) {
      out('    insert returned no id — skipped');
      failed += 1;
      out('');
      continue;
    }

    if (secretCount > 0) {
      await orm()
        .update(connections)
        .set({
          credentialCipher: seal(JSON.stringify(candidate.secrets), aad.connection(id)),
          credentialRef: null,
        })
        .where(eq(connections.id, id));
    }

    out(`    created ${id}`);
    created += 1;
    out('');
  }

  out(
    apply
      ? `Created ${created}, skipped ${skipped}, failed ${failed}.`
      : `Would create ${created}, skip ${skipped}, fail ${failed}.`,
  );

  if (apply && created > 0) {
    out('');
    out('The imported connections are now in use. The .env variables remain as a');
    out('fallback and can be removed once you have confirmed the console works.');
  }
  out('');
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isEntrypoint) {
  const apply = process.argv.includes('--apply');
  try {
    await run(apply);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

export { collect, run };
