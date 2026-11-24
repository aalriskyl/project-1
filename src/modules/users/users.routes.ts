import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/errors.ts';
import { getRequiredUser, requireAuth } from '@/middlewares/auth.ts';
import {
  ListUsersQuerySchema,
  UpdateMeBodySchema,
  UserCursorPageSchema,
  UserEnvelopeSchema,
  UserIdParamSchema,
} from '@/modules/users/users.schema.ts';
import type { UsersService } from '@/modules/users/users.service.ts';
import type { AppEnv } from '@/types/app.ts';

const getMeRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Users'],
  summary: 'Get the authenticated user profile',
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: 'Authenticated user profile',
      content: { 'application/json': { schema: UserEnvelopeSchema } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'User record not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const updateMeRoute = createRoute({
  method: 'patch',
  path: '/me',
  tags: ['Users'],
  summary: 'Update the authenticated user profile',
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateMeBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated user profile',
      content: { 'application/json': { schema: UserEnvelopeSchema } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const listUsersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Users'],
  summary: 'List users with cursor pagination (admin only)',
  security: [{ BearerAuth: [] }],
  request: {
    query: ListUsersQuerySchema,
  },
  responses: {
    200: {
      description: 'Cursor-paginated user list',
      content: { 'application/json': { schema: UserCursorPageSchema } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin privileges required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Invalid query parameters or cursor',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getUserByIdRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Users'],
  summary: 'Get a user by ID (self or admin)',
  security: [{ BearerAuth: [] }],
  request: {
    params: UserIdParamSchema,
  },
  responses: {
    200: {
      description: 'User profile',
      content: { 'application/json': { schema: UserEnvelopeSchema } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Forbidden (IDOR ownership check failed)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Invalid UUID path parameter',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export function createUsersRoutes(
  usersService: UsersService,
  authMiddleware: MiddlewareHandler<AppEnv> = requireAuth,
) {
  const router = new OpenAPIHono<AppEnv>({ defaultHook: defaultOpenApiHook });

  router.use('*', authMiddleware);

  return router
    .openapi(getMeRoute, async (c) => {
      const actor = getRequiredUser(c);
      const data = await usersService.getMe(actor);
      return c.json({ data }, 200);
    })
    .openapi(updateMeRoute, async (c) => {
      const actor = getRequiredUser(c);
      const body = c.req.valid('json');
      const data = await usersService.updateMe(actor, body);
      return c.json({ data }, 200);
    })
    .openapi(listUsersRoute, async (c) => {
      const actor = getRequiredUser(c);
      const query = c.req.valid('query');
      const page = await usersService.listUsers(actor, query);
      return c.json(
        {
          data: [...page.data],
          meta: page.meta,
        },
        200,
      );
    })
    .openapi(getUserByIdRoute, async (c) => {
      const actor = getRequiredUser(c);
      const { id } = c.req.valid('param');
      const data = await usersService.getUserById(actor, id);
      return c.json({ data }, 200);
    });
}
