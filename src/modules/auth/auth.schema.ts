import { z } from '@hono/zod-openapi';
import { createSuccessEnvelopeSchema } from '@/lib/response.ts';
import {
  PhoneE164Schema,
  UserAddressSchema,
  UserEmailSchema,
  UserSchema,
} from '@/modules/users/users.schema.ts';

export const RegisterBodySchema = z
  .strictObject({
    email: UserEmailSchema,
    password: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be at most 128 characters')
      .openapi({ example: 'correct-horse-battery-staple' }),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .openapi({ example: 'Ada Lovelace', deprecated: true }),
    displayName: z.string().trim().min(1).max(120).optional().openapi({ example: 'Ada Lovelace' }),
    phone: PhoneE164Schema.optional().openapi({ example: '+6281234567890' }),
    address: UserAddressSchema.optional(),
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
  .openapi('RegisterBody');

export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const LoginBodySchema = z
  .strictObject({
    email: z
      .email()
      .max(255)
      .transform((value) => value.trim().toLowerCase())
      .openapi({ example: 'ada@example.com' }),
    password: z.string().min(1).max(128).openapi({ example: 'correct-horse-battery-staple' }),
  })
  .openapi('LoginBody');

export type LoginBody = z.infer<typeof LoginBodySchema>;

export const GoogleLoginBodySchema = z
  .strictObject({
    idToken: z.string().trim().min(20).max(4096).openapi({
      description: 'Google Sign-In OpenID Connect ID token verified via Google JWKS',
    }),
  })
  .openapi('GoogleLoginBody');

export type GoogleLoginBody = z.infer<typeof GoogleLoginBodySchema>;

export const ForgotPasswordBodySchema = z
  .strictObject({
    email: z
      .email()
      .max(255)
      .transform((value) => value.trim().toLowerCase())
      .openapi({ example: 'ada@example.com' }),
  })
  .openapi('ForgotPasswordBody');

export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBodySchema>;

export const ResetPasswordBodySchema = z
  .strictObject({
    token: z.string().trim().min(20).max(256),
    newPassword: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be at most 128 characters'),
  })
  .openapi('ResetPasswordBody');

export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>;

export const ChangePasswordBodySchema = z
  .strictObject({
    currentPassword: z
      .string()
      .min(1)
      .max(128)
      .openapi({ example: 'correct-horse-battery-staple' }),
    newPassword: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be at most 128 characters')
      .openapi({ example: 'brand-new-strong-passphrase-2026' }),
  })
  .refine((body) => body.newPassword !== body.currentPassword, {
    path: ['newPassword'],
    message: 'New password must be different from the current password',
  })
  .openapi('ChangePasswordBody');

export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;

export const RefreshBodySchema = z
  .strictObject({
    refreshToken: z.string().min(20).max(256).openapi({
      example: 'dGhpcy1pcy1hbi1vcGFxdWUtcmVmcmVzaC10b2tlbg',
    }),
  })
  .openapi('RefreshBody');

export type RefreshBody = z.infer<typeof RefreshBodySchema>;

export const LogoutBodySchema = RefreshBodySchema.openapi('LogoutBody');
export type LogoutBody = z.infer<typeof LogoutBodySchema>;

export const AuthTokensSchema = z
  .object({
    accessToken: z.string().openapi({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }),
    refreshToken: z.string().openapi({ example: 'dGhpcy1pcy1hbi1vcGFxdWUtcmVmcmVzaC10b2tlbg' }),
    tokenType: z.literal('Bearer').openapi({ example: 'Bearer' }),
    expiresIn: z.number().int().positive().openapi({ example: 900 }),
  })
  .openapi('AuthTokens');

export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const AuthSessionSchema = z
  .object({
    user: UserSchema,
    tokens: AuthTokensSchema,
  })
  .openapi('AuthSession');

export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const AuthSessionEnvelopeSchema = createSuccessEnvelopeSchema(
  AuthSessionSchema,
  'AuthSessionEnvelope',
);

export const ForgotPasswordEnvelopeSchema = createSuccessEnvelopeSchema(
  z.object({
    message: z.string(),
  }),
  'ForgotPasswordEnvelope',
);
