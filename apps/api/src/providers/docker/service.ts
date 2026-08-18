import type { ContainerStatus, SubsystemHealth } from '@airaos/types';
import { dockerConfig } from '../../config.js';
import { errors } from '../../utils/errors.js';
import { providerCache } from '../../utils/cache.js';
import { ProviderHttpClient } from '../../utils/http.js';
import { logger } from '../../utils/logger.js';

/**
 * Docker engine adapter (spec section 11, rule 3).
 *
 * Constraints that make this safe to have at all:
 *
 *  - The socket is read by the API process only. It is never proxied, and no
 *    route accepts a Docker path, image, command or exec payload.
 *  - Every call is filtered through DOCKER_ALLOWED_CONTAINERS. A container
 *    outside that list is invisible to the console and cannot be acted on.
 *  - Only inspect, stats, logs, start, stop and restart are implemented. There
 *    is no exec, no create, no image pull and no volume access.
 */

const API_VERSION = 'v1.43';

interface DockerContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  State: string;
  Status: string;
  Created: number;
  Ports: Array<{ PrivatePort: number; PublicPort?: number; Type: string }>;
  Labels: Record<string, string>;
}

interface DockerInspect {
  Id: string;
  Name: string;
  Created: string;
  RestartCount: number;
  State: {
    Status: string;
    Running: boolean;
    StartedAt: string;
    Health?: { Status: string; FailingStreak: number };
  };
  Config: { Image: string; Labels: Record<string, string> };
  HostConfig: { RestartPolicy: { Name: string } };
}

interface DockerStats {
  cpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
  };
  memory_stats: { usage?: number; limit?: number; stats?: { inactive_file?: number } };
}

let httpClient: ProviderHttpClient | null = null;

export function configured(): boolean {
  return dockerConfig().socketPath !== null;
}

export function allowedContainers(): string[] {
  return dockerConfig().allowedContainers;
}

function client(): ProviderHttpClient {
  const { socketPath } = dockerConfig();
  if (!socketPath) throw errors.providerNotConfigured('Docker');
  if (!httpClient) {
    httpClient = new ProviderHttpClient({
      provider: 'Docker',
      // Host is ignored when a unix socket is supplied, but a valid URL is
      // still required to build request paths.
      baseUrl: `http://localhost/${API_VERSION}`,
      socketPath,
      timeoutMs: 5000,
      retries: 1,
    });
  }
  return httpClient;
}

/**
 * The allowlist gate. Called before every read and every action; a name that is
 * not listed produces a not-found rather than a permission error, so the console
 * does not confirm the existence of containers it may not touch.
 */
function assertAllowed(name: string): string {
  const normalised = name.replace(/^\//, '');
  if (!allowedContainers().includes(normalised)) {
    throw errors.notFound('Container');
  }
  return normalised;
}

function mapState(state: string): ContainerStatus['state'] {
  switch (state) {
    case 'running':
    case 'exited':
    case 'paused':
    case 'created':
    case 'dead':
    case 'restarting':
      return state;
    default:
      return 'unknown';
  }
}

function mapHealth(status: string | undefined): ContainerStatus['healthStatus'] {
  switch (status) {
    case 'healthy':
    case 'unhealthy':
    case 'starting':
      return status;
    default:
      return 'none';
  }
}

async function loadContainers(): Promise<ContainerStatus[]> {
  const allowed = allowedContainers();
  if (allowed.length === 0) return [];

  const summaries = await client().json<DockerContainerSummary[]>({
    path: '/containers/json',
    query: { all: 'true' },
  });

  const relevant = (summaries ?? []).filter((summary) =>
    summary.Names.some((name) => allowed.includes(name.replace(/^\//, ''))),
  );

  return Promise.all(
    relevant.map(async (summary) => {
      const name = summary.Names[0]?.replace(/^\//, '') ?? summary.Id.slice(0, 12);
      const [inspect, stats] = await Promise.all([
        client()
          .json<DockerInspect>({ path: `/containers/${encodeURIComponent(name)}/json` })
          .catch(() => null),
        summary.State === 'running'
          ? client()
              .json<DockerStats>({
                path: `/containers/${encodeURIComponent(name)}/stats`,
                query: { stream: 'false', 'one-shot': 'true' },
              })
              .catch(() => null)
          : Promise.resolve(null),
      ]);

      const startedAt = inspect?.State?.StartedAt ?? null;
      const [imageName, imageTag] = splitImage(summary.Image);

      return {
        id: summary.Id.slice(0, 12),
        name,
        image: imageName,
        imageTag,
        state: mapState(summary.State),
        healthStatus: mapHealth(inspect?.State?.Health?.Status),
        cpuPercent: cpuPercent(stats),
        memoryUsedBytes: memoryUsed(stats),
        memoryLimitBytes: stats?.memory_stats?.limit ?? null,
        restartCount: inspect?.RestartCount ?? 0,
        startedAt: startedAt && !startedAt.startsWith('0001-') ? startedAt : null,
        uptimeSeconds:
          startedAt && !startedAt.startsWith('0001-') && summary.State === 'running'
            ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
            : null,
        ports: (summary.Ports ?? []).map((port) => ({
          container: port.PrivatePort,
          host: port.PublicPort ?? null,
          protocol: port.Type,
        })),
      } satisfies ContainerStatus;
    }),
  );
}

function splitImage(image: string): [string, string | null] {
  // Careful with registry ports: "registry:5000/app:v1" splits on the last colon
  // only when it appears after the final slash.
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  if (lastColon > lastSlash) {
    return [image.slice(0, lastColon), image.slice(lastColon + 1)];
  }
  return [image, null];
}

/**
 * CPU percentage from two cumulative samples, matching `docker stats`.
 * Returns null rather than 0 when the deltas are unusable.
 */
function cpuPercent(stats: DockerStats | null): number | null {
  if (!stats?.cpu_stats?.system_cpu_usage || !stats.precpu_stats?.system_cpu_usage) return null;
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  if (systemDelta <= 0 || cpuDelta < 0) return null;
  const cores = stats.cpu_stats.online_cpus ?? 1;
  return Number(((cpuDelta / systemDelta) * cores * 100).toFixed(2));
}

/** Working-set memory: total usage minus inactive page cache, as Docker reports. */
function memoryUsed(stats: DockerStats | null): number | null {
  const usage = stats?.memory_stats?.usage;
  if (usage === undefined) return null;
  const inactive = stats?.memory_stats?.stats?.inactive_file ?? 0;
  return Math.max(0, usage - inactive);
}

export async function listContainers(): Promise<{ value: ContainerStatus[]; cachedAgeMs?: number }> {
  if (!configured()) return { value: [] };
  const result = await providerCache.wrap('docker:containers', 15_000, loadContainers, {
    fallbackToStale: true,
  });
  return { value: result.value, cachedAgeMs: result.cachedAgeMs };
}

export async function getContainer(name: string): Promise<ContainerStatus | null> {
  if (!configured()) return null;
  const allowedName = assertAllowed(name);
  const { value } = await listContainers();
  return value.find((container) => container.name === allowedName) ?? null;
}

/** The only three lifecycle commands the console can issue. */
const ACTIONS = {
  restart: { path: 'restart', query: { t: 15 } },
  start: { path: 'start', query: {} },
  stop: { path: 'stop', query: { t: 15 } },
} as const;

export type ContainerAction = keyof typeof ACTIONS;

export async function runAction(name: string, action: ContainerAction): Promise<void> {
  const allowedName = assertAllowed(name);
  const definition = ACTIONS[action];

  await client().text({
    method: 'POST',
    path: `/containers/${encodeURIComponent(allowedName)}/${definition.path}`,
    query: definition.query,
    retries: 0,
    timeoutMs: 30_000,
    // 304 means "already in that state", which is not a failure.
    acceptStatuses: [304],
  });

  providerCache.invalidate('docker:containers');
}

/**
 * Recent container logs. Docker multiplexes stdout/stderr with an 8-byte header
 * per frame when no TTY is attached, which is stripped here.
 */
export async function containerLogs(name: string, tail = 200): Promise<string[]> {
  const allowedName = assertAllowed(name);
  const raw = await client().text({
    path: `/containers/${encodeURIComponent(allowedName)}/logs`,
    query: { stdout: 'true', stderr: 'true', tail, timestamps: 'true' },
    timeoutMs: 10_000,
  });

  return raw
    .split('\n')
    .map((line) => stripStreamHeader(line))
    .filter((line) => line.trim().length > 0);
}

function stripStreamHeader(line: string): string {
  // Frame header is 0x01/0x02 followed by three zero bytes and a 4-byte length.
  if (line.length > 8 && (line.charCodeAt(0) === 1 || line.charCodeAt(0) === 2)) {
    return line.slice(8);
  }
  return line;
}

export async function health(): Promise<SubsystemHealth> {
  const base = {
    key: 'docker',
    label: 'Containers',
    configured: configured(),
    lastCheckedAt: new Date().toISOString(),
  };

  if (!configured()) {
    return {
      ...base,
      state: 'unknown',
      detail: 'No Docker socket configured.',
      lastSuccessAt: null,
      latencyMs: null,
    };
  }

  const started = Date.now();
  try {
    await client().json<{ ID: string }>({ path: '/info' });
    const { value } = await listContainers();
    const running = value.filter((container) => container.state === 'running').length;
    const unhealthy = value.filter((container) => container.healthStatus === 'unhealthy').length;
    return {
      ...base,
      state: unhealthy > 0 ? 'degraded' : 'healthy',
      detail: `${running}/${value.length} allowlisted container(s) running${
        unhealthy > 0 ? `, ${unhealthy} unhealthy` : ''
      }.`,
      lastSuccessAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    logger().debug({ err: error }, 'docker unavailable');
    return {
      ...base,
      state: 'down',
      detail: error instanceof Error ? error.message : 'Unknown error',
      lastSuccessAt: httpClient?.lastSuccessIso ?? null,
      latencyMs: null,
    };
  }
}

export async function closeClient(): Promise<void> {
  await httpClient?.close();
  httpClient = null;
}
