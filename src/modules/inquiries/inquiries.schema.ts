import { z } from '@hono/zod-openapi';
import { AdminPaginationQuerySchema, createCursorPageSchema } from '@/lib/api/pagination.ts';
import { createSuccessEnvelopeSchema } from '@/lib/api/response.ts';

export const INQUIRY_STATUSES = ['new', 'contacted', 'closed'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export const InquiryStatusSchema = z.enum(INQUIRY_STATUSES).openapi('InquiryStatus');

export const IdempotencyKeyHeaderSchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key contains unsupported characters');

export const CreateInquiryHeadersSchema = z
  .object({
    'Idempotency-Key': IdempotencyKeyHeaderSchema.openapi({
      param: { name: 'Idempotency-Key', in: 'header' },
      example: 'rfq-01936c8e-7f2a-7000-8000-000000000401',
    }),
  })
  .openapi('CreateInquiryHeaders');

export const CreateInquiryBodySchema = z
  .strictObject({
    productId: z.uuid().nullable().optional(),
    name: z.string().trim().min(2).max(120).openapi({ example: 'Andi Saputra' }),
    email: z.email().max(254).openapi({ example: 'andi@example.com' }),
    phone: z
      .string()
      .trim()
      .max(40)
      .regex(/^[0-9+()\- ]+$/, 'phone may only contain digits and phone punctuation')
      .nullable()
      .optional(),
    message: z
      .string()
      .trim()
      .min(10)
      .max(5_000)
      .openapi({ example: 'Saya ingin penawaran harga untuk genset 30 kVA.' }),
  })
  .openapi('CreateInquiryBody');

export type CreateInquiryBody = z.infer<typeof CreateInquiryBodySchema>;

/**
 * The public receipt deliberately omits contact details and echoing the message.
 */
export const InquiryReceiptSchema = z
  .object({
    id: z.uuid(),
    productId: z.uuid().nullable(),
    status: InquiryStatusSchema,
    createdAt: z.iso.datetime(),
  })
  .openapi('InquiryReceipt');

export type InquiryReceipt = z.infer<typeof InquiryReceiptSchema>;

export const InquirySchema = InquiryReceiptSchema.extend({
  name: z.string(),
  email: z.email(),
  phone: z.string().nullable(),
  message: z.string(),
  updatedAt: z.iso.datetime(),
}).openapi('Inquiry');

export type Inquiry = z.infer<typeof InquirySchema>;

export const InquiryEnvelopeSchema = createSuccessEnvelopeSchema(
  InquiryReceiptSchema,
  'InquiryEnvelope',
);

export const InquiryDetailEnvelopeSchema = createSuccessEnvelopeSchema(
  InquirySchema,
  'InquiryDetailEnvelope',
);

export const InquiryCursorPageSchema = createCursorPageSchema(InquirySchema, 'InquiryCursorPage');

export const ListAdminInquiriesQuerySchema = AdminPaginationQuerySchema.extend({
  status: InquiryStatusSchema.optional().openapi({
    param: { name: 'status', in: 'query' },
    description: 'Filter by workflow status',
  }),
  productId: z
    .uuid()
    .optional()
    .openapi({ param: { name: 'productId', in: 'query' } }),
});

export type ListAdminInquiriesQuery = z.infer<typeof ListAdminInquiriesQuerySchema>;

export const UpdateInquiryStatusBodySchema = z
  .strictObject({ status: InquiryStatusSchema })
  .openapi('UpdateInquiryStatusBody');

export type UpdateInquiryStatusBody = z.infer<typeof UpdateInquiryStatusBodySchema>;
