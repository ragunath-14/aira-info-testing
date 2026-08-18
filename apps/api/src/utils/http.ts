import { Agent, request, type Dispatcher } from 'undici';
import { AppError, errors } from './errors.js';
import { redactString } from './redaction.js';

export interface ProviderHttpOptions {
  /** Provider name used in operator-facing error messages. */
  provider: string;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  /** Retries for idempotent requests only. */
  retries?: number;
  /** TLS options for internal endpoints with a private CA (Proxmox). */
  tls?: { rejectUnauthorized: boolean; ca?: Buffer };
  /** Unix socket to dial instead of TCP (Docker engine). */
  socketPath?: string;
  /** Called with the timestamp of every successful response. */
  onSuccess?: (at: Date) => void;
  onFailure?: (at: Date, code: string) => void;
}

export interface ProviderRequestOptions {
  method?: Dispatcher.HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON-encoded automatically. Mutually exclusive with `rawBody`. */
  body?: unknown;
  /** Pre-encoded body for endpoints that require a non-JSON content type. */
  rawBody?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Overrides the client default; POST/PUT default to zero retries. */
  retries?: number;
  /** Treat these statuses as a normal result instead of an error. */
  acceptStatuses?: number[];
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Minimal provider HTTP client. Every outbound infrastructure call goes through
 * here so timeout, retry, error classification and redaction behave the same
 * across DigitalOcean, Proxmox, Prometheus, Alertmanager and Grafana.
 *
 * The browser never talks to these endpoints; this client is server-only.
 */
export class ProviderHttpClient {
  private readonly agent: Agent;
  private lastSuccessAt: Date | null = null;

  constructor(private readonly options: ProviderHttpOptions) {
    this.agent = new Agent({
      connect: {
        ...(options.tls
          ? { rejectUnauthorized: options.tls.rejectUnauthorized, ca: options.tls.ca }
          : {}),
        ...(options.socketPath ? { socketPath: options.socketPath } : {}),
      },
      headersTimeout: options.timeoutMs ?? 10_000,
      bodyTimeout: options.timeoutMs ?? 10_000,
      keepAliveTimeout: 30_000,
      connections: 16,
    });
  }

  get lastSuccessIso(): string | null {
    return this.lastSuccessAt?.toISOString() ?? null;
  }

  async json<T>(options: ProviderRequestOptions): Promise<T> {
    const { body, status } = await this.send(options);
    if (body.length === 0) return undefined as T;
    try {
      return JSON.parse(body) as T;
    } catch (error) {
      throw new AppError({
        code: 'PROVIDER_UNAVAILABLE',
        message: `${this.options.provider} returned a response the console could not parse.`,
        httpStatus: 502,
        retryable: true,
        internal: { status, preview: redactString(body.slice(0, 300)) },
        cause: error,
      });
    }
  }

  async text(options: ProviderRequestOptions): Promise<string> {
    const { body } = await this.send(options);
    return body;
  }

  private async send(
    options: ProviderRequestOptions,
  ): Promise<{ body: string; status: number; headers: Record<string, string | string[] | undefined> }> {
    const method = options.method ?? 'GET';
    const isIdempotent = method === 'GET' || method === 'HEAD';
    const maxAttempts = 1 + (options.retries ?? (isIdempotent ? (this.options.retries ?? 2) : 0));
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 10_000;

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await request(this.buildUrl(options.path, options.query), {
          method,
          dispatcher: this.agent,
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            'user-agent': 'airaos-infra-console/1.0',
            ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...this.options.defaultHeaders,
            ...options.headers,
          },
          body:
            options.rawBody !== undefined
              ? options.rawBody
              : options.body === undefined
                ? undefined
                : JSON.stringify(options.body),
        });

        const body = await response.body.text();
        const status = response.statusCode;

        if (status >= 200 && status < 300) {
          this.lastSuccessAt = new Date();
          this.options.onSuccess?.(this.lastSuccessAt);
          return { body, status, headers: response.headers as Record<string, string> };
        }
        if (options.acceptStatuses?.includes(status)) {
          return { body, status, headers: response.headers as Record<string, string> };
        }

        const mapped = this.mapStatus(status, response.headers, body);
        // Retry only transient classes, and only while attempts remain.
        if (RETRYABLE_STATUSES.has(status) && attempt < maxAttempts) {
          lastError = mapped;
          await delay(backoffMs(attempt));
          continue;
        }
        this.options.onFailure?.(new Date(), mapped.code);
        throw mapped;
      } catch (error) {
        if (error instanceof AppError) {
          if (attempt < maxAttempts && error.retryable) {
            lastError = error;
            await delay(backoffMs(attempt));
            continue;
          }
          throw error;
        }

        const isAbort =
          (error as { name?: string }).name === 'AbortError' ||
          (error as { code?: string }).code === 'UND_ERR_ABORTED' ||
          (error as { code?: string }).code === 'UND_ERR_HEADERS_TIMEOUT' ||
          (error as { code?: string }).code === 'UND_ERR_BODY_TIMEOUT';

        lastError = isAbort
          ? errors.providerTimeout(this.options.provider, this.lastSuccessIso)
          : errors.providerUnavailable(this.options.provider, this.lastSuccessIso, {
              cause: redactString(String((error as Error)?.message ?? error)),
            });

        if (attempt < maxAttempts) {
          await delay(backoffMs(attempt));
          continue;
        }
        this.options.onFailure?.(new Date(), isAbort ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE');
        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? errors.providerUnavailable(this.options.provider, this.lastSuccessIso);
  }

  private buildUrl(path: string, query?: ProviderRequestOptions['query']): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private mapStatus(
    status: number,
    headers: Record<string, unknown>,
    body: string,
  ): AppError {
    const { provider } = this.options;
    if (status === 401 || status === 403) {
      return errors.providerAuthFailed(provider);
    }
    if (status === 404) {
      return errors.notFound(`${provider} resource`);
    }
    if (status === 429) {
      const retryAfter = Number(headers['retry-after'] ?? headers['ratelimit-reset'] ?? 0);
      return errors.providerRateLimited(provider, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    if (status >= 500) {
      return errors.providerUnavailable(provider, this.lastSuccessIso, {
        status,
        preview: redactString(body.slice(0, 300)),
      });
    }
    return new AppError({
      code: 'PROVIDER_UNAVAILABLE',
      message: `${provider} rejected the request (HTTP ${status}).`,
      httpStatus: 502,
      internal: { status, preview: redactString(body.slice(0, 300)) },
    });
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}

function backoffMs(attempt: number): number {
  // 150ms, 400ms, 900ms with jitter — enough to ride out a provider blip.
  const base = 150 * attempt ** 1.6;
  return Math.round(base + Math.random() * 100);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
