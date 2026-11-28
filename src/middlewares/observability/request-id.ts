import { createMiddleware } from 'hono/factory';
import { generateId } from '@/lib/auth/id.ts';
import type { AppEnv } from '@/types/app.ts';

const SAFE_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

export const requestIdMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId =
    incoming !== undefined && SAFE_REQUEST_ID_PATTERN.test(incoming) ? incoming : generateId();

  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);

  await next();
});
