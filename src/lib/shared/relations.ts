import { z } from '@hono/zod-openapi';

export const CategorySummaryRefSchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000101' }),
    name: z.string().openapi({ example: 'Engine Perkins' }),
    slug: z.string().openapi({ example: 'engine-perkins' }),
  })
  .openapi('CategorySummaryRef');

export type CategorySummaryRef = z.infer<typeof CategorySummaryRefSchema>;

export const ProductSummaryRefSchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000401' }),
    name: z
      .string()
      .openapi({ example: 'Genset 30 kVA Silent Diesel Tsuzumi TPG30 Powered by Perkins' }),
    slug: z.string().openapi({ example: 'genset-30-kva-silent-diesel-tsuzumi-tpg30' }),
  })
  .openapi('ProductSummaryRef');

export type ProductSummaryRef = z.infer<typeof ProductSummaryRefSchema>;

export const AuthorSummaryRefSchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000001' }),
    name: z.string().openapi({ example: 'Budi Santoso' }),
  })
  .openapi('AuthorSummaryRef');

export type AuthorSummaryRef = z.infer<typeof AuthorSummaryRefSchema>;
