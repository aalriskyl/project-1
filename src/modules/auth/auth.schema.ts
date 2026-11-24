import { z } from '@hono/zod-openapi';
import { UserSchema } from '@/modules/users/users.schema.ts';

export const RegisterBodySchema = z
  .strictObject({
    email: z
      .email()
      .max(255)
      .transform((value) => value.trim().toLowerCase())
      .openapi({ example: 'ada@example.com' }),
    password: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be at most 128 characters')
      .openapi({ example: 'correct-horse-battery-staple' }),
    displayName: z.string().trim().min(1).max(120).openapi({ example: 'Ada Lovelace' }),
  })
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

export const AuthSessionEnvelopeSchema = z
  .object({
    data: AuthSessionSchema,
  })
  .openapi('AuthSessionEnvelope');
