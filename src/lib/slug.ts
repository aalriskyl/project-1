import { ValidationError } from '@/lib/errors.ts';

const MAX_DEFAULT_SLUG_LENGTH = 200;

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
