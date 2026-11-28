import { hashTokenSha256 } from '@/lib/auth/crypto.ts';
import { ConflictError, NotFoundError } from '@/lib/shared/errors.ts';
import { generateId } from '@/lib/auth/id.ts';
import { sanitizeMarkdown } from '@/lib/shared/markdown.ts';
import type { CursorPage } from '@/lib/api/pagination.ts';
import { paginateAdminList } from '@/lib/api/pagination.ts';
import { encryptInquiryMail } from '@/lib/integrations/mail-outbox-crypto.ts';
import { assertAdminUser } from '@/middlewares/auth/authorize.ts';
import type { InquiryRow } from '@/db/schema/inquiries.ts';
import {
  type CreateInquiryBody,
  type Inquiry,
  type ListAdminInquiriesQuery,
  InquiryStatusSchema,
  type InquiryReceipt,
  type UpdateInquiryStatusBody,
} from '@/modules/inquiries/inquiries.schema.ts';
import type {
  CreateInquiryRecord,
  InquiriesRepository,
} from '@/modules/inquiries/inquiries.repository.ts';
import type { ProductsRepository } from '@/modules/products/products.repository.ts';
import type { AuthUser } from '@/types/app.ts';

const INQUIRY_MAIL_TTL_MS = 24 * 60 * 60 * 1_000;

export interface InquiriesServiceDependencies {
  readonly inquiriesRepo: InquiriesRepository;
  readonly productsRepo: Pick<ProductsRepository, 'findActiveByIds'>;
  readonly notificationEmail?: string;
  readonly mailEncryptionKey?: string;
}

export interface InquiriesService {
  submit(body: CreateInquiryBody, idempotencyKey: string): Promise<InquiryReceipt>;
  listAdmin(query: ListAdminInquiriesQuery): Promise<CursorPage<Inquiry>>;
  updateStatus(actor: AuthUser, id: string, input: UpdateInquiryStatusBody): Promise<Inquiry>;
}

export function serializeInquiryReceipt(row: InquiryRow): InquiryReceipt {
  return {
    id: row.id,
    productId: row.productId,
    status: InquiryStatusSchema.parse(row.status),
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeInquiry(row: InquiryRow): Inquiry {
  return {
    ...serializeInquiryReceipt(row),
    name: row.name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createInquiriesService(deps: InquiriesServiceDependencies): InquiriesService {
  async function buildDelivery(record: CreateInquiryRecord, productName: string | null) {
    if (
      deps.notificationEmail === undefined ||
      deps.mailEncryptionKey === undefined ||
      deps.notificationEmail.length === 0
    ) {
      return undefined;
    }

    const subject = productName === null ? 'New RFQ / pre-order request' : `RFQ: ${productName}`;
    const text = [
      'A new quote request was submitted.',
      '',
      `Name: ${record.name}`,
      `Email: ${record.email}`,
      `Phone: ${record.phone ?? '-'}`,
      `Product: ${productName ?? '-'}`,
      '',
      record.message,
    ].join('\n');

    return {
      id: generateId(),
      payload: await encryptInquiryMail(
        {
          to: deps.notificationEmail,
          replyTo: record.email,
          subject,
          text,
        },
        deps.mailEncryptionKey,
      ),
      expiresAt: new Date(Date.now() + INQUIRY_MAIL_TTL_MS),
    };
  }

  return {
    async submit(body, idempotencyKey) {
      const fingerprint = hashTokenSha256(
        JSON.stringify({
          name: body.name,
          email: body.email.toLowerCase(),
          phone: body.phone ?? null,
          message: body.message,
          productId: body.productId ?? null,
        }),
      );
      const existing = await deps.inquiriesRepo.findByIdempotencyKey(idempotencyKey);
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new ConflictError(
            'Idempotency-Key was already used with a different request body',
            'CONFLICT',
          );
        }
        return serializeInquiryReceipt(existing);
      }

      let productName: string | null = null;
      if (body.productId !== undefined && body.productId !== null) {
        const [product] = await deps.productsRepo.findActiveByIds([body.productId]);
        if (product === undefined) {
          throw new NotFoundError('Product not found', 'PRODUCT_NOT_FOUND');
        }
        productName = product.name;
      }

      const record: CreateInquiryRecord = {
        id: generateId(),
        productId: body.productId ?? null,
        name: body.name,
        email: body.email.toLowerCase(),
        phone: body.phone ?? null,
        message: sanitizeMarkdown(body.message),
        status: 'new',
        idempotencyKey,
        requestFingerprint: fingerprint,
      };
      const delivery = await buildDelivery(record, productName);
      const created = await deps.inquiriesRepo.createWithDelivery(record, delivery);
      return serializeInquiryReceipt(created);
    },

    async listAdmin(query) {
      const filter = {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.productId !== undefined ? { productId: query.productId } : {}),
      };
      return paginateAdminList({
        query,
        listOffset: ({ limit, offset }) => deps.inquiriesRepo.listOffset({ limit, offset, filter }),
        listCursor: ({ limit, cursor }) => deps.inquiriesRepo.listCursor({ limit, cursor, filter }),
        serialize: serializeInquiry,
      });
    },

    async updateStatus(actor, id, input) {
      assertAdminUser(actor);
      const updated = await deps.inquiriesRepo.updateStatus(id, input.status, new Date());
      if (updated === null) {
        throw new NotFoundError('Inquiry not found', 'RESOURCE_NOT_FOUND');
      }
      return serializeInquiry(updated);
    },
  };
}
