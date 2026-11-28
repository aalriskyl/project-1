import { createMiddleware } from 'hono/factory';
import { logger as rootLogger } from '@/lib/logging/logger.ts';
import type { AppEnv } from '@/types/app.ts';

export const requestLoggerMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const startMs = performance.now();
  const requestId = c.get('requestId');
  const childLogger = rootLogger.child({ requestId });

  c.set('logger', childLogger);

  await next();

  const latencyMs = Math.round((performance.now() - startMs) * 100) / 100;
  const status = c.res.status;
  const userId = c.get('user')?.id;

  const logData = {
    method: c.req.method,
    path: c.req.path,
    status,
    latencyMs,
    ...(userId !== undefined ? { userId } : {}),
  };

  if (status >= 500) {
    childLogger.error(logData, 'request completed with server error');
  } else if (status >= 400) {
    childLogger.warn(logData, 'request completed with client error');
  } else {
    childLogger.info(logData, 'request completed');
  }
});
