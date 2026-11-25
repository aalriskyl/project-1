import { z } from '@hono/zod-openapi';
import { and, or, type SQL, sql } from 'drizzle-orm';

export const DEFAULT_FUZZY_SIMILARITY = 0.35;
const MAX_SEARCH_TERMS = 6;

/**
 * Shared Zod query parameter for `?q=` fuzzy text search across all list endpoints.
 */
export const SearchQueryParamSchema = z
  .string()
  .trim()
  .transform((val) => val.replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(120))
  .optional()
  .openapi({
    param: { name: 'q', in: 'query' },
    description: 'Fuzzy text search query (supports typos and partial substring matches)',
    example: 'genset perkins',
  });

/**
 * Escapes `%`, `_`, and `\` for safe parameterized `ILIKE` queries.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Normalizes a raw user search query into bounded lowercase tokens (max 6 terms).
 */
export function tokenizeSearchQuery(rawQuery: string): string[] {
  return rawQuery
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 0)
    .slice(0, MAX_SEARCH_TERMS);
}

/**
 * Tokens containing digits (SKUs, model codes, kVA ratings like `TPG30` vs `TPG50`)
 * or shorter than 3 characters use exact substring matching so model numbers never cross-match.
 */
function isFuzzyEligibleTerm(term: string): boolean {
  return term.length >= 3 && !/\d/.test(term);
}

/**
 * Builds a parameterized PostgreSQL fuzzy search predicate combining:
 * - Case-insensitive substring matching (`ILIKE`) for short codes / alphanumeric SKU fragments
 * - Trigram fuzzy word similarity (`extensions.word_similarity`) for typo-tolerant word search
 * - Optional `tsvector` full-text search (`websearch_to_tsquery('simple', ...)`)
 *
 * Multi-word queries require every token (up to 6) to match via `ILIKE` or `word_similarity`,
 * or the full query to match `searchVector`.
 */
export function buildFuzzySearchCondition(options: {
  readonly targetSql: SQL;
  readonly query: string;
  readonly searchVector?: SQL;
  readonly minSimilarity?: number;
}): SQL {
  const normalized = options.query.trim().replace(/\s+/g, ' ');
  const terms = tokenizeSearchQuery(normalized);
  const threshold = options.minSimilarity ?? DEFAULT_FUZZY_SIMILARITY;

  const termPredicates: SQL[] = terms.map((term) => {
    const likeTerm = `%${escapeLikePattern(term)}%`;
    if (!isFuzzyEligibleTerm(term)) {
      return sql`(${options.targetSql}) ILIKE ${likeTerm}`;
    }
    return sql`((${options.targetSql}) ILIKE ${likeTerm} OR extensions.word_similarity(${term}, ${options.targetSql}) >= ${threshold})`;
  });

  const [firstPredicate, ...restPredicates] = termPredicates;
  if (firstPredicate === undefined) {
    return sql`true`;
  }

  const combinedTerms =
    restPredicates.length === 0
      ? firstPredicate
      : (and(firstPredicate, ...restPredicates) ?? firstPredicate);

  if (options.searchVector !== undefined) {
    const ftsCondition = sql`${options.searchVector} @@ websearch_to_tsquery('simple', ${normalized})`;
    return or(ftsCondition, combinedTerms) ?? combinedTerms;
  }

  return combinedTerms;
}

/**
 * Builds a PostgreSQL `ORDER BY` expression ranking rows by trigram word similarity (descending).
 * Best used on bounded non-cursor lists (e.g., categories).
 */
export function buildFuzzyRelevanceScoreSql(targetSql: SQL, query: string): SQL {
  const normalized = query.trim().replace(/\s+/g, ' ');
  return sql`extensions.word_similarity(${normalized}, ${targetSql})`;
}

function buildTrigrams(input: string): Set<string> {
  const padded = `  ${input} `;
  const grams = new Set<string>();
  for (let i = 0; i <= padded.length - 3; i += 1) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

function trigramDiceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const gramsA = buildTrigrams(a);
  const gramsB = buildTrigrams(b);
  let intersection = 0;
  for (const g of gramsA) {
    if (gramsB.has(g)) {
      intersection += 1;
    }
  }
  return (2 * intersection) / (gramsA.size + gramsB.size);
}

/**
 * Lightweight in-memory fuzzy matcher mirroring PostgreSQL `ILIKE` + `word_similarity`
 * for deterministic unit/HTTP tests in `in-memory-repos.ts`.
 */
export function matchesFuzzyInMemory(
  fields: readonly (string | null | undefined)[],
  rawQuery: string,
  minSimilarity: number = DEFAULT_FUZZY_SIMILARITY,
): boolean {
  const terms = tokenizeSearchQuery(rawQuery.toLowerCase());
  if (terms.length === 0) {
    return true;
  }

  const haystack = fields
    .filter((f): f is string => typeof f === 'string' && f.length > 0)
    .join(' ')
    .toLowerCase();

  if (haystack.length === 0) {
    return false;
  }

  const haystackWords = haystack.split(/[^a-z0-9]+/).filter((w) => w.length > 0);

  return terms.every((term) => {
    if (haystack.includes(term)) {
      return true;
    }
    if (!isFuzzyEligibleTerm(term)) {
      return false;
    }
    return haystackWords.some((word) => trigramDiceSimilarity(term, word) >= minSimilarity);
  });
}
