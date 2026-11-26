import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { defaultOpenApiHook, ErrorResponseSchema } from '@/lib/errors.ts';
import { ok, okPage } from '@/lib/response.ts';
import { getRequiredUser, requireAuth } from '@/middlewares/auth.ts';
import {
  CreateAdminUserBodySchema,
  ListUsersQuerySchema,
  UpdateMeBodySchema,
  UpdateUserStatusBodySchema,
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
  summary: 'Get Current User',
  description: 'Fetch the authenticated user profile.',
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
    403: {
      description: 'Account has been deactivated',
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
  summary: 'Update Current User',
  description: 'Update the authenticated user name/displayName, E.164 phone number, or address.',
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
    403: {
      description: 'Account has been deactivated',
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
  summary: 'Admin: List Users',
  description:
    'List users (active and inactive) with cursor or optional numbered `?page=` pagination, `?q=` fuzzy search, `?role=`, and `?status=` filters.',
  security: [{ BearerAuth: [] }],
  request: {
    query: ListUsersQuerySchema,
  },
  responses: {
    200: {
      description: 'Paginated user list',
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

const createUserRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Users'],
  summary: 'Admin: Create User',
  description:
    'Create a customer or admin/staff user account directly with Argon2id password hashing.',
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CreateAdminUserBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'User created',
      content: { 'application/json': { schema: UserEnvelopeSchema } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin privileges required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Email already exists',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const getUserByIdRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Users'],
  summary: 'Get User by ID',
  description: 'Fetch a user profile by ID (restricted to self or admin).',
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
      description: 'Forbidden (IDOR ownership check failed or account inactive)',
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

const updateUserStatusRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Users'],
  summary: 'Admin: Update User',
  description:
    'Update user profile (`name`, `email`, `phone`, `address`), role (`customer` | `admin`), or activate/deactivate status (`status: "active" | "inactive"`). Deactivating or changing role revokes all active refresh tokens.',
  security: [{ BearerAuth: [] }],
  request: {
    params: UserIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: UpdateUserStatusBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'User updated',
      content: { 'application/json': { schema: UserEnvelopeSchema } },
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin privileges required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description:
        'Email already exists, cannot deactivate your own account, or cannot demote yourself',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Validation failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const deleteUserRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Users'],
  summary: 'Admin: Delete User',
  description:
    'Soft-delete a user (`status = "inactive"`, `deletedAt = now()`) and revoke all active refresh tokens. Restorable via `PATCH /v1/users/{id}`.',
  security: [{ BearerAuth: [] }],
  request: {
    params: UserIdParamSchema,
  },
  responses: {
    204: {
      description: 'User soft-deleted (marked inactive)',
    },
    401: {
      description: 'Missing or invalid access token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Admin privileges required',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'User not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Cannot deactivate your own account',
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
      return c.json(ok(data, 'User profile retrieved successfully'), 200);
    })
    .openapi(updateMeRoute, async (c) => {
      const actor = getRequiredUser(c);
      const body = c.req.valid('json');
      const data = await usersService.updateMe(actor, body);
      return c.json(ok(data, 'User profile updated successfully'), 200);
    })
    .openapi(listUsersRoute, async (c) => {
      const actor = getRequiredUser(c);
      const query = c.req.valid('query');
      const page = await usersService.listUsers(actor, query);
      return c.json(okPage(page, 'Users retrieved successfully'), 200);
    })
    .openapi(createUserRoute, async (c) => {
      const actor = getRequiredUser(c);
      const body = c.req.valid('json');
      const data = await usersService.createUser(actor, body);
      return c.json(ok(data, 'User created successfully'), 201);
    })
    .openapi(getUserByIdRoute, async (c) => {
      const actor = getRequiredUser(c);
      const { id } = c.req.valid('param');
      const data = await usersService.getUserById(actor, id);
      return c.json(ok(data, 'User retrieved successfully'), 200);
    })
    .openapi(updateUserStatusRoute, async (c) => {
      const actor = getRequiredUser(c);
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const data = await usersService.updateUserStatus(actor, id, body);
      return c.json(ok(data, 'User status updated successfully'), 200);
    })
    .openapi(deleteUserRoute, async (c) => {
      const actor = getRequiredUser(c);
      const { id } = c.req.valid('param');
      await usersService.deleteUser(actor, id);
      return c.body(null, 204);
    });
}
