import { z } from '@hono/zod-openapi';
import { ValidationError } from '@/lib/errors.ts';

export const RECORD_STATUSES = ['active', 'inactive'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const RecordStatusSchema = z.enum(RECORD_STATUSES).openapi('RecordStatus');

export const StatusFilterQueryParamSchema = RecordStatusSchema.optional().openapi({
  param: { name: 'status', in: 'query' },
  description: 'Filter records by lifecycle status (`active` or `inactive`)',
  example: 'active',
});

export function isRecordActive(row: {
  readonly isActive: boolean;
  readonly deletedAt: Date | null;
}): boolean {
  return row.isActive && row.deletedAt === null;
}

export function toRecordStatus(row: {
  readonly isActive: boolean;
  readonly deletedAt: Date | null;
}): RecordStatus {
  return isRecordActive(row) ? 'active' : 'inactive';
}

/**
 * Resolves optional `status` ('active' | 'inactive') and legacy `isActive` (boolean) inputs
 * into a single boolean active flag, rejecting contradictory combinations with 422.
 */
export function resolveActiveStateInput(input: {
  readonly status?: RecordStatus | undefined;
  readonly isActive?: boolean | undefined;
}): boolean | undefined {
  if (input.status !== undefined && input.isActive !== undefined) {
    const statusAsBool = input.status === 'active';
    if (statusAsBool !== input.isActive) {
      throw new ValidationError('Conflicting status and isActive values', [
        {
          field: 'status',
          message: 'status and isActive must agree when both are provided',
        },
      ]);
    }
    return statusAsBool;
  }

  if (input.status !== undefined) {
    return input.status === 'active';
  }

  return input.isActive;
}
