import { z } from '@hono/zod-openapi';
import { createCursorPageSchema, CursorPaginationQuerySchema } from '@/lib/pagination.ts';
import { USER_ROLES } from '@/types/app.ts';

export const PhoneE164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone number must be in E.164 format (e.g. +6281234567890)');

export const UserSchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000001' }),
    email: z.email().openapi({ example: 'ada@example.com' }),
    phone: z.string().nullable().openapi({ example: '+6281234567890' }),
    displayName: z.string().min(1).max(120).openapi({ example: 'Ada Lovelace' }),
    role: z.enum(USER_ROLES).openapi({ example: 'user' }),
    createdAt: z.iso.datetime().openapi({ example: '2026-11-24T06:00:00.000Z' }),
    updatedAt: z.iso.datetime().openapi({ example: '2026-11-24T06:00:00.000Z' }),
  })
  .openapi('User');

export type PublicUser = z.infer<typeof UserSchema>;

export const UserEnvelopeSchema = z
  .object({
    data: UserSchema,
  })
  .openapi('UserEnvelope');

export const UserIdParamSchema = z.object({
  id: z.uuid().openapi({
    param: { name: 'id', in: 'path' },
    example: '01936c8e-7f2a-7000-8000-000000000001',
  }),
});

export const UpdateMeBodySchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(120).optional().openapi({ example: 'Ada Byron' }),
    phone: PhoneE164Schema.nullable().optional().openapi({ example: '+6281234567890' }),
  })
  .refine((body) => body.displayName !== undefined || body.phone !== undefined, {
    message: 'At least one of displayName or phone must be provided',
  })
  .openapi('UpdateMeBody');

export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>;

export const ListUsersQuerySchema = CursorPaginationQuerySchema;
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

export const UserCursorPageSchema = createCursorPageSchema(UserSchema, 'UserCursorPage');
