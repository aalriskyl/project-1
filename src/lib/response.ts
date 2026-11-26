import { z } from '@hono/zod-openapi';
import type { CursorPage } from '@/lib/pagination.ts';

/**
 * Wraps any data payload schema in the standard JSON API success envelope:
 * `{ success: true, message: "...", data: ... }`.
 */
export function createSuccessEnvelopeSchema<T extends z.ZodType>(
  dataSchema: T,
  schemaName: string,
) {
  return z
    .object({
      success: z.literal(true),
      message: z.string().optional().openapi({
        deprecated: true,
        description: 'Human-readable summary; prefer the HTTP status',
      }),
      data: dataSchema,
    })
    .openapi(schemaName);
}

/**
 * Builds a standard success response payload.
 */
export function ok<T>(data: T, message: string) {
  return {
    success: true as const,
    message,
    data,
  };
}

/**
 * Builds a standard cursor-paginated success response payload.
 */
export function okPage<T>(page: CursorPage<T>, message: string) {
  return {
    success: true as const,
    message,
    data: [...page.data],
    meta: page.meta,
  };
}
