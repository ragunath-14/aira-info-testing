import type { ConnectionTestResult } from '@airaos/types';
import { ProviderHttpClient } from '../../utils/http.js';
import { redactString } from '../../utils/redaction.js';
import { testFailure, testSuccess } from '../contract.js';

/**
 * DigitalOcean connection test (spec sections 7, 30).
 *
 * Config-accepting rather than reading the environment, which is what lets an
 * operator validate a token before saving it.
 */
export interface DigitalOceanConfig {
  apiUrl: string;
  apiToken: string;
  writeApiToken: string | null;
}

export function buildClient(config: DigitalOceanConfig, useWriteToken = false): ProviderHttpClient {
  const token = useWriteToken ? config.writeApiToken : config.apiToken;
  return new ProviderHttpClient({
    provider: 'DigitalOcean',
    baseUrl: config.apiUrl,
    defaultHeaders: { authorization: `Bearer ${token ?? ''}` },
    timeoutMs: 12_000,
    retries: 1,
  });
}

/**
 * Validates the token and reports something useful back.
 *
 * `/account` proves the token is accepted; one page of droplets gives the
 * operator a recognisable number so they can tell they connected to the right
 * account. Both are cheap — no metrics, no pagination (spec section 30).
 */
export async function testConnection(config: DigitalOceanConfig): Promise<ConnectionTestResult> {
  const started = Date.now();
  const http = buildClient(config);

  try {
    const account = await http.json<{
      account: { email: string; status: string; droplet_limit: number };
    }>({ path: '/account' });

    const details: Array<{ label: string; value: string }> = [];
    if (account?.account) {
      details.push({ label: 'Account', value: account.account.email });
      details.push({ label: 'Status', value: account.account.status });
      details.push({ label: 'Droplet limit', value: String(account.account.droplet_limit) });
    }

    // One small page: enough to report a count without walking the account.
    try {
      const droplets = await http.json<{ droplets: unknown[]; meta?: { total: number } }>({
        path: '/droplets',
        query: { per_page: 1 },
      });
      const total = droplets?.meta?.total;
      details.push({
        label: 'Droplets',
        value: total === undefined ? String(droplets?.droplets?.length ?? 0) : String(total),
      });
    } catch {
      // A read-scoped token without droplet:read still authenticated, which is
      // worth reporting rather than failing the whole test.
      details.push({ label: 'Droplets', value: 'not readable with this token scope' });
    }

    const latencyMs = Date.now() - started;

    if (config.writeApiToken) {
      const writeHttp = buildClient(config, true);
      try {
        await writeHttp.json({ path: '/account' });
        details.push({ label: 'Write token', value: 'accepted' });
      } catch {
        await writeHttp.close().catch(() => undefined);
        return testFailure(
          'digitalocean',
          'The read token works but the write token was rejected. Power actions would fail.',
          'PROVIDER_AUTH_FAILED',
          latencyMs,
        );
      }
      await writeHttp.close().catch(() => undefined);
    } else {
      details.push({ label: 'Write token', value: 'none — power actions disabled' });
    }

    return testSuccess('digitalocean', 'Connection successful.', latencyMs, details);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'DigitalOcean is unreachable.';
    const isAuth = /credential|401|403|unauthor/i.test(message);
    return testFailure(
      'digitalocean',
      isAuth
        ? 'DigitalOcean rejected the API token. Check that it is current and has read scope.'
        : redactString(message),
      isAuth ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_UNAVAILABLE',
      null,
    );
  } finally {
    await http.close().catch(() => undefined);
  }
}
