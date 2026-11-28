import { z } from 'zod';

const OperationSchema = z
  .object({
    responses: z.record(z.string(), z.unknown()).optional(),
    security: z.array(z.unknown()).optional(),
  })
  .passthrough();

const DocumentSchema = z
  .object({
    paths: z.record(z.string(), z.record(z.string(), OperationSchema)),
  })
  .passthrough();

const ErrorResponse = {
  description: 'Request rejected',
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
  },
} as const;

const RATE_LIMITED = {
  ...ErrorResponse,
  description: 'Rate limit exceeded',
};

const FORBIDDEN = {
  ...ErrorResponse,
  description: 'Insufficient privileges or inactive account',
};

/**
 * Error responses that are produced by middleware, not by individual handlers.
 * Applying them once keeps the generated spec honest without repeating them in
 * every route definition.
 */
export function withMiddlewareErrorResponses(spec: unknown): unknown {
  const document = DocumentSchema.parse(spec);
  for (const [path, methods] of Object.entries(document.paths)) {
    if (path === '/health' || path === '/ready') continue;
    const operations = document.paths[path];
    if (operations === undefined) continue;
    for (const [method, operation] of Object.entries(methods)) {
      const responses = { ...(operation.responses ?? {}) };
      if (responses['429'] === undefined) responses['429'] = RATE_LIMITED;
      if (operation.security !== undefined && responses['403'] === undefined) {
        responses['403'] = FORBIDDEN;
      }
      operations[method] = { ...operation, responses };
    }
  }
  return document;
}
