import { NextResponse } from 'next/server';

/**
 * Forwards to the API's own /health endpoint.
 *
 * The proxy route only covers /api/v1/*, and /health deliberately sits outside
 * that prefix so a load balancer can reach it without authentication. This
 * handler exists so the Health page can display the same report.
 */
const API_BASE = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

export async function GET(): Promise<Response> {
  try {
    const upstream = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      { status: 'error', detail: 'The console API is not reachable.' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
