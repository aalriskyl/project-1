import pino, { type Logger } from 'pino';
import { env } from '@/config/env.ts';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  'token',
  '*.token',
  'secret',
  '*.secret',
];

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'project-1-api',
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: REDACTED_PATHS,
    censor: '[REDACTED]',
  },
});
