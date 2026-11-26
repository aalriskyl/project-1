import { z } from '@hono/zod-openapi';
import {
  AdminPaginationQuerySchema,
  CreatedFromQuerySchema,
  CreatedToQuerySchema,
  createCursorPageSchema,
  QueryBooleanSchema,
} from '@/lib/pagination.ts';
import { AuthorSummaryRefSchema, ProductSummaryRefSchema } from '@/lib/relations.ts';
import { createSuccessEnvelopeSchema } from '@/lib/response.ts';
import { SearchQueryParamSchema } from '@/lib/search.ts';
import { RecordStatusSchema, StatusFilterQueryParamSchema } from '@/lib/status.ts';

export const ProductReviewSchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000601' }),
    productId: z.uuid(),
    product: ProductSummaryRefSchema,
    userId: z.uuid(),
    authorName: z.string().openapi({ example: 'Budi Santoso' }),
    author: AuthorSummaryRefSchema,
    orderId: z.uuid().nullable(),
    rating: z.number().int().min(1).max(5).openapi({ example: 5 }),
    comment: z.string().nullable().openapi({ example: 'Mesin halus dan irit solar.' }),
    isPublished: z.boolean(),
    isActive: z.boolean().openapi({ deprecated: true }),
    status: RecordStatusSchema,
    deletedAt: z.iso.datetime().nullable().openapi({ deprecated: true }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('ProductReview');

export type PublicProductReview = z.infer<typeof ProductReviewSchema>;

export const ListProductReviewsQuerySchema = z.object({
  cursor: z
    .string()
    .min(1)
    .optional()
    .openapi({ param: { name: 'cursor', in: 'query' } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .openapi({ param: { name: 'limit', in: 'query' }, example: 10 }),
  rating: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .openapi({
      param: { name: 'rating', in: 'query' },
      description: 'Filter published reviews by exact star rating (1..5)',
      example: 5,
    }),
});

export type ListProductReviewsQuery = z.infer<typeof ListProductReviewsQuerySchema>;

export const ListAdminReviewsQuerySchema = AdminPaginationQuerySchema.extend({
  productId: z
    .uuid()
    .optional()
    .openapi({
      param: { name: 'productId', in: 'query' },
      description: 'Filter reviews by product UUID',
    }),
  userId: z
    .uuid()
    .optional()
    .openapi({
      param: { name: 'userId', in: 'query' },
      description: 'Filter reviews by author user UUID',
    }),
  isPublished: QueryBooleanSchema.optional().openapi({
    param: { name: 'isPublished', in: 'query' },
    description: 'Filter reviews by publication status',
  }),
  rating: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .openapi({
      param: { name: 'rating', in: 'query' },
      description: 'Filter reviews by star rating (1..5)',
    }),
  q: SearchQueryParamSchema,
  status: StatusFilterQueryParamSchema,
  createdFrom: CreatedFromQuerySchema,
  createdTo: CreatedToQuerySchema,
});

export type ListAdminReviewsQuery = z.infer<typeof ListAdminReviewsQuerySchema>;

export const CreateProductReviewBodySchema = z
  .strictObject({
    rating: z.number().int().min(1).max(5).openapi({ example: 5 }),
    comment: z.string().trim().max(2_000).nullable().optional(),
    orderId: z.null().optional().openapi({
      description: 'Reserved for future server-verified purchases. Omit or send null.',
      deprecated: true,
    }),
  })
  .openapi('CreateProductReviewBody');

export type CreateProductReviewBody = z.infer<typeof CreateProductReviewBodySchema>;

export const UpdateOwnReviewBodySchema = z
  .strictObject({
    rating: z.number().int().min(1).max(5).optional().openapi({ example: 4 }),
    comment: z.string().trim().max(2_000).nullable().optional(),
  })
  .refine((body) => body.rating !== undefined || body.comment !== undefined, {
    message: 'Provide at least one of rating or comment',
  })
  .openapi('UpdateOwnReviewBody');

export type UpdateOwnReviewBody = z.infer<typeof UpdateOwnReviewBodySchema>;

export const ModerateReviewBodySchema = z
  .strictObject({
    isPublished: z.boolean().optional(),
    isActive: z.boolean().optional(),
    status: RecordStatusSchema.optional(),
  })
  .refine(
    (body) =>
      body.isPublished !== undefined || body.isActive !== undefined || body.status !== undefined,
    {
      message: 'Provide at least one of isPublished, isActive, or status',
    },
  )
  .openapi('ModerateReviewBody');

export type ModerateReviewBody = z.infer<typeof ModerateReviewBodySchema>;

export const ReviewIdParamSchema = z.object({
  id: z.uuid().openapi({
    param: { name: 'id', in: 'path' },
  }),
});

export const ProductReviewEnvelopeSchema = createSuccessEnvelopeSchema(
  ProductReviewSchema,
  'ProductReviewEnvelope',
);

export const ProductReviewCursorPageSchema = createCursorPageSchema(
  ProductReviewSchema,
  'ProductReviewCursorPage',
);
