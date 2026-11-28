import { z } from '@hono/zod-openapi';
import { ValidationError } from '@/lib/shared/errors.ts';

const MAX_DEFAULT_SLUG_LENGTH = 200;
const KEBAB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Shared Zod validator for lowercase kebab-case URL/brand slugs.
 */
export function createSlugSchema(
  maxLength: number,
  message: string = 'Slug must be lowercase kebab-case',
) {
  return z.string().trim().min(1).max(maxLength).regex(KEBAB_SLUG_RE, message);
}

/**
 * Normalizes arbitrary titles/names into clean URL-safe ASCII slugs.
 */
export function slugify(raw: string, maxLength: number = MAX_DEFAULT_SLUG_LENGTH): string {
  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

  if (normalized.length === 0) {
    throw new ValidationError('Unable to derive a valid URL slug from input', [
      { field: 'slug', message: 'Slug must contain at least one alphanumeric character' },
    ]);
  }

  return normalized;
}
