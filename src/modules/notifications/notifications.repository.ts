import { and, eq, gt, isNull, lt, lte, or } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { mailOutbox, type MailOutboxRow } from '@/db/schema/mail-outbox.ts';
import { generateId } from '@/lib/id.ts';

export const MAX_MAIL_ATTEMPTS = 8;
export interface NotificationsRepository {
  claim(now: Date): Promise<MailOutboxRow | null>;
  finish(id: string, leaseId: string, now: Date): Promise<void>;
  retry(id: string, leaseId: string, nextAttemptAt: Date): Promise<void>;
}
export function createNotificationsRepository(db: Database): NotificationsRepository {
  return {
    async claim(now) {
      return db.transaction(async (tx) => {
        // Expired or exhausted jobs retain no reset token or recipient data.
        await tx
          .update(mailOutbox)
          .set({ finishedAt: now, payload: null, leaseId: null, leaseUntil: null })
          .where(
            and(
              isNull(mailOutbox.finishedAt),
              or(
                lte(mailOutbox.expiresAt, now),
                and(eq(mailOutbox.attempts, MAX_MAIL_ATTEMPTS), lte(mailOutbox.leaseUntil, now)),
              ),
            ),
          );
        const [row] = await tx
          .select()
          .from(mailOutbox)
          .where(
            and(
              isNull(mailOutbox.finishedAt),
              gt(mailOutbox.expiresAt, now),
              lt(mailOutbox.attempts, MAX_MAIL_ATTEMPTS),
              lte(mailOutbox.nextAttemptAt, now),
              or(isNull(mailOutbox.leaseUntil), lte(mailOutbox.leaseUntil, now)),
            ),
          )
          .orderBy(mailOutbox.nextAttemptAt, mailOutbox.id)
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return null;
        const [claimed] = await tx
          .update(mailOutbox)
          .set({
            attempts: row.attempts + 1,
            leaseId: generateId(),
            leaseUntil: new Date(now.getTime() + 30_000),
          })
          .where(eq(mailOutbox.id, row.id))
          .returning();
        return claimed ?? null;
      });
    },
    async finish(id, leaseId, now) {
      await db
        .update(mailOutbox)
        .set({ finishedAt: now, payload: null, leaseUntil: null, leaseId: null })
        .where(and(eq(mailOutbox.id, id), eq(mailOutbox.leaseId, leaseId)));
    },
    async retry(id, leaseId, nextAttemptAt) {
      await db
        .update(mailOutbox)
        .set({ nextAttemptAt, leaseUntil: null, leaseId: null })
        .where(and(eq(mailOutbox.id, id), eq(mailOutbox.leaseId, leaseId)));
    },
  };
}
