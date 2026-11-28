import { z } from '@hono/zod-openapi';
import { env } from '@/config/env.ts';

const DEV_TEST_ALLOWED_IMAGE_HOSTS = new Set([
  'placehold.co',
  'cdn.tsuzumi.test',
  'example.supabase.co',
]);

const ALLOWED_VIDEO_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

export interface AssetOriginPolicy {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly supabaseUrl?: string;
  readonly bucket: string;
}

function defaultPolicy(): AssetOriginPolicy {
  return {
    nodeEnv: env.NODE_ENV,
    ...(env.SUPABASE_URL !== undefined ? { supabaseUrl: env.SUPABASE_URL } : {}),
    bucket: env.SUPABASE_STORAGE_BUCKET,
  };
}

export function buildStoragePublicPrefix(supabaseUrl: string, bucket: string): string {
  const normalizedBase = supabaseUrl.replace(/\/+$/, '');
  return `${normalizedBase}/storage/v1/object/public/${encodeURIComponent(bucket)}/`;
}

function hasPathTraversal(rawPath: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  const segments = decoded.split('/');
  return segments.some((seg) => seg === '..' || seg === '.' || seg.includes('\\'));
}

/**
 * Validates that an image URL belongs to our configured Supabase Storage public bucket.
 * In `development` and `test`, explicit test/placeholder hosts (`placehold.co`, `*.test`)
 * are also permitted so local Postman & automated tests run without external network setup.
 */
export function isAllowedAssetImageUrl(
  rawUrl: string,
  policy: AssetOriginPolicy = defaultPolicy(),
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    if (
      policy.nodeEnv !== 'production' &&
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  }

  const bucketPathPrefix = `/storage/v1/object/public/${encodeURIComponent(policy.bucket)}/`;

  if (policy.supabaseUrl !== undefined) {
    const supabaseOrigin = new URL(policy.supabaseUrl).origin;
    if (
      parsed.origin === supabaseOrigin &&
      parsed.pathname.startsWith(bucketPathPrefix) &&
      parsed.pathname.length > bucketPathPrefix.length
    ) {
      const objectPath = parsed.pathname.slice(bucketPathPrefix.length);
      if (objectPath.length > 0 && !hasPathTraversal(objectPath)) {
        return true;
      }
      return false;
    }
  }

  if (policy.nodeEnv !== 'production') {
    if (DEV_TEST_ALLOWED_IMAGE_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith('.test')) {
      return true;
    }
    if (
      parsed.pathname.startsWith(bucketPathPrefix) &&
      parsed.pathname.length > bucketPathPrefix.length
    ) {
      const objectPath = parsed.pathname.slice(bucketPathPrefix.length);
      return objectPath.length > 0 && !hasPathTraversal(objectPath);
    }
  }

  return false;
}

/**
 * Validates that a product video URL is either a YouTube link or hosted in our Storage bucket.
 */
export function isAllowedAssetVideoUrl(
  rawUrl: string,
  policy: AssetOriginPolicy = defaultPolicy(),
): boolean {
  if (isAllowedAssetImageUrl(rawUrl, policy)) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  return (
    parsed.protocol === 'https:' &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    ALLOWED_VIDEO_HOSTS.has(parsed.hostname)
  );
}

/**
 * Extracts all Storage `object_path` strings referenced either directly or inside Markdown text.
 */
export function extractReferencedObjectPaths(
  textsAndUrls: readonly (string | null | undefined)[],
  bucket: string = env.SUPABASE_STORAGE_BUCKET,
  origin: string | undefined = env.SUPABASE_URL,
): Set<string> {
  const marker = `/storage/v1/object/public/${encodeURIComponent(bucket)}/`;
  const expectedOrigin = origin !== undefined ? new URL(origin).origin : undefined;
  const found = new Set<string>();
  const urlPattern = /https?:\/\/[^\s)"'<>]+/g;

  for (const entry of textsAndUrls) {
    if (!entry) continue;
    const matches = entry.match(urlPattern) ?? [];
    for (const rawMatch of matches) {
      const candidate = rawMatch.replace(/[.,;:!?`\]]+$/, '');
      if (!URL.canParse(candidate)) continue;
      const parsed = new URL(candidate);
      if (expectedOrigin !== undefined && parsed.origin !== expectedOrigin) continue;
      if (parsed.pathname.startsWith(marker) && parsed.pathname.length > marker.length) {
        const rawPath = parsed.pathname.slice(marker.length);
        if (rawPath.length > 0 && !hasPathTraversal(rawPath)) {
          try {
            found.add(decodeURIComponent(rawPath));
          } catch {
            /* Ignore malformed URLs in prose without aborting cleanup. */
          }
        }
      }
    }
  }

  return found;
}

export const AssetImageUrlSchema = z.url().refine((val) => isAllowedAssetImageUrl(val), {
  message: 'Image URL must belong to the configured public Supabase Storage bucket',
});

export const AssetVideoUrlSchema = z.url().refine((val) => isAllowedAssetVideoUrl(val), {
  message: 'Video URL must be a YouTube link or belong to the configured Storage bucket',
});

export const CanonicalUrlSchema = z
  .url()
  .max(2_048)
  .refine(
    (raw) => {
      try {
        const parsed = new URL(raw);
        if (parsed.username.length > 0 || parsed.password.length > 0) return false;
        if (parsed.protocol === 'https:') return true;
        return (
          env.NODE_ENV !== 'production' &&
          parsed.protocol === 'http:' &&
          (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
        );
      } catch {
        return false;
      }
    },
    { message: 'Canonical URL must use https:// without embedded credentials' },
  );
