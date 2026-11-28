/**
 * Runtime adapter for sortable, non-guessable UUIDv7 identifiers.
 * Keeps Bun-specific API isolated in `src/lib/`.
 */
export function generateId(): string {
  return Bun.randomUUIDv7();
}
