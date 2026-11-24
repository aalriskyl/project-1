import { app } from '@/app.ts';
import { env } from '@/config/env.ts';
import { closeDb } from '@/db/client.ts';
import { logger } from '@/lib/logger.ts';

const server = Bun.serve({
  hostname: env.HOST,
  port: env.PORT,
  fetch: app.fetch,
});

logger.info(
  {
    host: server.hostname,
    port: server.port,
    env: env.NODE_ENV,
  },
  'server listening',
);

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'received shutdown signal; draining in-flight requests');

  try {
    // Stop accepting new connections while allowing active requests to complete.
    await server.stop(false);
    await closeDb();
    logger.info('graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
