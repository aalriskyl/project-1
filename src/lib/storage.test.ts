import { describe, expect, test } from 'bun:test';
import { createSupabaseStorageProvider, matchesImageSignature } from '@/lib/storage.ts';
import { extractReferencedObjectPaths, isAllowedAssetImageUrl } from '@/lib/asset-url.ts';

function providerWith(handler: (request: Request) => Response | Promise<Response>) {
  const mockFetch: typeof fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(handler(new Request(input, init))),
    { preconnect: fetch.preconnect },
  );
  return createSupabaseStorageProvider({
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'test-service-role-key',
    bucket: 'public-assets',
    fetch: mockFetch,
  });
}
describe('Storage boundary validation', () => {
  test('checks bucket restrictions before issuing an upload credential', async () => {
    const calls: string[] = [];
    const provider = providerWith((req) => {
      calls.push(req.url);
      if (req.url.includes('/bucket/'))
        return Response.json({
          public: true,
          file_size_limit: 10485760,
          allowed_mime_types: ['image/png'],
        });
      expect(req.method).toBe('POST');
      return Response.json({
        url: '/object/upload/sign/public-assets/products/test.png?token=test-token',
      });
    });
    const signed = await provider.createSignedImageUpload({
      folder: 'products',
      contentType: 'image/png',
      contentLengthBytes: 48,
    });
    expect(calls).toHaveLength(2);
    expect(signed.uploadUrl).toBe(
      'https://example.supabase.co/storage/v1/object/upload/sign/public-assets/products/test.png?token=test-token',
    );
    expect(signed.token).toBe('test-token');
  });
  test('refuses signing when the bucket lacks enforced MIME or size restrictions', async () => {
    for (const config of [
      { public: true, file_size_limit: null, allowed_mime_types: ['image/png'] },
      { public: true, file_size_limit: 1024, allowed_mime_types: null },
      { public: true, file_size_limit: 1024, allowed_mime_types: ['image/*'] },
      { public: false, file_size_limit: 1024, allowed_mime_types: ['image/png'] },
    ]) {
      const provider = providerWith(() => Response.json(config));
      await expect(
        provider.createSignedImageUpload({
          folder: 'products',
          contentType: 'image/png',
          contentLengthBytes: 10,
        }),
      ).rejects.toMatchObject({ code: 'STORAGE_BUCKET_UNSAFE' });
    }
  });
  test('verifies actual bytes and rejects absent, oversized, forged and changed uploads', async () => {
    const png = new Uint8Array(48);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    for (const mode of ['valid', 'missing', 'size', 'mime', 'signature', 'etag', 'ignored-range']) {
      const provider = providerWith((req) => {
        const headers = {
          'content-type': mode === 'mime' ? 'text/html' : 'image/png',
          'content-length': mode === 'size' ? '10485761' : '48',
          etag: 'v1',
        };
        if (req.method === 'HEAD')
          return new Response(null, { status: mode === 'missing' ? 404 : 200, headers });
        return new Response(mode === 'signature' ? new Uint8Array(48) : png, {
          status: mode === 'ignored-range' ? 200 : 206,
          headers: { ...headers, etag: mode === 'etag' ? 'v2' : 'v1' },
        });
      });
      const verification = provider.verifyImageUpload(
        'public-assets',
        'products/test.png',
        'image/png',
        48,
      );
      if (mode === 'valid') await verification;
      else await expect(verification).rejects.toThrow();
    }
  });
  test('recognizes supported signatures and rejects markup with an image extension', () => {
    expect(
      matchesImageSignature(new TextEncoder().encode('<svg onload=alert(1)>'), 'image/png'),
    ).toBe(false);
    expect(matchesImageSignature(new Uint8Array([255, 216, 255]), 'image/jpeg')).toBe(true);
    expect(matchesImageSignature(new TextEncoder().encode('RIFF0000WEBP'), 'image/webp')).toBe(
      true,
    );
    const encoder = new TextEncoder();
    const avif = new Uint8Array(24);
    avif.set([0, 0, 0, 24], 0); // ftyp box size
    avif.set(encoder.encode('ftypavif'), 4);
    avif.set(encoder.encode('mif1'), 16);
    expect(matchesImageSignature(avif, 'image/avif')).toBe(true);

    // An `avif` literal outside the declared ftyp box must not pass as AVIF.
    const forgedAvif = new Uint8Array(24);
    forgedAvif.set([0, 0, 0, 16], 0);
    forgedAvif.set(encoder.encode('ftypisom'), 4);
    forgedAvif.set(encoder.encode('avif'), 16);
    expect(matchesImageSignature(forgedAvif, 'image/avif')).toBe(false);
  });
  test('ignores malformed prose URLs and rejects bucket traversal', () => {
    const urls = [
      'https://%/bad',
      'https://example.supabase.co/storage/v1/object/public/public-assets/products/bad%zz.png',
      'https://example.supabase.co/storage/v1/object/public/public-assets/products/good.png',
    ];
    expect([...extractReferencedObjectPaths(urls)]).toEqual(['products/good.png']);
    expect(
      isAllowedAssetImageUrl(
        'https://example.supabase.co/storage/v1/object/public/public-assets/../private/file.png',
        {
          nodeEnv: 'production',
          supabaseUrl: 'https://example.supabase.co',
          bucket: 'public-assets',
        },
      ),
    ).toBe(false);
  });
});
