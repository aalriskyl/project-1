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

  if (policy.supabaseUrl !== undefined) {
    const prefix = buildStoragePublicPrefix(policy.supabaseUrl, policy.bucket);
    if (rawUrl.startsWith(prefix) && rawUrl.length > prefix.length) {
      return true;
    }
  }

  if (policy.nodeEnv !== 'production') {
    if (
      DEV_TEST_ALLOWED_IMAGE_HOSTS.has(parsed.hostname) ||
      parsed.hostname.endsWith('.test') ||
      parsed.pathname.startsWith(`/storage/v1/object/public/${encodeURIComponent(policy.bucket)}/`)
    ) {
      return true;
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

  return parsed.protocol === 'https:' && ALLOWED_VIDEO_HOSTS.has(parsed.hostname);
}

/**
 * Extracts all Storage `object_path` strings referenced either directly or inside Markdown text.
 */
export function extractReferencedObjectPaths(
  textsAndUrls: readonly (string | null | undefined)[],
  bucket: string = env.SUPABASE_STORAGE_BUCKET,
): Set<string> {
  const marker = `/storage/v1/object/public/${encodeURIComponent(bucket)}/`;
  const found = new Set<string>();
  const urlPattern = /https?:\/\/[^\s)"'<>]+/g;

  for (const entry of textsAndUrls) {
    if (!entry) continue;
    const matches = entry.match(urlPattern) ?? [];
    for (const candidate of matches) {
      const idx = candidate.indexOf(marker);
      if (idx !== -1) {
        const rawPath = candidate.slice(idx + marker.length).split(/[?#]/)[0];
        if (rawPath !== undefined && rawPath.length > 0) {
          found.add(decodeURIComponent(rawPath));
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
