'use client';

import type { ApiError, ApiResponse } from '@airaos/types';

/**
 * Browser-side API client.
 *
 * Talks only to the same-origin proxy, never to the API directly. Errors arrive
 * as the API's stable envelope, so `ApiClientError` carries the machine code the
 * UI branches on plus the operator-facing message the API wrote.
 */

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/proxy';
const CSRF_COOKIE = 'airaos_console_csrf';
const CSRF_HEADER = 'x-airaos-csrf';

export class ApiClientError extends Error {
  constructor(
    readonly code: ApiError['error']['code'],
    message: string,
    readonly status: number,
    readonly details?: Array<{ path: string; message: string }>,
    readonly retryable = false,
    readonly lastSuccessAt?: string | null,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  /** True when the operator needs to sign in again rather than retry. */
  get isAuthError(): boolean {
    return (
      this.code === 'UNAUTHENTICATED' ||
      this.code === 'SESSION_EXPIRED' ||
      this.code === 'MFA_REQUIRED'
    );
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  signal?: AbortSignal;
  /** Returns the raw Response for CSV / text downloads. */
  raw?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${BASE}/${path.replace(/^\/+/, '')}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    // Arrays are sent as a comma-separated list, matching the API's csvList.
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const csrf = readCookie(CSRF_COOKIE);
  if (csrf && method !== 'GET') headers[CSRF_HEADER] = csrf;

  const response = await fetch(buildUrl(path, options.query), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    // The session cookie is same-origin and httpOnly.
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal,
  });

  if (options.raw) {
    if (!response.ok) await throwFromResponse(response);
    return response as unknown as T;
  }

  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    // A non-JSON body means something between here and the API broke.
    throw new ApiClientError(
      'INTERNAL_ERROR',
      `The console API returned an unreadable response (HTTP ${response.status}).`,
      response.status,
    );
  }

  if (!payload || payload.ok !== true) {
    const error = payload?.ok === false ? payload.error : null;
    throw new ApiClientError(
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? 'The request failed.',
      response.status,
      error?.details,
      error?.retryable ?? false,
      error?.lastSuccessAt ?? null,
      payload?.meta?.requestId,
    );
  }

  return payload.data;
}

async function throwFromResponse(response: Response): Promise<never> {
  let message = `Request failed (HTTP ${response.status}).`;
  let code: ApiError['error']['code'] = 'INTERNAL_ERROR';
  try {
    const body = (await response.json()) as ApiError;
    if (body?.error) {
      message = body.error.message;
      code = body.error.code;
    }
  } catch {
    // Keep the generic message.
  }
  throw new ApiClientError(code, message, response.status);
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
  /** Downloads a file the API generated (CSV export, log export). */
  download: async (path: string, query?: RequestOptions['query'], filename?: string) => {
    const response = await apiRequest<Response>(path, { method: 'GET', query, raw: true });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename ?? 'airaos-export.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  },
  /** POST that returns a file (the data browser's CSV export). */
  downloadPost: async (path: string, body: unknown, filename: string) => {
    const csrf = readCookie(CSRF_COOKIE);
    const response = await fetch(buildUrl(path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
      },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (!response.ok) await throwFromResponse(response);

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  },
};
