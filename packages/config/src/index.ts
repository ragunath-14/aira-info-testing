import { z } from 'zod';

const boolish = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === '' ? undefined : value));

const base64Key = (bytes: number) =>
  z
    .string()
    .trim()
    .refine((value) => {
      try {
        return Buffer.from(value, 'base64').length === bytes;
      } catch {
        return false;
      }
    }, `Must be ${bytes} random bytes, base64 encoded (openssl rand -base64 ${bytes})`);

const csvOrigins = z
  .string()
  .default('http://localhost:3000')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'testing', 'staging', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: csvOrigins,

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: boolish(false),

  ENCRYPTION_KEY: base64Key(32),
  AUDIT_LOG_SECRET: z.string().trim().min(16, 'AUDIT_LOG_SECRET must be at least 16 characters'),
  SESSION_SECRET: z.string().trim().min(32, 'SESSION_SECRET must be at least 32 characters'),

  AIRAOS_AUTH_URL: optionalString,
  AIRAOS_AUTH_CLIENT_ID: optionalString,
  AIRAOS_AUTH_SECRET: optionalString,
  AIRAOS_AUTH_ISSUER: optionalString,
  AIRAOS_AUTH_JWKS_URL: optionalString,
  AUTH_REQUIRE_MFA: boolish(true),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(480),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  LOCAL_AUTH_ENABLED: boolish(false),

  DIGITALOCEAN_API_TOKEN: optionalString,
  DIGITALOCEAN_WRITE_API_TOKEN: optionalString,
  DIGITALOCEAN_API_URL: z.string().url().default('https://api.digitalocean.com/v2'),

  PROXMOX_API_URL: optionalString,
  PROXMOX_TOKEN_ID: optionalString,
  PROXMOX_TOKEN_SECRET: optionalString,
  PROXMOX_TLS_REJECT_UNAUTHORIZED: boolish(true),
  PROXMOX_CA_CERT_PATH: optionalString,

  PROMETHEUS_URL: optionalString,
  ALERTMANAGER_URL: optionalString,
  GRAFANA_URL: optionalString,
  GRAFANA_TOKEN: optionalString,
  PROMETHEUS_USERNAME: optionalString,
  PROMETHEUS_PASSWORD: optionalString,

  REDIS_URL: optionalString,

  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(15_000),
  DB_QUERY_MAX_ROWS: z.coerce.number().int().min(1).max(100_000).default(1000),
  DB_QUERY_MAX_CONNECTIONS_PER_TARGET: z.coerce.number().int().min(1).max(50).default(5),
  DB_WRITE_MODE_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig extends RawEnv {
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  /** True when a central AIRAOS identity provider is configured. */
  ssoConfigured: boolean;
  providers: {
    digitalocean: boolean;
    proxmox: boolean;
    prometheus: boolean;
    alertmanager: boolean;
    grafana: boolean;
    redis: boolean;
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses and validates process.env. Fails fast: a console that starts with a
 * half-configured secret set is worse than one that refuses to boot.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }

  const env = parsed.data;
  const ssoConfigured = Boolean(env.AIRAOS_AUTH_URL && env.AIRAOS_AUTH_CLIENT_ID);
  const isProduction = env.NODE_ENV === 'production';

  const issues: string[] = [];

  // Rule: production must never fall back to the development login path.
  if (isProduction && env.LOCAL_AUTH_ENABLED) {
    issues.push('LOCAL_AUTH_ENABLED must be false when NODE_ENV=production');
  }
  if (isProduction && !ssoConfigured) {
    issues.push('AIRAOS_AUTH_URL and AIRAOS_AUTH_CLIENT_ID are required in production');
  }
  if (!ssoConfigured && !env.LOCAL_AUTH_ENABLED) {
    issues.push(
      'No authentication method configured: set AIRAOS_AUTH_URL or enable LOCAL_AUTH_ENABLED for development',
    );
  }
  if (isProduction && !env.PROXMOX_TLS_REJECT_UNAUTHORIZED && !env.PROXMOX_CA_CERT_PATH) {
    issues.push(
      'PROXMOX_TLS_REJECT_UNAUTHORIZED=false requires PROXMOX_CA_CERT_PATH so the internal CA can be trusted explicitly',
    );
  }
  if (isProduction && env.CORS_ORIGINS.some((origin) => origin.includes('localhost'))) {
    issues.push('CORS_ORIGINS must not include localhost in production');
  }
  if (env.SESSION_IDLE_TIMEOUT_MINUTES > env.SESSION_TTL_MINUTES) {
    issues.push('SESSION_IDLE_TIMEOUT_MINUTES cannot exceed SESSION_TTL_MINUTES');
  }
  if (env.PROXMOX_API_URL && !(env.PROXMOX_TOKEN_ID && env.PROXMOX_TOKEN_SECRET)) {
    issues.push('PROXMOX_API_URL is set but PROXMOX_TOKEN_ID / PROXMOX_TOKEN_SECRET are missing');
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    ...env,
    isProduction,
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    ssoConfigured,
    providers: {
      digitalocean: Boolean(env.DIGITALOCEAN_API_TOKEN),
      proxmox: Boolean(env.PROXMOX_API_URL && env.PROXMOX_TOKEN_ID && env.PROXMOX_TOKEN_SECRET),
      prometheus: Boolean(env.PROMETHEUS_URL),
      alertmanager: Boolean(env.ALERTMANAGER_URL),
      grafana: Boolean(env.GRAFANA_URL),
      redis: Boolean(env.REDIS_URL),
    },
  };
}

/**
 * Names of every variable that holds secret material. Used by the logger's
 * redaction pass and by the settings API to refuse to echo values.
 */
export const SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'ENCRYPTION_KEY',
  'AUDIT_LOG_SECRET',
  'SESSION_SECRET',
  'AIRAOS_AUTH_SECRET',
  'DIGITALOCEAN_API_TOKEN',
  'DIGITALOCEAN_WRITE_API_TOKEN',
  'PROXMOX_TOKEN_SECRET',
  'GRAFANA_TOKEN',
  'PROMETHEUS_PASSWORD',
  'REDIS_URL',
] as const;
