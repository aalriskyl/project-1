import { z } from '@hono/zod-openapi';
import {
  AdminPaginationQuerySchema,
  CreatedFromQuerySchema,
  CreatedToQuerySchema,
  createCursorPageSchema,
} from '@/lib/api/pagination.ts';
import { createSuccessEnvelopeSchema } from '@/lib/api/response.ts';
import { SearchQueryParamSchema } from '@/lib/api/search.ts';
import { RecordStatusSchema, StatusFilterQueryParamSchema } from '@/lib/api/status.ts';
import { USER_ROLES } from '@/types/app.ts';

export const PhoneE164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone number must be in E.164 format (e.g. +6281234567890)');

export const UserAddressSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .openapi({ example: 'Jl. Pangeran Jayakarta No. 129, Jakarta Pusat' });

export const UserEmailSchema = z
  .email()
  .max(255)
  .transform((value) => value.trim().toLowerCase())
  .openapi({ example: 'ada@example.com' });

export const UserSchema = z
  .object({
    id: z.uuid().openapi({ example: '01936c8e-7f2a-7000-8000-000000000001' }),
    email: z.email().openapi({ example: 'ada@example.com' }),
    name: z.string().min(1).max(120).openapi({ example: 'Rapienuraim' }),
    displayName: z.string().min(1).max(120).openapi({ example: 'Rapienuraim' }),
    phone: z.string().nullable().openapi({ example: '+6281234567890' }),
    address: z.string().nullable().openapi({ example: 'Jl. Pangeran Jayakarta No. 129, Jakarta' }),
    role: z.enum(USER_ROLES).openapi({ example: 'user' }),
    isActive: z.boolean().openapi({ example: true, deprecated: true }),
    status: RecordStatusSchema.openapi({ example: 'active' }),
    deletedAt: z.iso.datetime().nullable().openapi({ example: null, deprecated: true }),
    createdAt: z.iso.datetime().openapi({ example: '2026-11-24T06:00:00.000Z' }),
    updatedAt: z.iso.datetime().openapi({ example: '2026-11-24T06:00:00.000Z' }),
  })
  .openapi('User');

export type PublicUser = z.infer<typeof UserSchema>;

export const UserEnvelopeSchema = createSuccessEnvelopeSchema(UserSchema, 'UserEnvelope');

export const UserIdParamSchema = z.object({
  id: z.uuid().openapi({
    param: { name: 'id', in: 'path' },
    example: '01936c8e-7f2a-7000-8000-000000000001',
  }),
});

export const UpdateMeBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional().openapi({ example: 'Ada Byron' }),
    displayName: z.string().trim().min(1).max(120).optional().openapi({ example: 'Ada Byron' }),
    phone: PhoneE164Schema.nullable().optional().openapi({ example: '+6281234567890' }),
    address: UserAddressSchema.nullable().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.displayName !== undefined ||
      body.phone !== undefined ||
      body.address !== undefined,
    {
      message: 'At least one of name, displayName, phone, or address must be provided',
    },
  )
  .refine(
    (body) =>
      body.name === undefined || body.displayName === undefined || body.name === body.displayName,
    {
      path: ['name'],
      message: 'name and displayName must match when both are provided',
    },
  )
  .openapi('UpdateMeBody');

export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>;

export const CreateAdminUserBodySchema = z
  .strictObject({
    email: UserEmailSchema,
    password: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be at most 128 characters')
      .openapi({ example: 'staff-strong-passphrase-2026' }),
    name: z.string().trim().min(1).max(120).optional().openapi({ example: 'Staff Member' }),
    displayName: z.string().trim().min(1).max(120).optional().openapi({ example: 'Staff Member' }),
    phone: PhoneE164Schema.nullable().optional().openapi({ example: '+6281234567890' }),
    address: UserAddressSchema.nullable().optional(),
    role: z.enum(USER_ROLES).default('user').openapi({ example: 'admin' }),
    status: RecordStatusSchema.optional().openapi({ example: 'active' }),
    isActive: z.boolean().optional().openapi({ example: true }),
  })
  .refine((body) => body.name !== undefined || body.displayName !== undefined, {
    path: ['name'],
    message: 'Provide name (or displayName)',
  })
  .refine(
    (body) =>
      body.name === undefined || body.displayName === undefined || body.name === body.displayName,
    {
      path: ['name'],
      message: 'name and displayName must match when both are provided',
    },
  )
  .openapi('CreateAdminUserBody');

export type CreateAdminUserBody = z.infer<typeof CreateAdminUserBodySchema>;

export const UpdateUserStatusBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional().openapi({ example: 'Ada Byron' }),
    displayName: z.string().trim().min(1).max(120).optional().openapi({ example: 'Ada Byron' }),
    email: UserEmailSchema.optional(),
    phone: PhoneE164Schema.nullable().optional().openapi({ example: '+6281234567890' }),
    address: UserAddressSchema.nullable().optional(),
    role: z.enum(USER_ROLES).optional().openapi({ example: 'admin' }),
    status: RecordStatusSchema.optional().openapi({ example: 'active' }),
    isActive: z.boolean().optional().openapi({ example: true }),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.displayName !== undefined ||
      body.email !== undefined ||
      body.phone !== undefined ||
      body.address !== undefined ||
      body.role !== undefined ||
      body.status !== undefined ||
      body.isActive !== undefined,
    {
      message:
        'Provide at least one of name, displayName, email, phone, address, role, status, or isActive',
    },
  )
  .refine(
    (body) =>
      body.name === undefined || body.displayName === undefined || body.name === body.displayName,
    {
      path: ['name'],
      message: 'name and displayName must match when both are provided',
    },
  )
  .openapi('UpdateUserStatusBody');

export type UpdateUserStatusBody = z.infer<typeof UpdateUserStatusBodySchema>;

export const ListUsersQuerySchema = AdminPaginationQuerySchema.extend({
  q: SearchQueryParamSchema,
  role: z
    .enum(USER_ROLES)
    .optional()
    .openapi({
      param: { name: 'role', in: 'query' },
      description: 'Filter users by role (user or admin)',
    }),
  status: StatusFilterQueryParamSchema,
  createdFrom: CreatedFromQuerySchema,
  createdTo: CreatedToQuerySchema,
});
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

export const UserCursorPageSchema = createCursorPageSchema(UserSchema, 'UserCursorPage');
