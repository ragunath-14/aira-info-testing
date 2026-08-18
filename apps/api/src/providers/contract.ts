import type { ConnectionTestResult, ConnectionType } from '@airaos/types';

/**
 * The provider adapter contract (spec sections 24, 30, 36).
 *
 * Every provider implements this, and nothing outside `providers/` knows what a
 * given provider's credentials look like. That is what lets the Connection
 * Manager, the resolver and the UI stay provider-neutral: adding a provider means
 * adding an adapter and a schema, not touching core logic.
 *
 * The key shape change from the original build: a provider takes its
 * configuration as an argument rather than reading `config()` at module scope.
 * Without that, a candidate configuration could not be tested before saving, and
 * one console could not serve two connections of the same type.
 */

/**
 * Resolved configuration handed to an adapter: non-secret settings plus the
 * decrypted secrets, assembled by the resolver at the moment of use.
 *
 * Instances are short-lived and never cached, logged, or returned from an API.
 */
export interface ResolvedConnection<TConfig = Record<string, unknown>> {
  /** Null when the configuration came from the environment rather than a row. */
  connectionId: string | null;
  name: string;
  type: ConnectionType;
  environment: string;
  config: TConfig;
}

/**
 * A cheap credential and reachability probe (spec section 30).
 *
 * Contract:
 *  - Must not run an expensive query. Listing one page or reading a version is
 *    fine; counting rows in a large table is not.
 *  - Must never throw. A failure is a result with `ok: false` and a sanitised
 *    message, because the caller renders it directly.
 *  - `details` is provider-neutral label/value pairs, so the UI needs no change
 *    when a new provider reports something different.
 */
export type ConnectionTester<TConfig> = (
  config: TConfig,
) => Promise<ConnectionTestResult>;

/** Builds a successful result with a consistent shape. */
export function testSuccess(
  type: ConnectionType,
  message: string,
  latencyMs: number,
  details: Array<{ label: string; value: string }> = [],
): ConnectionTestResult {
  return {
    ok: true,
    type,
    message,
    latencyMs,
    details,
    errorCode: null,
    testedAt: new Date().toISOString(),
  };
}

/**
 * Builds a failure result. `message` reaches the operator verbatim, so callers
 * pass the provider's own reason where it is safe and useful — a refused
 * connection or a bad host is exactly what they need to see.
 */
export function testFailure(
  type: ConnectionType,
  message: string,
  errorCode: string | null = null,
  latencyMs: number | null = null,
): ConnectionTestResult {
  return {
    ok: false,
    type,
    message,
    latencyMs,
    details: [],
    errorCode,
    testedAt: new Date().toISOString(),
  };
}
