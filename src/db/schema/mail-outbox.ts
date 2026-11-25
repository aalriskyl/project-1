import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const mailOutbox = pgTable(
  'mail_outbox',
  {
    id: uuid('id').primaryKey(),
    payload: text('payload'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    leaseId: uuid('lease_id'),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [index('mail_outbox_pending_idx').on(t.finishedAt, t.nextAttemptAt)],
).enableRLS();

export type MailOutboxRow = typeof mailOutbox.$inferSelect;
export interface NewMailDelivery {
  readonly id: string;
  readonly payload: string;
  readonly expiresAt: Date;
}
