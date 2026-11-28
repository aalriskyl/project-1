import { and, eq, gte, isNotNull, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import type { DateRangeFilter, DecodedCursor } from '@/lib/api/pagination.ts';
import type { RecordStatus } from '@/lib/api/status.ts';

export interface SoftDeletableColumns {
  readonly isActive: AnyPgColumn;
  readonly deletedAt: AnyPgColumn;
}

/**
 * Walks an error's `cause` chain to locate an underlying `postgres.PostgresError`.
 */
export function extractPostgresError(err: unknown): postgres.PostgresError | null {
  if (err instanceof postgres.PostgresError) {
    return err;
  }
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    return extractPostgresError(err.cause);
  }
  return null;
}

/**
 * Returns true when an error (or its cause chain) is a PostgreSQL `23505` unique violation.
 */
export function isUniqueViolation(err: unknown): boolean {
  const pgErr = extractPostgresError(err);
  return pgErr !== null && pgErr.code === '23505';
}

/**
 * Standard active-record SQL conditions (`is_active = true AND deleted_at IS NULL`).
 */
export function activeRecordConditions(table: SoftDeletableColumns): SQL[] {
  return [eq(table.isActive, true), isNull(table.deletedAt)];
}

/**
 * Builds lifecycle status SQL conditions for admin lists (`active` | `inactive`).
 */
export function buildStatusFilterConditions(
  table: SoftDeletableColumns,
  status?: RecordStatus,
): SQL[] {
  if (status === 'active') {
    return activeRecordConditions(table);
  }
  if (status === 'inactive') {
    const inactiveCond = or(eq(table.isActive, false), isNotNull(table.deletedAt));
    return inactiveCond !== undefined ? [inactiveCond] : [];
  }
  return [];
}

/**
 * Builds inclusive UTC timestamp range SQL conditions (`createdFrom` / `createdTo`).
 */
export function buildDateRangeConditions(createdAtCol: AnyPgColumn, range: DateRangeFilter): SQL[] {
  const conditions: SQL[] = [];
  if (range.createdFrom !== undefined) {
    conditions.push(gte(createdAtCol, range.createdFrom));
  }
  if (range.createdTo !== undefined) {
    conditions.push(lte(createdAtCol, range.createdTo));
  }
  return conditions;
}

/**
 * Builds a descending keyset cursor predicate for `(timestampCol DESC, idCol DESC)`.
 */
export function buildDescCursorCondition(
  timestampCol: AnyPgColumn,
  idCol: AnyPgColumn,
  cursor?: DecodedCursor,
): SQL | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  return or(
    lt(timestampCol, cursor.createdAt),
    and(eq(timestampCol, cursor.createdAt), lt(idCol, cursor.id)),
  );
}
