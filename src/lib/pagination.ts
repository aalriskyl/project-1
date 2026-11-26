import { z } from '@hono/zod-openapi';
import { ValidationError } from '@/lib/errors.ts';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const QueryBooleanSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((val) => val === 'true' || val === '1');

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const IsoDatetimeValidator = z.iso.datetime({ offset: true });

function parseDateBound(raw: string, bound: 'start' | 'end'): Date | null {
  if (ISO_DATE_ONLY_RE.test(raw)) {
    const iso = bound === 'start' ? `${raw}T00:00:00.000Z` : `${raw}T23:59:59.999Z`;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(raw)) {
      return null;
    }
    return parsed;
  }
  if (!IsoDatetimeValidator.safeParse(raw).success) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createDateBoundQuerySchema(
  name: 'createdFrom' | 'createdTo',
  bound: 'start' | 'end',
  description: string,
) {
  return z
    .string()
    .trim()
    .superRefine((raw, ctx) => {
      if (parseDateBound(raw, bound) === null) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be a valid ISO 8601 date (YYYY-MM-DD) or UTC/offset datetime`,
        });
      }
    })
    .transform((raw): Date => parseDateBound(raw, bound) ?? new Date(0))
    .optional()
    .openapi({
      param: { name, in: 'query' },
      description,
      example: bound === 'start' ? '2026-11-01' : '2026-11-30',
    });
}

export const CreatedFromQuerySchema = createDateBoundQuerySchema(
  'createdFrom',
  'start',
  'Filter records created on or after this ISO 8601 date (YYYY-MM-DD) or datetime',
);

export const CreatedToQuerySchema = createDateBoundQuerySchema(
  'createdTo',
  'end',
  'Filter records created on or before this ISO 8601 date (YYYY-MM-DD) or datetime',
);

export interface DateRangeFilter {
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
}

export function assertValidDateRange(query: {
  readonly createdFrom?: Date | undefined;
  readonly createdTo?: Date | undefined;
}): void {
  if (
    query.createdFrom !== undefined &&
    query.createdTo !== undefined &&
    query.createdFrom.getTime() > query.createdTo.getTime()
  ) {
    throw new ValidationError('Invalid date range', [
      { field: 'createdFrom', message: 'createdFrom must be less than or equal to createdTo' },
    ]);
  }
}

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

export const MAX_OFFSET_PAGE = 10_000;

export const AdminPaginationQuerySchema = CursorPaginationQuerySchema.extend({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_OFFSET_PAGE)
    .optional()
    .openapi({
      param: { name: 'page', in: 'query' },
      description:
        'Optional 1-based page number for numbered admin tables (mutually exclusive with cursor; returns total & totalPages in meta)',
      example: 1,
    }),
});

export type AdminPaginationQuery = z.infer<typeof AdminPaginationQuerySchema>;

export function assertCursorOrPage(query: {
  readonly cursor?: string | undefined;
  readonly page?: number | undefined;
}): void {
  if (query.cursor !== undefined && query.page !== undefined) {
    throw new ValidationError('Provide either cursor or page, not both', [
      { field: 'page', message: 'Cannot combine cursor and page pagination in the same request' },
    ]);
  }
}

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

export interface CursorPageMeta {
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;
  readonly page?: number;
  readonly total?: number;
  readonly totalPages?: number;
}

export interface CursorPage<T> {
  readonly data: readonly T[];
  readonly meta: CursorPageMeta;
}

export function buildCursorPage<
  TRow extends { readonly id: string; readonly createdAt: Date },
  TOut,
>(
  rows: readonly TRow[],
  limit: number,
  serialize: (row: TRow) => TOut,
  encodeRowCursor: (row: TRow) => string = (row) => encodeCursor(row),
): CursorPage<TOut> {
  const hasMore = rows.length > limit;
  const pageItems = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = pageItems[pageItems.length - 1];
  const nextCursor = hasMore && lastItem !== undefined ? encodeRowCursor(lastItem) : null;

  return {
    data: pageItems.map(serialize),
    meta: {
      nextCursor,
      hasMore,
      limit,
    },
  };
}

export function buildOffsetPage<T>(
  items: readonly T[],
  total: number,
  page: number,
  limit: number,
): CursorPage<T> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    data: items,
    meta: {
      nextCursor: null,
      hasMore: page < totalPages,
      limit,
      page,
      total,
      totalPages,
    },
  };
}

export async function paginateAdminList<
  TRow extends { readonly id: string; readonly createdAt: Date },
  TOut,
>(options: {
  readonly query: {
    readonly limit: number;
    readonly cursor?: string | undefined;
    readonly page?: number | undefined;
    readonly createdFrom?: Date | undefined;
    readonly createdTo?: Date | undefined;
  };
  readonly listOffset: (params: {
    readonly limit: number;
    readonly offset: number;
  }) => Promise<{ readonly items: readonly TRow[]; readonly total: number }>;
  readonly listCursor: (params: {
    readonly limit: number;
    readonly cursor?: DecodedCursor;
  }) => Promise<readonly TRow[]>;
  readonly serialize: (row: TRow) => TOut;
  readonly encodeRowCursor?: (row: TRow) => string;
}): Promise<CursorPage<TOut>> {
  const { query, listOffset, listCursor, serialize, encodeRowCursor } = options;
  assertCursorOrPage(query);
  assertValidDateRange(query);

  if (query.page !== undefined) {
    const offset = (query.page - 1) * query.limit;
    const { items, total } = await listOffset({ limit: query.limit, offset });
    return buildOffsetPage(items.map(serialize), total, query.page, query.limit);
  }

  const decodedCursor = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;
  const rows = await listCursor({
    limit: query.limit + 1,
    ...(decodedCursor !== undefined ? { cursor: decodedCursor } : {}),
  });

  return buildCursorPage(rows, query.limit, serialize, encodeRowCursor);
}

export function createCursorPageSchema<T extends z.ZodType>(itemSchema: T, schemaName: string) {
  return z
    .object({
      success: z.literal(true),
      message: z.string(),
      data: z.array(itemSchema),
      meta: z.object({
        nextCursor: z.string().nullable(),
        hasMore: z.boolean(),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE),
        page: z.number().int().min(1).optional(),
        total: z.number().int().nonnegative().optional(),
        totalPages: z.number().int().nonnegative().optional(),
      }),
    })
    .openapi(schemaName);
}
