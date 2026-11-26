import { app } from '@/app.ts';
import { env } from '@/config/env.ts';
import { closeDb, db } from '@/db/client.ts';
import { logger } from '@/lib/logger.ts';
import { closeRedis } from '@/lib/redis.ts';
import { startMailWorker } from '@/lib/mail-worker.ts';
import { mailProvider } from '@/lib/mailer.ts';
import { createNotificationsRepository } from '@/modules/notifications/notifications.repository.ts';
import { createNotificationsService } from '@/modules/notifications/notifications.service.ts';

const server = Bun.serve({
  hostname: env.HOST,
  port: env.PORT,
  fetch(request, server) {
    return app.fetch(request, { clientIp: server.requestIP(request)?.address });
  },
});

const stopMailWorker =
  env.MAIL_OUTBOX_ENCRYPTION_KEY !== undefined && env.RESEND_API_KEY !== undefined
    ? startMailWorker(
        createNotificationsService(
          createNotificationsRepository(db),
          mailProvider,
          env.MAIL_OUTBOX_ENCRYPTION_KEY,
          logger,
        ),
        logger,
      )
    : async (): Promise<void> => {};

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
    await stopMailWorker();
    closeRedis();
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
