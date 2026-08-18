import { loadConfig, type AppConfig, ConfigError } from '@airaos/config';

let cached: AppConfig | null = null;

/**
 * Process-wide configuration. Loaded once; a failure here is fatal by design
 * (see loadConfig) rather than degrading into a half-configured console.
 */
export function config(): AppConfig {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

/** Test seam: lets integration tests install a fixture configuration. */
export function setConfigForTests(value: AppConfig | null): void {
  cached = value;
}

export { ConfigError };
export type { AppConfig };

/** Docker access is optional and, when present, always allowlisted. */
export interface DockerConfig {
  socketPath: string | null;
  allowedContainers: string[];
}

export function dockerConfig(): DockerConfig {
  const socketPath = process.env.DOCKER_SOCKET_PATH?.trim() || null;
  const allowedContainers = (process.env.DOCKER_ALLOWED_CONTAINERS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  // An unrestricted socket is refused outright: rule 3 forbids handing the
  // console blanket container control.
  if (socketPath && allowedContainers.length === 0) {
    throw new ConfigError([
      'DOCKER_SOCKET_PATH is set but DOCKER_ALLOWED_CONTAINERS is empty. List the containers the console may inspect and restart.',
    ]);
  }

  return { socketPath, allowedContainers };
}
