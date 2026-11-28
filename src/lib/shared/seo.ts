import { z } from '@hono/zod-openapi';
import { AssetImageUrlSchema, CanonicalUrlSchema } from '@/lib/shared/asset-url.ts';

export const SeoMetadataResponseFields = {
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  focusKeyword: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  noIndex: z.boolean(),
  ogImageUrl: z.string().nullable(),
} as const;

export const SeoMetadataCreateFields = {
  metaTitle: z.string().trim().max(160).nullable().optional(),
  metaDescription: z.string().trim().max(320).nullable().optional(),
  focusKeyword: z.string().trim().max(120).nullable().optional(),
  canonicalUrl: CanonicalUrlSchema.nullable().optional(),
  noIndex: z.boolean().default(false),
  ogImageUrl: AssetImageUrlSchema.nullable().optional(),
} as const;

export const SeoMetadataUpdateFields = {
  metaTitle: z.string().trim().max(160).nullable().optional(),
  metaDescription: z.string().trim().max(320).nullable().optional(),
  focusKeyword: z.string().trim().max(120).nullable().optional(),
  canonicalUrl: CanonicalUrlSchema.nullable().optional(),
  noIndex: z.boolean().optional(),
  ogImageUrl: AssetImageUrlSchema.nullable().optional(),
} as const;
