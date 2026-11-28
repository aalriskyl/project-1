import type { Logger } from 'pino';
import { decryptOutboxMail } from '@/lib/integrations/mail-outbox-crypto.ts';
import type { MailProvider } from '@/lib/integrations/mailer.ts';
import {
  MAX_MAIL_ATTEMPTS,
  type NotificationsRepository,
} from '@/modules/notifications/notifications.repository.ts';

export interface NotificationsService {
  processNext(): Promise<boolean>;
}
export function createNotificationsService(
  repo: NotificationsRepository,
  mailer: MailProvider,
  key: string,
  logger: Logger,
  now: () => Date = () => new Date(),
): NotificationsService {
  return {
    async processNext() {
      const row = await repo.claim(now());
      if (!row) return false;
      if (!row.payload || !row.leaseId) throw new Error('Invalid claimed mail delivery');
      try {
        const message = await decryptOutboxMail(row.payload, key);
        if (message.kind === 'inquiry') {
          await mailer.sendInquiryEmail({
            ...message.input,
            idempotencyKey: `inquiry/${row.id}`,
          });
        } else {
          await mailer.sendPasswordResetEmail({
            ...message.input,
            idempotencyKey: `password-reset/${row.id}`,
          });
        }
      } catch {
        // Never log the provider error object: it may contain recipient or request payloads.
        logger.warn(
          { deliveryId: row.id, attempt: row.attempts },
          'password reset delivery failed',
        );
        if (row.attempts >= MAX_MAIL_ATTEMPTS || row.expiresAt <= now()) {
          await repo.finish(row.id, row.leaseId, now());
          logger.error({ deliveryId: row.id }, 'password reset delivery exhausted');
        } else {
          const delayMs = Math.min(300_000, 5_000 * 2 ** (row.attempts - 1));
          await repo.retry(row.id, row.leaseId, new Date(now().getTime() + delayMs));
        }
        return true;
      }
      await repo.finish(row.id, row.leaseId, now());
      return true;
    },
  };
}
