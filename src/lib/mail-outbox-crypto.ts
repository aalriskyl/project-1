import { z } from 'zod';
import type { PasswordResetEmailInput } from '@/lib/mailer.ts';

const PayloadSchema = z.object({
  to: z.email(),
  displayName: z.string(),
  resetUrl: z.url(),
  expiresInMinutes: z.number().positive(),
});
async function importKey(hex: string): Promise<CryptoKey> {
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error('Invalid mail outbox encryption key');
  return crypto.subtle.importKey('raw', Buffer.from(hex, 'hex'), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}
export async function encryptMail(input: PasswordResetEmailInput, hexKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('password-reset:v1') },
    await importKey(hexKey),
    new TextEncoder().encode(JSON.stringify(input)),
  );
  return `v1.${Buffer.from(iv).toString('base64url')}.${Buffer.from(encrypted).toString('base64url')}`;
}
export async function decryptMail(
  payload: string,
  hexKey: string,
): Promise<PasswordResetEmailInput> {
  const [version, iv, ciphertext, extra] = payload.split('.');
  if (version !== 'v1' || !iv || !ciphertext || extra !== undefined)
    throw new Error('Invalid encrypted mail payload');
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Buffer.from(iv, 'base64url'),
      additionalData: new TextEncoder().encode('password-reset:v1'),
    },
    await importKey(hexKey),
    Buffer.from(ciphertext, 'base64url'),
  );
  return PayloadSchema.parse(JSON.parse(new TextDecoder().decode(decrypted)));
}
