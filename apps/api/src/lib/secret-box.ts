import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env';

/**
 * Symmetric encryption for secrets we must store and later read back in
 * plaintext (OAuth refresh tokens, access tokens). AES-256-GCM with a key
 * derived from JWT_SECRET — distinct from the platform-settings key so the two
 * domains never share key material. Format: iv.tag.ciphertext, all base64.
 */
const ENC_KEY = createHash('sha256').update(`${env.JWT_SECRET}:secret-box`).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function open(sealed: string): string {
  const [iv, tag, data] = sealed.split('.');
  if (!iv || !tag || !data) throw new Error('Malformed sealed secret');
  const decipher = createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
