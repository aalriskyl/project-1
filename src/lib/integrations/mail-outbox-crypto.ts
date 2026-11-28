import { z } from 'zod';
import type { InquiryEmailInput, PasswordResetEmailInput } from '@/lib/integrations/mailer.ts';

const PasswordResetPayloadSchema = z.object({
  to: z.email(),
  displayName: z.string(),
  resetUrl: z.url(),
  expiresInMinutes: z.number().positive(),
});

const InquiryPayloadSchema = z.object({
  to: z.email(),
  replyTo: z.email(),
  subject: z.string().min(1),
  text: z.string().min(1),
});

const PASSWORD_RESET_AAD = 'password-reset:v1';
const INQUIRY_AAD = 'inquiry:v1';

async function importKey(hex: string): Promise<CryptoKey> {
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error('Invalid mail outbox encryption key');
  return crypto.subtle.importKey('raw', Buffer.from(hex, 'hex'), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function seal(input: unknown, aad: string, version: string, hexKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    await importKey(hexKey),
    new TextEncoder().encode(JSON.stringify(input)),
  );
  return `${version}.${Buffer.from(iv).toString('base64url')}.${Buffer.from(encrypted).toString('base64url')}`;
}

async function unseal(
  payload: string,
  aad: string,
  version: string,
  hexKey: string,
): Promise<unknown> {
  const [foundVersion, iv, ciphertext, extra] = payload.split('.');
  if (foundVersion !== version || !iv || !ciphertext || extra !== undefined)
    throw new Error('Invalid encrypted mail payload');
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Buffer.from(iv, 'base64url'),
      additionalData: new TextEncoder().encode(aad),
    },
    await importKey(hexKey),
    Buffer.from(ciphertext, 'base64url'),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export async function encryptMail(input: PasswordResetEmailInput, hexKey: string): Promise<string> {
  return seal(input, PASSWORD_RESET_AAD, 'v1', hexKey);
}

export async function decryptMail(
  payload: string,
  hexKey: string,
): Promise<PasswordResetEmailInput> {
  return PasswordResetPayloadSchema.parse(await unseal(payload, PASSWORD_RESET_AAD, 'v1', hexKey));
}

export async function encryptInquiryMail(
  input: InquiryEmailInput,
  hexKey: string,
): Promise<string> {
  return seal(input, INQUIRY_AAD, 'v2', hexKey);
}

export type OutboxMessage =
  | { readonly kind: 'password-reset'; readonly input: PasswordResetEmailInput }
  | { readonly kind: 'inquiry'; readonly input: InquiryEmailInput };

/** Decrypts either legacy password-reset jobs or RFQ notification jobs. */
export async function decryptOutboxMail(payload: string, hexKey: string): Promise<OutboxMessage> {
  const version = payload.split('.')[0];
  if (version === 'v1') {
    return { kind: 'password-reset', input: await decryptMail(payload, hexKey) };
  }
  if (version === 'v2') {
    return {
      kind: 'inquiry',
      input: InquiryPayloadSchema.parse(await unseal(payload, INQUIRY_AAD, 'v2', hexKey)),
    };
  }
  throw new Error('Unknown encrypted mail payload version');
}
