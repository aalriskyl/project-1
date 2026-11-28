import { z } from '@hono/zod-openapi';
import { createSuccessEnvelopeSchema } from '@/lib/api/response.ts';

export const STRUCTURED_DATA_TYPES = ['product', 'category', 'article'] as const;
export type StructuredDataType = (typeof STRUCTURED_DATA_TYPES)[number];

export const StructuredDataTypeSchema = z.enum(STRUCTURED_DATA_TYPES).openapi('StructuredDataType');

export const StructuredDataQuerySchema = z
  .object({
    type: StructuredDataTypeSchema.openapi({
      param: { name: 'type', in: 'query' },
      example: 'product',
    }),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(280)
      .openapi({ param: { name: 'slug', in: 'query' }, example: 'genset-silent' }),
  })
  .openapi('StructuredDataQuery');

export type StructuredDataQuery = z.infer<typeof StructuredDataQuerySchema>;

/** A single JSON-LD node. Kept permissive because schema.org vocabularies vary by entity. */
export const JsonLdSchema = z.json().openapi('JsonLd');
export type JsonLd = z.infer<typeof JsonLdSchema>;

export const StructuredDataSchema = z
  .object({
    '@context': z.literal('https://schema.org'),
    '@graph': z.array(JsonLdSchema),
  })
  .openapi('StructuredData');

export type StructuredData = z.infer<typeof StructuredDataSchema>;

export const StructuredDataEnvelopeSchema = createSuccessEnvelopeSchema(
  StructuredDataSchema,
  'StructuredDataEnvelope',
);

export const RedirectSchema = z
  .object({
    entityType: StructuredDataTypeSchema,
    oldSlug: z.string(),
    newSlug: z.string(),
    permanent: z.literal(true),
  })
  .openapi('Redirect');

export type Redirect = z.infer<typeof RedirectSchema>;

export const RedirectEnvelopeSchema = createSuccessEnvelopeSchema(
  RedirectSchema,
  'RedirectEnvelope',
);
