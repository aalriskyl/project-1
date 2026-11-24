import { z } from '@hono/zod-openapi';
import { ValidationError } from '@/lib/errors.ts';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const CursorPaginationQuerySchema = z.object({
  cursor: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: 'cursor', in: 'query' },
      description: 'Opaque cursor returned from the previous page',
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .openapi({
      param: { name: 'limit', in: 'query' },
      description: `Items per page (1..${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE})`,
      example: DEFAULT_PAGE_SIZE,
    }),
});

export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuerySchema>;

const CursorPayloadSchema = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

export interface DecodedCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeCursor(item: { readonly createdAt: Date; readonly id: string }): string {
  const payload = JSON.stringify({
    createdAt: item.createdAt.toISOString(),
    id: item.id,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(rawCursor: string): DecodedCursor {
  let parsedJson: unknown;
  try {
    const decoded = Buffer.from(rawCursor, 'base64url').toString('utf8');
    parsedJson = JSON.parse(decoded);
  } catch {
    throw new ValidationError('Invalid pagination cursor', [
      { field: 'cursor', message: 'Malformed pagination cursor' },
    ]);
  }

  const validated = CursorPayloadSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new ValidationError('Invalid pagination cursor', [
      { field: 'cursor', message: 'Cursor payload failed validation' },
    ]);
  }

  return {
    createdAt: new Date(validated.data.createdAt),
    id: validated.data.id,
  };
}

export interface CursorPage<T> {
  readonly data: readonly T[];
  readonly meta: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly limit: number;
  };
}

export function createCursorPageSchema<T extends z.ZodType>(itemSchema: T, schemaName: string) {
  return z
    .object({
      data: z.array(itemSchema),
      meta: z.object({
        nextCursor: z.string().nullable(),
        hasMore: z.boolean(),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE),
      }),
    })
    .openapi(schemaName);
}
