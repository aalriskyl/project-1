import { z } from 'zod';

const PostgresUrlSchema = z
  .string()
  .min(1)
  .refine((val) => val.startsWith('postgres://') || val.startsWith('postgresql://'), {
    message: 'Must be a valid postgres:// or postgresql:// connection string',
  });

const CorsOriginsSchema = z
  .string()
  .min(1)
  .transform((raw) =>
    raw
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .refine((origins) => origins.length > 0, {
    message: 'CORS_ORIGINS must contain at least one allowed origin',
  })
  .refine(
    (origins) =>
      origins.every((origin) => {
        if (origin === '*') return false;
        try {
          const parsed = new URL(origin);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      }),
    {
      message: 'CORS_ORIGINS entries must be explicit http(s) origins (wildcard "*" is forbidden)',
    },
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  CORS_ORIGINS: CorsOriginsSchema,
  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  DATABASE_URL: PostgresUrlSchema,
  DIRECT_URL: PostgresUrlSchema.optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  DB_IDLE_TIMEOUT_SEC: z.coerce.number().int().positive().default(20),
  DB_CONNECT_TIMEOUT_SEC: z.coerce.number().int().positive().default(10),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('project-1-api'),
  JWT_AUDIENCE: z.string().min(1).default('project-1-client'),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(900),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().min(300).max(2_592_000).default(604_800),
});

export type Env = Omit<z.infer<typeof EnvSchema>, 'LOG_LEVEL'> & {
  readonly LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
};

export function parseEnv(rawEnv: Record<string, string | undefined>): Env {
  const parsed = EnvSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const formattedIssues = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    throw new Error(`Invalid environment configuration: ${JSON.stringify(formattedIssues)}`);
  }
  return {
    ...parsed.data,
    LOG_LEVEL: parsed.data.LOG_LEVEL ?? (parsed.data.NODE_ENV === 'test' ? 'silent' : 'info'),
  };
}

export const env: Env = parseEnv(process.env);
