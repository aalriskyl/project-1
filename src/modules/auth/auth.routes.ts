import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/errors.ts';
import {
  AuthSessionEnvelopeSchema,
  ForgotPasswordBodySchema,
  ForgotPasswordEnvelopeSchema,
  GoogleLoginBodySchema,
  LoginBodySchema,
  LogoutBodySchema,
  RefreshBodySchema,
  RegisterBodySchema,
  ResetPasswordBodySchema,
} from '@/modules/auth/auth.schema.ts';
import type { AuthService } from '@/modules/auth/auth.service.ts';
import type { AppEnv } from '@/types/app.ts';

const registerRoute = createRoute({
  method: 'post',
  path: '/register',
  tags: ['Auth'],
  summary: 'Register a new user account',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: RegisterBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Account created and initial token pair issued',
      content: { 'application/json': { schema: AuthSessionEnvelopeSchema } },
    },
    409: {
      description: 'Email already registered',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: {
      description: 'Auth rate limit exceeded',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const loginRoute = createRoute({
  method: 'post',
  path: '/login',
  tags: ['Auth'],
  summary: 'Authenticate with email and password',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: LoginBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Authenticated and new token pair issued',
      content: { 'application/json': { schema: AuthSessionEnvelopeSchema } },
    },
    401: {
      description: 'Invalid credentials',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: {
      description: 'Auth rate limit exceeded',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const googleLoginRoute = createRoute({
  method: 'post',
  path: '/google',
  tags: ['Auth'],
  summary: 'Authenticate or register using a Google Sign-In ID token (verified via JWKS)',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: GoogleLoginBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Authenticated via Google and token pair issued',
      content: { 'application/json': { schema: AuthSessionEnvelopeSchema } },
    },
    401: {
      description: 'Invalid or unverified Google ID token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Email already linked to a different Google identity',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    503: {
      description: 'Google OAuth client ID not configured',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const forgotPasswordRoute = createRoute({
  method: 'post',
  path: '/forgot-password',
  tags: ['Auth'],
  summary: 'Request a single-use password reset email',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: ForgotPasswordBodySchema } },
    },
  },
  responses: {
    202: {
      description: 'Reset email queued if account exists',
      content: { 'application/json': { schema: ForgotPasswordEnvelopeSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: {
      description: 'Auth rate limit exceeded',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const resetPasswordRoute = createRoute({
  method: 'post',
  path: '/reset-password',
  tags: ['Auth'],
  summary: 'Consume a password reset token, update password, and revoke all sessions',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: ResetPasswordBodySchema } },
    },
  },
  responses: {
    204: {
      description: 'Password reset succeeded and active sessions revoked',
    },
    401: {
      description: 'Invalid or expired reset token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: {
      description: 'Auth rate limit exceeded',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/refresh',
  tags: ['Auth'],
  summary: 'Rotate refresh token and issue a new access token',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: RefreshBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Rotated token pair',
      content: { 'application/json': { schema: AuthSessionEnvelopeSchema } },
    },
    401: {
      description: 'Invalid, expired, or reused refresh token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: {
      description: 'Auth rate limit exceeded',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/logout',
  tags: ['Auth'],
  summary: 'Revoke a refresh token',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: LogoutBodySchema } },
    },
  },
  responses: {
    204: {
      description: 'Refresh token revoked',
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: {
      description: 'Auth rate limit exceeded',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function createAuthRoutes(
  authService: AuthService,
  authRateLimiter?: MiddlewareHandler<AppEnv>,
) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  if (authRateLimiter !== undefined) {
    router.use('*', authRateLimiter);
  }

  return router
    .openapi(registerRoute, async (c) => {
      const body = c.req.valid('json');
      const data = await authService.register(body);
      return c.json({ data }, 201);
    })
    .openapi(loginRoute, async (c) => {
      const body = c.req.valid('json');
      const data = await authService.login(body);
      return c.json({ data }, 200);
    })
    .openapi(googleLoginRoute, async (c) => {
      const body = c.req.valid('json');
      const data = await authService.googleLogin(body);
      return c.json({ data }, 200);
    })
    .openapi(forgotPasswordRoute, async (c) => {
      const body = c.req.valid('json');
      const data = await authService.forgotPassword(body);
      return c.json({ data }, 202);
    })
    .openapi(resetPasswordRoute, async (c) => {
      const body = c.req.valid('json');
      await authService.resetPassword(body);
      return c.body(null, 204);
    })
    .openapi(refreshRoute, async (c) => {
      const body = c.req.valid('json');
      const data = await authService.refresh(body);
      return c.json({ data }, 200);
    })
    .openapi(logoutRoute, async (c) => {
      const body = c.req.valid('json');
      await authService.logout(body);
      return c.body(null, 204);
    });
}
