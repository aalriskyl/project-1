import { z } from '@hono/zod-openapi';
import { createCursorPageSchema } from '@/lib/pagination.ts';

export const ProductReviewSchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000601' }),
    productId: z.uuid(),
    userId: z.uuid(),
    authorName: z.string().openapi({ example: 'Budi Santoso' }),
    orderId: z.uuid().nullable(),
    rating: z.number().int().min(1).max(5).openapi({ example: 5 }),
    comment: z.string().nullable().openapi({ example: 'Mesin halus dan irit solar.' }),
    isPublished: z.boolean(),
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
});

export type ListProductReviewsQuery = z.infer<typeof ListProductReviewsQuerySchema>;

export const CreateProductReviewBodySchema = z
  .strictObject({
    rating: z.number().int().min(1).max(5).openapi({ example: 5 }),
    comment: z.string().trim().max(2_000).nullable().optional(),
    orderId: z.uuid().nullable().optional(),
  })
  .openapi('CreateProductReviewBody');

export type CreateProductReviewBody = z.infer<typeof CreateProductReviewBodySchema>;

export const ModerateReviewBodySchema = z
  .strictObject({
    isPublished: z.boolean(),
  })
  .openapi('ModerateReviewBody');

export type ModerateReviewBody = z.infer<typeof ModerateReviewBodySchema>;

export const ReviewIdParamSchema = z.object({
  id: z.uuid().openapi({
    param: { name: 'id', in: 'path' },
  }),
});

export const ProductReviewEnvelopeSchema = z
  .object({ data: ProductReviewSchema })
  .openapi('ProductReviewEnvelope');

export const ProductReviewCursorPageSchema = createCursorPageSchema(
  ProductReviewSchema,
  'ProductReviewCursorPage',
);
