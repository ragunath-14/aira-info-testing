import fs from 'node:fs';
import path from 'node:path';

/**
 * Next only reads .env from its own project directory, but this is a monorepo
 * with a single .env at the root. Load it here so `npm run dev` and `npm run
 * build` behave the way docs/setup.md describes.
 *
 * Existing values win, so a real environment (compose, CI) is never overridden.
 */
const rootEnv = path.join(import.meta.dirname, '../../.env');
if (fs.existsSync(rootEnv)) {
  for (const line of fs.readFileSync(rootEnv, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '');
  }
}

/**
 * Next.js configuration for the AIRAOS Infra Console.
 *
 * The browser never talks to the API directly: it calls `/api/proxy/*` on this
 * origin, which the route handler in app/api/proxy forwards server-side. That
 * keeps the API unexposed, makes the session cookie same-origin, and means no
 * infrastructure credential is ever within reach of client JavaScript (rule 1).
 */
const isDevelopment = process.env.NODE_ENV !== 'production';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
  {
    // The console loads no third-party script, style, font or image. Grafana is
    // linked out to rather than embedded, so frame-src stays closed.
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // 'unsafe-eval' is development-only: Next's React Refresh runtime evaluates
      // strings, and without it the dev bundle never hydrates. Production builds
      // contain no eval, so the directive is omitted there — do not add it.
      isDevelopment ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      isDevelopment ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Standalone output keeps the runtime image to the server bundle plus traced
  // dependencies (see docker/Dockerfile.web).
  output: 'standalone',
  transpilePackages: ['@airaos/types', '@airaos/validation'],
  // Pin the trace root to the monorepo so Next does not pick up an unrelated
  // lockfile higher up the filesystem.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': import.meta.dirname,
    };
    return config;
  },
};

export default nextConfig;
