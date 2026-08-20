import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig, ConfigError } from '@airaos/config';

let cached: AppConfig | null = null;

function loadEnvFileIfPresent(): void {
  const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
  if (fs.existsSync(rootEnv)) {
    try {
      const content = fs.readFileSync(rootEnv, 'utf8');
      for (const line of content.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (!key || rawValue === undefined) continue;
        if (process.env[key] !== undefined) continue;
        process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '');
      }
    } catch {
      // Ignore reading errors if .env is unreadable
    }
  }
}

/**
 * Process-wide configuration. Loaded once; a failure here is fatal by design
 * (see loadConfig) rather than degrading into a half-configured console.
 */
export function config(): AppConfig {
  if (!cached) {
    loadEnvFileIfPresent();
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
