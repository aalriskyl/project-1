import { createRoute, type RouteConfig } from '@hono/zod-openapi';

const toIdentifierPart = (value: string): string => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  return cleaned
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
};

/**
 * Wraps `createRoute` with a deterministic, unique `operationId`. Hono mounts module
 * routers under shared prefixes, so the module namespace is required to avoid collisions
 * between routes that have the same local path (e.g. two `GET /` handlers).
 */
export function createNamedRoute(namespace: string) {
  return <P extends string, R extends Omit<RouteConfig, 'path'> & { path: P }>(route: R) => {
    const segments = route.path.split('/').filter((segment) => segment.length > 0);
    const prefix = route.tags?.some((tag) => tag.startsWith('Admin')) === true ? 'admin' : '';
    const operationId = `${prefix}${namespace}${toIdentifierPart(route.method)}${segments
      .map(toIdentifierPart)
      .join('')}`;
    return createRoute({ ...route, operationId });
  };
}
