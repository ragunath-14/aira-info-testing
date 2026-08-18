import type { Environment } from './environment.js';

/**
 * Connection Manager domain types (spec sections 3-6, 23, 36).
 *
 * Core principle: nothing outside a provider adapter knows a provider's
 * credentials or wire details. The UI works with `Connection`, which carries
 * configuration but never a secret, and `ConnectionTestResult`, which describes
 * what a probe found in provider-neutral terms.
 *
 * Deliberately no `ssh` type — every system is reached over its own native
 * protocol (spec section 26).
 */
export const CONNECTION_TYPES = [
  'digitalocean',
  'proxmox',
  'postgres',
  'redis',
  'prometheus',
  'grafana',
] as const;

export type ConnectionType = (typeof CONNECTION_TYPES)[number];

export function isConnectionType(value: unknown): value is ConnectionType {
  return typeof value === 'string' && (CONNECTION_TYPES as readonly string[]).includes(value);
}

/**
 * `not_tested` exists so an imported or newly created connection is never
 * rendered as healthy before it has actually been probed.
 */
export const CONNECTION_STATUSES = ['connected', 'degraded', 'offline', 'not_tested'] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface ConnectionTypePresentation {
  label: string;
  /** One line describing what this connection gives the console. */
  description: string;
  /** Lucide icon name resolved by the web app. */
  icon: string;
  /** Protocol used, shown in the UI so the choice is not mysterious. */
  transport: string;
  /** True when the type can work with no credential on a trusted network. */
  credentialOptional: boolean;
}

export const CONNECTION_TYPE_PRESENTATION: Record<ConnectionType, ConnectionTypePresentation> = {
  digitalocean: {
    label: 'DigitalOcean',
    description: 'Droplets, volumes, firewalls, snapshots, backups and metrics.',
    icon: 'cloud',
    transport: 'DigitalOcean REST API',
    credentialOptional: false,
  },
  proxmox: {
    label: 'Proxmox',
    description: 'Cluster, nodes, virtual machines, containers and storage.',
    icon: 'server',
    transport: 'Proxmox VE REST API',
    credentialOptional: false,
  },
  postgres: {
    label: 'PostgreSQL',
    description: 'Schema explorer, data browser and SQL editor for one database.',
    icon: 'database',
    transport: 'PostgreSQL wire protocol',
    credentialOptional: false,
  },
  redis: {
    label: 'Redis',
    description: 'Memory, hit rate, evictions and keyspace. Read-only.',
    icon: 'zap',
    transport: 'Redis protocol',
    credentialOptional: true,
  },
  prometheus: {
    label: 'Prometheus',
    description: 'Metrics for the dashboards, from a fixed preset catalogue.',
    icon: 'bar-chart-3',
    transport: 'Prometheus HTTP API',
    credentialOptional: true,
  },
  grafana: {
    label: 'Grafana',
    description: 'Deep-link targets for dashboards. Grafana is not embedded.',
    icon: 'line-chart',
    transport: 'Grafana HTTP API',
    credentialOptional: true,
  },
};

/**
 * A saved connection as it leaves the API.
 *
 * `configuration` holds non-secret settings only. There is no field that could
 * carry a credential, so no response shaped by this type can leak one (rule 1).
 * `hasCredential` lets the UI show that a secret is stored without revealing it.
 */
export interface Connection {
  id: string;
  name: string;
  type: ConnectionType;
  environment: Environment;
  description: string | null;
  configuration: ConnectionConfiguration;
  hasCredential: boolean;
  isEnabled: boolean;
  status: ConnectionStatus;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  /** Sanitised operator-facing message from the last failed probe. */
  lastError: string | null;
  latencyMs: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Non-secret settings, discriminated by connection type. */
export type ConnectionConfiguration =
  | DigitalOceanConfiguration
  | ProxmoxConfiguration
  | PostgresConfiguration
  | RedisConfiguration
  | PrometheusConfiguration
  | GrafanaConfiguration;

export interface DigitalOceanConfiguration {
  apiUrl: string;
  /**
   * True when a separate write-scoped token is stored. Without one, droplet
   * power actions are refused rather than falling back to the read token.
   */
  hasWriteToken: boolean;
}

export interface ProxmoxConfiguration {
  apiUrl: string;
  tokenId: string;
  rejectUnauthorized: boolean;
  caCertPath: string | null;
}

export interface PostgresConfiguration {
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  /** NULL derives from environment: production is read-only by default. */
  readOnlyOverride: boolean | null;
}

export interface RedisConfiguration {
  host: string;
  port: number;
  tls: boolean;
  /** Redis logical database index. */
  db: number;
}

export interface PrometheusConfiguration {
  url: string;
  username: string | null;
}

export interface GrafanaConfiguration {
  url: string;
  organisationId: number | null;
}

/**
 * What a connection test found. Deliberately provider-neutral: `details` is a
 * list of label/value pairs the UI renders as-is, so a new provider needs no UI
 * change to report something useful (spec section 6).
 */
export interface ConnectionTestResult {
  ok: boolean;
  type: ConnectionType;
  /** Operator-facing summary. Never contains credential material. */
  message: string;
  latencyMs: number | null;
  details: Array<{ label: string; value: string }>;
  /** Set when the probe failed, for branching in the UI. */
  errorCode: string | null;
  testedAt: string;
}

export interface ConnectionSummary {
  total: number;
  byStatus: Record<ConnectionStatus, number>;
  byType: Record<ConnectionType, number>;
  /** Types with no enabled connection, so the UI can prompt for setup. */
  missingTypes: ConnectionType[];
}

/**
 * Where a provider's configuration came from.
 *
 * `environment` is the backward-compatibility path: an instance still configured
 * through .env keeps working, and the UI can show that it should be migrated
 * (spec section 29).
 */
export type ConnectionSource = 'connection_manager' | 'environment' | 'none';

export interface ResolvedProviderStatus {
  type: ConnectionType;
  source: ConnectionSource;
  connectionId: string | null;
  connectionName: string | null;
  environment: Environment | null;
  configured: boolean;
}
