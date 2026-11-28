import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import type { NewMailDelivery } from '@/db/schema/mail-outbox.ts';
import { mailOutbox } from '@/db/schema/mail-outbox.ts';
import { inquiries, type InquiryRow } from '@/db/schema/inquiries.ts';
import { buildDescCursorCondition, isUniqueViolation } from '@/lib/shared/db-helpers.ts';
import type { DecodedCursor } from '@/lib/api/pagination.ts';
import type { InquiryStatus } from '@/modules/inquiries/inquiries.schema.ts';

export interface CreateInquiryRecord {
  readonly id: string;
  readonly productId: string | null;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly message: string;
  readonly status: InquiryStatus;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface InquiryListFilter {
  readonly status?: InquiryStatus | undefined;
  readonly productId?: string | undefined;
}

export interface InquiriesRepository {
  findByIdempotencyKey(key: string): Promise<InquiryRow | null>;
  findById(id: string): Promise<InquiryRow | null>;
  createWithDelivery(input: CreateInquiryRecord, delivery?: NewMailDelivery): Promise<InquiryRow>;
  listCursor(params: {
    readonly limit: number;
    readonly cursor?: DecodedCursor | undefined;
    readonly filter?: InquiryListFilter | undefined;
  }): Promise<readonly InquiryRow[]>;
  listOffset(params: {
    readonly limit: number;
    readonly offset: number;
    readonly filter?: InquiryListFilter | undefined;
  }): Promise<{ readonly items: readonly InquiryRow[]; readonly total: number }>;
  updateStatus(id: string, status: InquiryStatus, now: Date): Promise<InquiryRow | null>;
}

export function createInquiriesRepository(db: Database): InquiriesRepository {
  function conditions(filter?: InquiryListFilter) {
    const clauses = [];
    if (filter?.status !== undefined) clauses.push(eq(inquiries.status, filter.status));
    if (filter?.productId !== undefined) clauses.push(eq(inquiries.productId, filter.productId));
    return clauses.length > 0 ? and(...clauses) : undefined;
  }

  return {
    async findByIdempotencyKey(key) {
      const [row] = await db
        .select()
        .from(inquiries)
        .where(eq(inquiries.idempotencyKey, key))
        .limit(1);
      return row ?? null;
    },

    async findById(id) {
      const [row] = await db.select().from(inquiries).where(eq(inquiries.id, id)).limit(1);
      return row ?? null;
    },

    async createWithDelivery(input, delivery) {
      try {
        return await db.transaction(async (tx) => {
          const [created] = await tx.insert(inquiries).values(input).returning();
          if (created === undefined) throw new Error('Failed to insert inquiry');
          if (delivery !== undefined) await tx.insert(mailOutbox).values(delivery);
          return created;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          const existing = await this.findByIdempotencyKey(input.idempotencyKey);
          if (existing !== null) return existing;
        }
        throw err;
      }
    },

    async listCursor({ limit, cursor, filter }) {
      const cursorCondition = buildDescCursorCondition(inquiries.createdAt, inquiries.id, cursor);
      const where = and(conditions(filter), cursorCondition);
      return db
        .select()
        .from(inquiries)
        .where(where)
        .orderBy(desc(inquiries.createdAt), desc(inquiries.id))
        .limit(limit);
    },

    async listOffset({ limit, offset, filter }) {
      const where = conditions(filter);
      const [items, countRows] = await Promise.all([
        db
          .select()
          .from(inquiries)
          .where(where)
          .orderBy(desc(inquiries.createdAt), desc(inquiries.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(inquiries)
          .where(where),
      ]);
      return { items, total: countRows[0]?.total ?? 0 };
    },

    async updateStatus(id, status, now) {
      const [updated] = await db
        .update(inquiries)
        .set({ status, updatedAt: now })
        .where(eq(inquiries.id, id))
        .returning();
      return updated ?? null;
    },
  };
}
