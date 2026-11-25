import { z } from '@hono/zod-openapi';
import { createSuccessEnvelopeSchema } from '@/lib/response.ts';
import { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_UPLOAD_BYTES, MEDIA_FOLDERS } from '@/lib/storage.ts';

export const RequestUploadUrlBodySchema = z
  .strictObject({
    folder: z.enum(MEDIA_FOLDERS).openapi({ example: 'products' }),
    contentType: z.enum(ALLOWED_IMAGE_MIME_TYPES).openapi({ example: 'image/webp' }),
    contentLengthBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_IMAGE_UPLOAD_BYTES)
      .openapi({ example: 245_000 }),
  })
  .openapi('RequestUploadUrlBody');

export type RequestUploadUrlBody = z.infer<typeof RequestUploadUrlBodySchema>;

export const SignedUploadUrlSchema = z
  .object({
    uploadId: z.uuid(),
    bucket: z.string().openapi({ example: 'public-assets' }),
    objectPath: z
      .string()
      .openapi({ example: 'products/2026/11/01936c8e-7f2a-7000-8000-000000000301.webp' }),
    uploadUrl: z.url(),
    publicUrl: z.url(),
    token: z.string().nullable(),
    expiresInSec: z.number().int().positive().openapi({ example: 7200 }),
    requiredHeaders: z.object({
      'Content-Type': z.enum(ALLOWED_IMAGE_MIME_TYPES),
    }),
  })
  .openapi('SignedUploadUrl');

export const SignedUploadUrlEnvelopeSchema = createSuccessEnvelopeSchema(
  SignedUploadUrlSchema,
  'SignedUploadUrlEnvelope',
);

export const CleanupOrphansBodySchema = z
  .strictObject({
    olderThanHours: z.number().int().min(3).max(8_760).default(24).openapi({ example: 24 }),
    limit: z.number().int().min(1).max(500).default(100).openapi({ example: 100 }),
  })
  .openapi('CleanupOrphansBody');

export type CleanupOrphansBody = z.infer<typeof CleanupOrphansBodySchema>;

export const CompleteUploadParamSchema = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
});
export const CompletedUploadEnvelopeSchema = createSuccessEnvelopeSchema(
  z.object({ uploadId: z.uuid(), publicUrl: z.url(), status: z.literal('verified') }),
  'CompletedUploadEnvelope',
);

export const CleanupOrphansResultSchema = z
  .object({
    scannedCount: z.number().int().nonnegative(),
    deletedCount: z.number().int().nonnegative(),
    deletedPaths: z.array(z.string()),
  })
  .openapi('CleanupOrphansResult');

export type CleanupOrphansResult = z.infer<typeof CleanupOrphansResultSchema>;

export const CleanupOrphansEnvelopeSchema = createSuccessEnvelopeSchema(
  CleanupOrphansResultSchema,
  'CleanupOrphansEnvelope',
);
