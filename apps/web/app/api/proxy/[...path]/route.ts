import { NextResponse, type NextRequest } from 'next/server';

/**
 * Server-side API proxy.
 *
 * Everything the browser does goes through here. The browser calls
 * `/api/proxy/<api path>` on the console's own origin; this handler forwards it
 * to the internal API and streams the response back.
 *
 * Why a proxy rather than calling the API directly from the browser:
 *
 *  - The API never needs a public route, so infrastructure credentials stay on
 *    a network the browser cannot reach (rule 1).
 *  - The session cookie is same-origin and stays httpOnly.
 *  - Exactly one place applies the CSRF header and strips hop-by-hop headers.
 *
 * The path is not concatenated blindly: it is rebuilt from the validated
 * segments so a request cannot escape the /api/v1 prefix.
 */

const API_BASE = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

const CSRF_COOKIE = 'airaos_console_csrf';
const CSRF_HEADER = 'x-airaos-csrf';

/** Segment characters permitted in an API path. */
const SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;

/** Request headers worth forwarding. Everything else is dropped. */
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'cookie', 'x-request-id', CSRF_HEADER];

/** Response headers worth returning. */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'cache-control',
  'set-cookie',
  'x-request-id',
  'retry-after',
];

function buildTargetUrl(segments: string[], search: string): string | null {
  if (segments.length === 0) return null;
  for (const segment of segments) {
    // Rejects traversal, encoded slashes and anything else surprising.
    if (!SEGMENT_PATTERN.test(segment)) return null;
  }
  return `${API_BASE}/api/v1/${segments.join('/')}${search}`;
}

async function forward(request: NextRequest, segments: string[]): Promise<Response> {
  const target = buildTargetUrl(segments, request.nextUrl.search);
  if (!target) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Unsupported API path.', retryable: false },
        meta: { requestId: 'proxy', generatedAt: new Date().toISOString() },
      },
      { status: 404 },
    );
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // The CSRF cookie is readable by client script; the API compares the header
  // against the cookie. Setting it here means a fetch that forgot the header
  // still passes, while a cross-site request — which cannot read the cookie —
  // still fails.
  const csrfCookie = request.cookies.get(CSRF_COOKIE)?.value;
  if (csrfCookie && !headers.has(CSRF_HEADER)) {
    headers.set(CSRF_HEADER, csrfCookie);
  }

  // Preserves the operator's address for the audit trail. The API trusts this
  // only because it is configured to sit behind this proxy.
  const clientIp = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip');
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  headers.set('origin', request.nextUrl.origin);

  const hasBody = !['GET', 'HEAD'].includes(request.method);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.text() : undefined,
      // Console data is never cached at this layer.
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'The console API is not reachable. It may be restarting.',
          retryable: true,
        },
        meta: { requestId: 'proxy', generatedAt: new Date().toISOString() },
      },
      { status: 503 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    // getSetCookie preserves multiple Set-Cookie headers, which a plain get()
    // would collapse into one malformed value.
    if (name === 'set-cookie') {
      for (const cookie of upstream.headers.getSetCookie()) {
        responseHeaders.append('set-cookie', cookie);
      }
      continue;
    }
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set('cache-control', 'no-store');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return forward(request, (await context.params).path);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return forward(request, (await context.params).path);
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<Response> {
  return forward(request, (await context.params).path);
}

export async function PUT(request: NextRequest, context: RouteContext): Promise<Response> {
  return forward(request, (await context.params).path);
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  return forward(request, (await context.params).path);
}

// Streamed endpoints (the log tail) need the Node runtime, not the edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
