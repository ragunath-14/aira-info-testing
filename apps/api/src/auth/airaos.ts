import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ROLES, type Role } from '@airaos/types';
import { config } from '../config.js';
import { AppError, errors } from '../utils/errors.js';
import { ProviderHttpClient } from '../utils/http.js';
import type { SessionIdentity } from './session.js';

/**
 * AIRAOS single sign-on (spec section 28).
 *
 * Standard OIDC authorization-code flow with PKCE. The console never sees a
 * password: it redirects to AIRAOS, receives a code, and exchanges it
 * server-side. MFA is enforced by inspecting the `amr` / `acr` claims rather
 * than trusting a query parameter.
 */

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let tokenClient: ProviderHttpClient | null = null;

function requireSso(): {
  authUrl: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  jwksUrl: string;
} {
  const cfg = config();
  if (!cfg.AIRAOS_AUTH_URL || !cfg.AIRAOS_AUTH_CLIENT_ID) {
    throw errors.providerNotConfigured('AIRAOS authentication');
  }
  const base = cfg.AIRAOS_AUTH_URL.replace(/\/+$/, '');
  return {
    authUrl: base,
    clientId: cfg.AIRAOS_AUTH_CLIENT_ID,
    clientSecret: cfg.AIRAOS_AUTH_SECRET ?? '',
    issuer: cfg.AIRAOS_AUTH_ISSUER ?? base,
    jwksUrl: cfg.AIRAOS_AUTH_JWKS_URL ?? `${base}/.well-known/jwks.json`,
  };
}

export function redirectUri(): string {
  return `${config().APP_URL.replace(/\/+$/, '')}/auth/callback`;
}

export function buildAuthorizationRequest(): AuthorizationRequest {
  const sso = requireSso();
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const url = new URL(`${sso.authUrl}/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', sso.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', 'openid profile email airaos.roles');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (config().AUTH_REQUIRE_MFA) {
    // Ask the IdP to step the user up rather than bouncing them after the fact.
    url.searchParams.set('acr_values', 'mfa');
  }

  return { url: url.toString(), state, codeVerifier, nonce };
}

interface TokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

function client(): ProviderHttpClient {
  if (!tokenClient) {
    const sso = requireSso();
    tokenClient = new ProviderHttpClient({
      provider: 'AIRAOS authentication',
      baseUrl: sso.authUrl,
      timeoutMs: 8000,
      retries: 1,
    });
  }
  return tokenClient;
}

/**
 * Exchanges an authorization code for tokens, verifies the ID token signature
 * and claims, and maps the result onto a console identity.
 */
export async function exchangeCode(input: {
  code: string;
  codeVerifier: string;
  nonce: string;
}): Promise<SessionIdentity> {
  const sso = requireSso();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: redirectUri(),
    client_id: sso.clientId,
    code_verifier: input.codeVerifier,
  });
  if (sso.clientSecret) body.set('client_secret', sso.clientSecret);

  const raw = await client().text({
    method: 'POST',
    path: '/oauth2/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    rawBody: body.toString(),
    timeoutMs: 8000,
    // Never retry a code exchange: authorization codes are single-use.
    retries: 0,
    // Handled below so an IdP validation error becomes a clear login failure
    // rather than a generic provider outage.
    acceptStatuses: [400, 401],
  });

  let tokens: TokenResponse;
  try {
    tokens = JSON.parse(raw) as TokenResponse;
  } catch {
    throw errors.providerUnavailable('AIRAOS authentication', null);
  }
  if (!tokens.id_token) {
    throw new AppError({
      code: 'UNAUTHENTICATED',
      message: 'AIRAOS did not return an identity token. Try signing in again.',
      httpStatus: 401,
    });
  }

  return verifyIdToken(tokens.id_token, input.nonce);
}

export async function verifyIdToken(idToken: string, nonce?: string): Promise<SessionIdentity> {
  const sso = requireSso();
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(sso.jwksUrl), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(idToken, jwks, {
      issuer: sso.issuer,
      audience: sso.clientId,
      clockTolerance: 30,
    });
    payload = verified.payload;
  } catch (error) {
    throw new AppError({
      code: 'UNAUTHENTICATED',
      message: 'The AIRAOS identity token could not be verified.',
      httpStatus: 401,
      internal: { reason: (error as Error).message },
      cause: error,
    });
  }

  if (nonce && payload.nonce !== nonce) {
    throw new AppError({
      code: 'UNAUTHENTICATED',
      message: 'Sign-in could not be completed. Start again from the login page.',
      httpStatus: 401,
      internal: { reason: 'nonce mismatch' },
    });
  }

  const email = typeof payload.email === 'string' ? payload.email : null;
  if (!email) {
    throw new AppError({
      code: 'UNAUTHENTICATED',
      message: 'The AIRAOS account has no email address, which the console requires.',
      httpStatus: 401,
    });
  }

  const mfaVerified = hasMfaClaim(payload);
  if (config().AUTH_REQUIRE_MFA && !mfaVerified) {
    throw errors.mfaRequired();
  }

  return {
    externalId: typeof payload.sub === 'string' ? payload.sub : null,
    email,
    name: typeof payload.name === 'string' ? payload.name : email.split('@')[0] ?? email,
    mfaVerified,
    assertedRoles: extractRoles(payload),
  };
}

/**
 * MFA is considered satisfied when the IdP says so via `amr` (RFC 8176) or an
 * `acr` value the AIRAOS provider uses for stepped-up sessions.
 */
function hasMfaClaim(payload: JWTPayload): boolean {
  const amr = payload.amr;
  if (Array.isArray(amr)) {
    const methods = amr.map((value) => String(value).toLowerCase());
    if (methods.includes('mfa') || methods.includes('otp') || methods.includes('hwk')) return true;
    // Two distinct factors also counts.
    if (methods.filter((m) => ['pwd', 'otp', 'sms', 'hwk', 'swk', 'face', 'fpt'].includes(m)).length >= 2) {
      return true;
    }
  }
  const acr = typeof payload.acr === 'string' ? payload.acr.toLowerCase() : '';
  return acr.includes('mfa') || acr.endsWith('/loa2') || acr.endsWith('/loa3');
}

/**
 * Reads console roles from the token. Unknown values are dropped rather than
 * mapped to something permissive.
 */
function extractRoles(payload: JWTPayload): Role[] {
  const candidates: unknown[] = [];
  const claim = payload['airaos_roles'] ?? payload['roles'] ?? payload['groups'];
  if (Array.isArray(claim)) candidates.push(...claim);
  else if (typeof claim === 'string') candidates.push(...claim.split(/[,\s]+/));

  const normalised = candidates
    .map((value) => String(value).trim().toLowerCase().replace(/[\s-]+/g, '_'))
    // Strip a common group prefix, e.g. "infra-console:developer".
    .map((value) => value.split(':').pop() ?? value);

  return normalised.filter((value): value is Role => (ROLES as readonly string[]).includes(value));
}
