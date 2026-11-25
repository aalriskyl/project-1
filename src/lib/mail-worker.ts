import type { Logger } from 'pino';
import type { NotificationsService } from '@/modules/notifications/notifications.service.ts';

export function startMailWorker(
  service: NotificationsService,
  logger: Logger,
): () => Promise<void> {
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = (): void => {
    if (stopped || running !== undefined) return;
    running = (async () => {
      try {
        for (let i = 0; i < 20 && !stopped; i += 1) if (!(await service.processNext())) break;
      } catch {
        logger.error('mail outbox worker failed; retrying on next poll');
      } finally {
        running = undefined;
      }
    })();
  };
  const timer = setInterval(tick, 1_000);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
