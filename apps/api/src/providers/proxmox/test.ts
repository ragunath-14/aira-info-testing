import { readFileSync } from 'node:fs';
import type { ConnectionTestResult } from '@airaos/types';
import { ProviderHttpClient } from '../../utils/http.js';
import { redactString } from '../../utils/redaction.js';
import { testFailure, testSuccess } from '../contract.js';
import type { PveEnvelope, PveNodeSummary } from './types.js';

/**
 * Proxmox connection test (spec sections 8, 30).
 *
 * Uses a scoped API token, never root password auth. TLS verification is on
 * unless the operator supplied a CA path, which the schema already enforces.
 */
export interface ProxmoxConfig {
  apiUrl: string;
  tokenId: string;
  tokenSecret: string;
  rejectUnauthorized: boolean;
  caCertPath: string | null;
}

export function buildClient(config: ProxmoxConfig): ProviderHttpClient {
  let ca: Buffer | undefined;
  if (config.caCertPath) {
    try {
      ca = readFileSync(config.caCertPath);
    } catch {
      // Surfaced as a test failure by the caller rather than silently continuing
      // with an unverified session.
      throw new Error(`CA certificate at ${config.caCertPath} could not be read`);
    }
  }

  return new ProviderHttpClient({
    provider: 'Proxmox',
    baseUrl: config.apiUrl,
    defaultHeaders: {
      authorization: `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`,
    },
    timeoutMs: 10_000,
    retries: 1,
    tls: { rejectUnauthorized: config.rejectUnauthorized, ca },
  });
}

/**
 * `/nodes` is the cheapest call that proves both the token and the permissions
 * the console actually needs, and it yields a node count worth reporting.
 */
export async function testConnection(config: ProxmoxConfig): Promise<ConnectionTestResult> {
  const started = Date.now();

  let http: ProviderHttpClient;
  try {
    http = buildClient(config);
  } catch (error) {
    return testFailure(
      'proxmox',
      error instanceof Error ? error.message : 'TLS configuration is invalid.',
      'PROVIDER_NOT_CONFIGURED',
      null,
    );
  }

  try {
    const response = await http.json<PveEnvelope<PveNodeSummary[]>>({ path: '/nodes' });
    const nodes = response?.data ?? [];
    const online = nodes.filter((node) => node.status === 'online').length;
    const latencyMs = Date.now() - started;

    const details: Array<{ label: string; value: string }> = [
      { label: 'Nodes', value: `${online} online / ${nodes.length} total` },
      { label: 'TLS', value: config.rejectUnauthorized ? 'verified' : 'verification disabled' },
    ];

    // A standalone install has no cluster endpoint; a 501 there is normal.
    try {
      const cluster = await http.json<PveEnvelope<Array<{ type: string; name?: string; quorate?: number }>>>(
        { path: '/cluster/status' },
      );
      const entry = (cluster?.data ?? []).find((item) => item.type === 'cluster');
      details.push({
        label: 'Cluster',
        value: entry?.name
          ? `${entry.name}${entry.quorate === 1 ? ' (quorate)' : ' (NOT quorate)'}`
          : 'standalone node',
      });
    } catch {
      details.push({ label: 'Cluster', value: 'standalone node' });
    }

    if (nodes.length === 0) {
      return testFailure(
        'proxmox',
        'The token was accepted but no nodes are visible. It likely lacks Sys.Audit on /.',
        'FORBIDDEN',
        latencyMs,
      );
    }

    return testSuccess('proxmox', 'Connection successful.', latencyMs, details);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxmox is unreachable.';
    const isAuth = /credential|401|403|unauthor/i.test(message);
    const isTls = /certificate|self.signed|SSL|TLS/i.test(message);

    return testFailure(
      'proxmox',
      isAuth
        ? 'Proxmox rejected the token. Check that the token id is the full user@realm!tokenname.'
        : isTls
          ? 'TLS verification failed. Supply the cluster CA certificate path, or install a trusted certificate on Proxmox.'
          : redactString(message),
      isAuth ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_UNAVAILABLE',
      null,
    );
  } finally {
    await http.close().catch(() => undefined);
  }
}
