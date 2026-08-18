import type { ApiErrorCode } from '@airaos/types';

interface AppErrorOptions {
  code: ApiErrorCode;
  message: string;
  httpStatus: number;
  retryable?: boolean;
  details?: Array<{ path: string; message: string }>;
  /** Internal-only context: logged, never serialised to the client. */
  internal?: Record<string, unknown>;
  cause?: unknown;
  lastSuccessAt?: string | null;
}

/**
 * The single error type routes throw. `message` is written for an operator and
 * is safe to display; anything sensitive belongs in `internal`, which only ever
 * reaches the log (spec section 35: no stack traces or credentials to users).
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Array<{ path: string; message: string }>;
  readonly internal?: Record<string, unknown>;
  readonly lastSuccessAt?: string | null;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.internal = options.internal;
    this.lastSuccessAt = options.lastSuccessAt;
  }
}

export const errors = {
  unauthenticated: (message = 'Sign in to continue.') =>
    new AppError({ code: 'UNAUTHENTICATED', message, httpStatus: 401 }),

  mfaRequired: () =>
    new AppError({
      code: 'MFA_REQUIRED',
      message: 'This console requires multi-factor authentication on your AIRAOS account.',
      httpStatus: 401,
    }),

  sessionExpired: () =>
    new AppError({
      code: 'SESSION_EXPIRED',
      message: 'Your session expired. Sign in again to continue.',
      httpStatus: 401,
    }),

  forbidden: (message = 'You do not have permission to perform this action.', internal?: Record<string, unknown>) =>
    new AppError({ code: 'FORBIDDEN', message, httpStatus: 403, internal }),

  environmentForbidden: (environment: string) =>
    new AppError({
      code: 'ENVIRONMENT_FORBIDDEN',
      message: `Your role does not permit actions in the ${environment} environment.`,
      httpStatus: 403,
      internal: { environment },
    }),

  confirmationRequired: (expected: string) =>
    new AppError({
      code: 'CONFIRMATION_REQUIRED',
      message: `Type "${expected}" to confirm this action.`,
      httpStatus: 400,
    }),

  confirmationMismatch: () =>
    new AppError({
      code: 'CONFIRMATION_MISMATCH',
      message: 'The confirmation text did not match the resource name. Nothing was changed.',
      httpStatus: 400,
    }),

  approvalRequired: (message = 'A second authorised operator must approve this action.') =>
    new AppError({ code: 'APPROVAL_REQUIRED', message, httpStatus: 409 }),

  validation: (details: Array<{ path: string; message: string }>) =>
    new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The request was rejected by validation.',
      httpStatus: 400,
      details,
    }),

  notFound: (what = 'Resource') =>
    new AppError({ code: 'NOT_FOUND', message: `${what} not found.`, httpStatus: 404 }),

  conflict: (message: string) =>
    new AppError({ code: 'CONFLICT', message, httpStatus: 409 }),

  providerNotConfigured: (provider: string) =>
    new AppError({
      code: 'PROVIDER_NOT_CONFIGURED',
      message: `${provider} is not configured on this console instance.`,
      httpStatus: 503,
    }),

  providerUnavailable: (provider: string, lastSuccessAt: string | null, internal?: Record<string, unknown>) =>
    new AppError({
      code: 'PROVIDER_UNAVAILABLE',
      message: `${provider} is unavailable right now.`,
      httpStatus: 503,
      retryable: true,
      lastSuccessAt,
      internal,
    }),

  providerTimeout: (provider: string, lastSuccessAt: string | null = null) =>
    new AppError({
      code: 'PROVIDER_TIMEOUT',
      message: `${provider} did not respond in time.`,
      httpStatus: 504,
      retryable: true,
      lastSuccessAt,
    }),

  providerRateLimited: (provider: string, retryAfterSeconds?: number) =>
    new AppError({
      code: 'PROVIDER_RATE_LIMITED',
      message: retryAfterSeconds
        ? `${provider} rate limit reached. Retry in ${retryAfterSeconds}s.`
        : `${provider} rate limit reached.`,
      httpStatus: 429,
      retryable: true,
      internal: { retryAfterSeconds },
    }),

  providerAuthFailed: (provider: string) =>
    new AppError({
      code: 'PROVIDER_AUTH_FAILED',
      message: `${provider} rejected the console's credentials. An administrator needs to rotate them.`,
      httpStatus: 502,
    }),

  queryRejected: (message: string, internal?: Record<string, unknown>) =>
    new AppError({ code: 'QUERY_REJECTED', message, httpStatus: 400, internal }),

  queryTimeout: (timeoutMs: number) =>
    new AppError({
      code: 'QUERY_TIMEOUT',
      message: `The query exceeded the ${timeoutMs}ms limit and was cancelled.`,
      httpStatus: 504,
    }),

  readOnlyMode: (environment: string) =>
    new AppError({
      code: 'READ_ONLY_MODE',
      message: `${environment} databases are read-only in this console. Only SELECT and EXPLAIN are permitted.`,
      httpStatus: 403,
    }),

  writeModeRequired: () =>
    new AppError({
      code: 'WRITE_MODE_REQUIRED',
      message: 'Activate a write window before running statements that change data.',
      httpStatus: 403,
    }),

  operationNotAllowed: (message: string, internal?: Record<string, unknown>) =>
    new AppError({ code: 'OPERATION_NOT_ALLOWED', message, httpStatus: 403, internal }),

  rateLimited: (retryAfterSeconds: number) =>
    new AppError({
      code: 'RATE_LIMITED',
      message: `Too many requests. Retry in ${retryAfterSeconds}s.`,
      httpStatus: 429,
      retryable: true,
    }),

  internal: (internal?: Record<string, unknown>, cause?: unknown) =>
    new AppError({
      code: 'INTERNAL_ERROR',
      message: 'The console hit an unexpected error. The request id below will appear in the logs.',
      httpStatus: 500,
      internal,
      cause,
    }),
};

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
