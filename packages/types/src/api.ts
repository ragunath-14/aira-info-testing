import type { Environment } from './environment.js';
import type { SubsystemHealth } from './infrastructure.js';
import type { Alert } from './observability.js';

/** Uniform success envelope. Every route returns data plus request metadata. */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta: {
    requestId: string;
    /** Set when the payload came from cache, with its age in milliseconds. */
    cachedAgeMs?: number;
    generatedAt: string;
  };
}

/**
 * Uniform error envelope. `code` is stable and safe to branch on; `message` is
 * always operator-facing prose with no stack trace or credential material.
 */
export interface ApiError {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    /** Field-level validation detail, when applicable. */
    details?: Array<{ path: string; message: string }>;
    /** Set for provider outages so the UI can show last-known-good data. */
    lastSuccessAt?: string | null;
    retryable: boolean;
  };
  meta: { requestId: string; generatedAt: string };
}

export const API_ERROR_CODES = [
  'UNAUTHENTICATED',
  'MFA_REQUIRED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'ENVIRONMENT_FORBIDDEN',
  'CONFIRMATION_REQUIRED',
  'CONFIRMATION_MISMATCH',
  'APPROVAL_REQUIRED',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_AUTH_FAILED',
  'QUERY_REJECTED',
  'QUERY_TIMEOUT',
  'READ_ONLY_MODE',
  'WRITE_MODE_REQUIRED',
  'OPERATION_NOT_ALLOWED',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface DashboardOverview {
  generatedAt: string;
  /** 0-100. Derived only from subsystems that actually reported. */
  healthScore: number;
  /** Subsystems whose state is unknown, excluded from the score. */
  unreportedSubsystems: string[];
  subsystems: SubsystemHealth[];
  digitalocean: {
    configured: boolean;
    dropletTotal: number;
    dropletActive: number;
    dropletOff: number;
    byEnvironment: Record<Environment, number>;
    regions: string[];
  };
  proxmox: {
    configured: boolean;
    clusterName: string | null;
    nodeTotal: number;
    nodeOnline: number;
    qemuRunning: number;
    qemuTotal: number;
    lxcRunning: number;
    lxcTotal: number;
  };
  applications: {
    total: number;
    healthy: number;
    degraded: number;
    down: number;
    unknown: number;
    deploying: number;
  };
  databases: {
    total: number;
    reachable: number;
    unreachable: number;
    productionReadOnly: boolean;
    totalSizeBytes: number | null;
  };
  redis: { configured: boolean; reachable: boolean };
  alerts: { critical: number; warning: number; info: number; unacknowledged: number };
  recentAlerts: Alert[];
}

export interface SelfHealthReport {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  environment: Environment;
  uptimeSeconds: number;
  checks: Array<{
    name: string;
    status: 'ok' | 'degraded' | 'error' | 'skipped';
    latencyMs: number | null;
    detail: string | null;
  }>;
  checkedAt: string;
}
