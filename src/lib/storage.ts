import { z } from 'zod';
import { env } from '@/config/env.ts';
import { BadRequestError, ServiceUnavailableError } from '@/lib/errors.ts';
import { generateId } from '@/lib/id.ts';

export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export const MEDIA_FOLDERS = ['products', 'categories', 'articles'] as const;
export type MediaFolder = (typeof MEDIA_FOLDERS)[number];

export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MiB

const EXTENSION_BY_MIME: Record<AllowedImageMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

const SupabaseSignUploadResponseSchema = z.object({
  url: z.string().min(1),
  token: z.string().optional(),
});

export interface CreateSignedUploadInput {
  readonly folder: MediaFolder;
  readonly contentType: AllowedImageMimeType;
  readonly contentLengthBytes: number;
}

export interface SignedUploadResult {
  readonly bucket: string;
  readonly objectPath: string;
  readonly uploadUrl: string;
  readonly publicUrl: string;
  readonly token: string | null;
  readonly expiresInSec: number;
  readonly requiredHeaders: {
    readonly 'Content-Type': AllowedImageMimeType;
  };
}

export interface StorageProvider {
  createSignedImageUpload(input: CreateSignedUploadInput): Promise<SignedUploadResult>;
  deleteObjects(bucket: string, objectPaths: readonly string[]): Promise<void>;
}

export interface SupabaseStorageConfig {
  readonly supabaseUrl?: string;
  readonly serviceRoleKey?: string;
  readonly bucket: string;
  readonly timeoutMs?: number;
}

const STORAGE_TIMEOUT_MS = 8_000;
const SUPABASE_SIGNED_UPLOAD_TTL_SEC = 7_200; // Supabase Storage default 2h validity

function buildSafeObjectPath(folder: MediaFolder, contentType: AllowedImageMimeType): string {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = EXTENSION_BY_MIME[contentType];
  // Never interpolate client-provided filenames into storage object paths.
  return `${folder}/${year}/${month}/${generateId()}.${ext}`;
}

export function createSupabaseStorageProvider(
  config: SupabaseStorageConfig = {
    ...(env.SUPABASE_URL !== undefined ? { supabaseUrl: env.SUPABASE_URL } : {}),
    ...(env.SUPABASE_SERVICE_ROLE_KEY !== undefined
      ? { serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }
      : {}),
    bucket: env.SUPABASE_STORAGE_BUCKET,
  },
): StorageProvider {
  function requireCredentials(): { readonly baseUrl: string; readonly serviceRoleKey: string } {
    if (config.supabaseUrl === undefined || config.serviceRoleKey === undefined) {
      throw new ServiceUnavailableError(
        'Supabase Storage credentials (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) are not configured',
        'STORAGE_NOT_CONFIGURED',
      );
    }
    return {
      baseUrl: config.supabaseUrl.replace(/\/+$/, ''),
      serviceRoleKey: config.serviceRoleKey,
    };
  }

  return {
    async createSignedImageUpload(input: CreateSignedUploadInput): Promise<SignedUploadResult> {
      if (input.contentLengthBytes > MAX_IMAGE_UPLOAD_BYTES) {
        throw new BadRequestError(
          `Image size exceeds maximum of ${MAX_IMAGE_UPLOAD_BYTES} bytes`,
          'FILE_TOO_LARGE',
        );
      }

      const { baseUrl, serviceRoleKey } = requireCredentials();
      const objectPath = buildSafeObjectPath(input.folder, input.contentType);
      const signEndpoint = `${baseUrl}/storage/v1/object/upload/sign/${encodeURIComponent(config.bucket)}/${objectPath}`;

      let response: Response;
      try {
        response = await fetch(signEndpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            'Content-Type': 'application/json',
          },
          body: '{}',
          signal: AbortSignal.timeout(config.timeoutMs ?? STORAGE_TIMEOUT_MS),
        });
      } catch {
        throw new ServiceUnavailableError(
          'Failed to reach Supabase Storage service',
          'STORAGE_UNAVAILABLE',
        );
      }

      if (!response.ok) {
        throw new ServiceUnavailableError(
          `Supabase Storage rejected upload URL request (status ${response.status})`,
          'STORAGE_SIGN_FAILED',
        );
      }

      const parsed = SupabaseSignUploadResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new ServiceUnavailableError(
          'Unexpected response from Supabase Storage',
          'STORAGE_SIGN_FAILED',
        );
      }

      const rawUrl = parsed.data.url;
      const uploadUrl = rawUrl.startsWith('http')
        ? rawUrl
        : `${baseUrl}/storage/v1${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;

      const parsedUploadUrl = new URL(uploadUrl);
      const extractedToken = parsed.data.token ?? parsedUploadUrl.searchParams.get('token');
      const publicUrl = `${baseUrl}/storage/v1/object/public/${encodeURIComponent(config.bucket)}/${objectPath}`;

      return {
        bucket: config.bucket,
        objectPath,
        uploadUrl,
        publicUrl,
        token: extractedToken,
        expiresInSec: SUPABASE_SIGNED_UPLOAD_TTL_SEC,
        requiredHeaders: {
          'Content-Type': input.contentType,
        },
      };
    },

    async deleteObjects(bucket: string, objectPaths: readonly string[]): Promise<void> {
      if (objectPaths.length === 0) {
        return;
      }
      const { baseUrl, serviceRoleKey } = requireCredentials();
      const deleteEndpoint = `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`;

      let response: Response;
      try {
        response = await fetch(deleteEndpoint, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prefixes: objectPaths }),
          signal: AbortSignal.timeout(config.timeoutMs ?? STORAGE_TIMEOUT_MS),
        });
      } catch {
        throw new ServiceUnavailableError(
          'Failed to reach Supabase Storage during object deletion',
          'STORAGE_UNAVAILABLE',
        );
      }

      if (!response.ok) {
        throw new ServiceUnavailableError(
          `Supabase Storage rejected batch object deletion (status ${response.status})`,
          'STORAGE_DELETE_FAILED',
        );
      }
    },
  };
}

export const storageProvider: StorageProvider = createSupabaseStorageProvider();
