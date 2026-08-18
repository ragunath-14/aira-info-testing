import { SECRET_ENV_KEYS } from '@airaos/config';
import type { AuthenticatedUser } from '@airaos/types';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { orm, schema } from '../db/drizzle.js';
import { errors } from '../utils/errors.js';

/**
 * Console settings (spec section 34).
 *
 * Only operational policy lives here — cache TTLs, retention windows, timeouts.
 * Credentials never do, and `assertNotSecretLike` refuses keys that look like
 * they might carry one, so a future contributor cannot quietly turn this table
 * into a secret store (rule 7).
 */

export interface ConsoleSetting {
  key: string;
  value: string | number | boolean | null;
  description: string | null;
  updatedByEmail: string | null;
  updatedAt: string;
}

const SECRET_KEY_PATTERN =
  /(password|secret|token|api[-_.]?key|credential|private[-_.]?key|dsn|connection[-_.]?string)/i;

function assertNotSecretLike(key: string): void {
  if (SECRET_KEY_PATTERN.test(key)) {
    throw errors.validation([
      {
        path: 'key',
        message:
          'Settings cannot hold credentials. Use the environment or the secret manager instead.',
      },
    ]);
  }
}

export async function listSettings(): Promise<ConsoleSetting[]> {
  const rows = await orm()
    .select({
      key: schema.consoleSettings.key,
      value: schema.consoleSettings.value,
      description: schema.consoleSettings.description,
      email: schema.users.email,
      updatedAt: schema.consoleSettings.updatedAt,
    })
    .from(schema.consoleSettings)
    .leftJoin(schema.users, eq(schema.users.id, schema.consoleSettings.updatedBy))
    .orderBy(schema.consoleSettings.key);

  return rows.map((row) => ({
    key: row.key,
    value: row.value as ConsoleSetting['value'],
    description: row.description,
    updatedByEmail: row.email,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function updateSetting(
  actor: AuthenticatedUser,
  key: string,
  value: string | number | boolean | null,
): Promise<ConsoleSetting> {
  assertNotSecretLike(key);

  // Policy settings that would weaken a guardrail are refused outright rather
  // than silently accepted and ignored.
  if (key === 'database.production_read_only' && value !== true) {
    throw errors.operationNotAllowed(
      'Production databases are read-only by default and that cannot be turned off. Use a time-boxed write window instead.',
    );
  }
  if (key === 'deployments.require_production_approval' && value !== true) {
    throw errors.operationNotAllowed(
      'Production deployment approval cannot be disabled from the console.',
    );
  }

  const [row] = await orm()
    .update(schema.consoleSettings)
    // `value` is a jsonb column, so Drizzle serialises the value as-is; a bare
    // null must stay a JSON null rather than becoming SQL NULL.
    .set({ value: value as never, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(schema.consoleSettings.key, key))
    .returning({
      key: schema.consoleSettings.key,
      value: schema.consoleSettings.value,
      description: schema.consoleSettings.description,
      updatedAt: schema.consoleSettings.updatedAt,
    });

  if (!row) throw errors.notFound(`Setting "${key}"`);

  return {
    key: row.key,
    value: row.value as ConsoleSetting['value'],
    description: row.description,
    updatedByEmail: actor.email,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Non-sensitive runtime configuration, for the Settings page.
 *
 * Every value here is either a boolean "is it configured", a non-secret URL, or a
 * numeric limit. Secret-bearing variables are reported as configured/not, never
 * echoed (rule 1).
 */
export function runtimeSummary(): {
  environment: string;
  nodeEnv: string;
  appUrl: string;
  auth: { ssoConfigured: boolean; localAuthEnabled: boolean; requireMfa: boolean; sessionTtlMinutes: number; idleTimeoutMinutes: number };
  providers: Record<string, boolean>;
  urls: Record<string, string | null>;
  limits: Record<string, number>;
  secretsConfigured: Record<string, boolean>;
} {
  const cfg = config();

  return {
    environment: cfg.APP_ENV,
    nodeEnv: cfg.NODE_ENV,
    appUrl: cfg.APP_URL,
    auth: {
      ssoConfigured: cfg.ssoConfigured,
      localAuthEnabled: cfg.LOCAL_AUTH_ENABLED,
      requireMfa: cfg.AUTH_REQUIRE_MFA,
      sessionTtlMinutes: cfg.SESSION_TTL_MINUTES,
      idleTimeoutMinutes: cfg.SESSION_IDLE_TIMEOUT_MINUTES,
    },
    providers: cfg.providers,
    urls: {
      prometheus: cfg.PROMETHEUS_URL ?? null,
      alertmanager: cfg.ALERTMANAGER_URL ?? null,
      grafana: cfg.GRAFANA_URL ?? null,
      proxmox: cfg.PROXMOX_API_URL ?? null,
      digitalocean: cfg.DIGITALOCEAN_API_URL,
    },
    limits: {
      queryTimeoutMs: cfg.DB_QUERY_TIMEOUT_MS,
      queryMaxRows: cfg.DB_QUERY_MAX_ROWS,
      maxConnectionsPerTarget: cfg.DB_QUERY_MAX_CONNECTIONS_PER_TARGET,
      writeModeTtlMinutes: cfg.DB_WRITE_MODE_TTL_MINUTES,
    },
    secretsConfigured: Object.fromEntries(
      SECRET_ENV_KEYS.map((key) => [key, Boolean(process.env[key]?.trim())]),
    ),
  };
}
