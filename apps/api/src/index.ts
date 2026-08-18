import { buildApp } from './app.js';
import { config, ConfigError } from './config.js';
import { closePool } from './db/pool.js';
import { closeRedis } from './providers/redis/client.js';
import { closeAllTargetPools } from './providers/databases/connection-manager.js';

/**
 * Process entrypoint. Configuration is validated before anything binds a port,
 * and shutdown drains the console pool, the managed-target pools and Redis so a
 * rolling deploy does not leave connections behind.
 */
async function main(): Promise<void> {
  let cfg;
  try {
    cfg = config();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n${error.message}\n\nSee .env.example and docs/setup.md.\n`);
      process.exit(1);
    }
    throw error;
  }

  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeAllTargetPools();
      await closeRedis();
      await closePool();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection');
  });

  await app.listen({ port: cfg.API_PORT, host: cfg.API_HOST });
  app.log.info(
    { port: cfg.API_PORT, host: cfg.API_HOST, appEnv: cfg.APP_ENV },
    'AIRAOS Infra Console API listening',
  );
}

await main();
