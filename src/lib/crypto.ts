const DEFAULT_TOKEN_BYTES = 32;

/**
 * Generates a high-entropy URL-safe opaque token (e.g. for refresh tokens).
 */
export function generateOpaqueToken(byteLength: number = DEFAULT_TOKEN_BYTES): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Computes a deterministic SHA-256 hex digest using Bun's native CryptoHasher.
 * Used so raw refresh tokens are never persisted in the database.
 */
export function hashTokenSha256(rawToken: string): string {
  return new Bun.CryptoHasher('sha256').update(rawToken).digest('hex');
}
