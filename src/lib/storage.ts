import { z } from 'zod';
import { env } from '@/config/env.ts';
import { BadRequestError, ConflictError, ServiceUnavailableError } from '@/lib/errors.ts';
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
  verifyImageUpload(
    bucket: string,
    objectPath: string,
    contentType: string,
    expectedBytes: number | null,
  ): Promise<void>;
  deleteObjects(bucket: string, objectPaths: readonly string[]): Promise<void>;
}

export interface SupabaseStorageConfig {
  readonly supabaseUrl?: string;
  readonly serviceRoleKey?: string;
  readonly bucket: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const STORAGE_TIMEOUT_MS = 8_000;
const SUPABASE_SIGNED_UPLOAD_TTL_SEC = 7_200; // Supabase Storage default 2h validity

export function matchesImageSignature(bytes: Uint8Array, type: string): boolean {
  const at = (offset: number, text: string): boolean =>
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png')
    return [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
  if (type === 'image/webp') return at(0, 'RIFF') && at(8, 'WEBP');
  if (type === 'image/avif') {
    if (!at(4, 'ftyp')) return false;
    // Validate brands inside the declared ftyp box; an `avif` literal elsewhere in
    // an ISO-BMFF file must not pass as an AVIF image.
    const boxSize =
      ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    if (boxSize < 16 || boxSize > bytes.length) return false;
    const brands: string[] = [];
    for (let i = 8; i + 4 <= boxSize; i += 4) {
      brands.push(
        String.fromCharCode(bytes[i] ?? 0, bytes[i + 1] ?? 0, bytes[i + 2] ?? 0, bytes[i + 3] ?? 0),
      );
    }
    return brands.some((brand) => brand === 'avif' || brand === 'avis');
  }
  return false;
}

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
  const request = config.fetch ?? fetch;
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
      const signal = AbortSignal.timeout(config.timeoutMs ?? STORAGE_TIMEOUT_MS);
      try {
        const bucketResponse = await request(
          `${baseUrl}/storage/v1/bucket/${encodeURIComponent(config.bucket)}`,
          {
            headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey },
            signal,
            redirect: 'error',
          },
        );
        if (!bucketResponse.ok) throw new Error('Bucket unavailable');
        const bucket = z
          .object({
            public: z.boolean(),
            file_size_limit: z.coerce.number().int().positive(),
            allowed_mime_types: z.array(z.string()).min(1),
          })
          .parse(await bucketResponse.json());
        if (
          !bucket.public ||
          bucket.file_size_limit > MAX_IMAGE_UPLOAD_BYTES ||
          !bucket.allowed_mime_types.every((type) =>
            ALLOWED_IMAGE_MIME_TYPES.some((allowed) => allowed === type),
          ) ||
          !bucket.allowed_mime_types.includes(input.contentType)
        )
          throw new Error('Unsafe bucket restrictions');
      } catch {
        throw new ServiceUnavailableError(
          'Storage bucket must be public with a maximum 10 MiB limit and an explicit supported image MIME allowlist',
          'STORAGE_BUCKET_UNSAFE',
        );
      }
      const objectPath = buildSafeObjectPath(input.folder, input.contentType);
      const signEndpoint = `${baseUrl}/storage/v1/object/upload/sign/${encodeURIComponent(config.bucket)}/${objectPath}`;

      let response: Response;
      try {
        response = await request(signEndpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            'Content-Type': 'application/json',
          },
          body: '{}',
          signal,
          redirect: 'error',
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

      const parsed = SupabaseSignUploadResponseSchema.safeParse(
        await response.json().catch(() => null),
      );
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
      if (parsedUploadUrl.origin !== new URL(baseUrl).origin)
        throw new ServiceUnavailableError(
          'Unexpected Storage upload origin',
          'STORAGE_SIGN_FAILED',
        );
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

    async verifyImageUpload(bucket, objectPath, contentType, expectedBytes): Promise<void> {
      const { baseUrl, serviceRoleKey } = requireCredentials();
      const url = `${baseUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
      const signal = AbortSignal.timeout(config.timeoutMs ?? STORAGE_TIMEOUT_MS);
      const headers = { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey };
      try {
        const head = await request(url, {
          method: 'HEAD',
          headers,
          signal,
          redirect: 'error',
          cache: 'no-store',
        });
        if (head.status === 404)
          throw new ConflictError('Upload the file before completing it', 'MEDIA_UPLOAD_MISSING');
        if (!head.ok) throw new Error('Storage HEAD failed');
        const size = Number(head.headers.get('content-length'));
        const actualType = head.headers.get('content-type')?.split(';')[0]?.trim();
        if (
          !Number.isSafeInteger(size) ||
          size < 1 ||
          size > MAX_IMAGE_UPLOAD_BYTES ||
          (expectedBytes !== null && expectedBytes !== size) ||
          actualType !== contentType
        ) {
          throw new ConflictError(
            'Stored file size or MIME type differs from the requested upload',
            'MEDIA_UPLOAD_MISMATCH',
          );
        }
        const response = await request(url, {
          headers: { ...headers, Range: 'bytes=0-47' },
          signal,
          redirect: 'error',
          cache: 'no-store',
        });
        if (response.status !== 206 || !response.body) {
          await response.body?.cancel();
          throw new Error('Storage did not honor bounded range');
        }
        if (head.headers.get('etag') !== response.headers.get('etag')) {
          await response.body.cancel();
          throw new ConflictError('File changed during verification', 'MEDIA_UPLOAD_MISMATCH');
        }
        const reader = response.body.getReader();
        const bytes = new Uint8Array(48);
        let offset = 0;
        try {
          while (offset < bytes.length) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const take = chunk.value.subarray(0, bytes.length - offset);
            bytes.set(take, offset);
            offset += take.length;
          }
        } finally {
          await reader.cancel();
        }
        if (!matchesImageSignature(bytes.subarray(0, offset), contentType))
          throw new ConflictError(
            'File signature does not match its image MIME type',
            'MEDIA_UPLOAD_MISMATCH',
          );
      } catch (err) {
        if (err instanceof ConflictError) throw err;
        throw new ServiceUnavailableError('Unable to verify uploaded image', 'STORAGE_UNAVAILABLE');
      }
    },

    async deleteObjects(bucket: string, objectPaths: readonly string[]): Promise<void> {
      if (objectPaths.length === 0) {
        return;
      }
      const { baseUrl, serviceRoleKey } = requireCredentials();
      const deleteEndpoint = `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`;

      let response: Response;
      try {
        response = await request(deleteEndpoint, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prefixes: objectPaths }),
          signal: AbortSignal.timeout(config.timeoutMs ?? STORAGE_TIMEOUT_MS),
          redirect: 'error',
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
