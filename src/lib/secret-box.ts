import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Secret box — AES-256-GCM encryption for processor credentials the sellers
 * entrust to the marketplace (currently the Yoco secret key for in-system
 * card payments).
 *
 * Design:
 *  - key derived from NEXTAUTH_SECRET (present in every environment) via
 *    SHA-256 with an app-specific domain tag, so the ciphertext in the
 *    database is useless without the server secret;
 *  - authenticated encryption (GCM tag) — tampered ciphertexts fail closed;
 *  - format: `v1:<iv>:<tag>:<ciphertext>` (all base64url) so a future
 *    version can rotate formats without breaking stored values;
 *  - decryption failure returns null (never throws) — callers then degrade
 *    gracefully (e.g. a rotated NEXTAUTH_SECRET simply means the seller
 *    re-pastes their key; nothing crashes and no secret is half-leaked).
 */

const VERSION = 'v1';

function boxKey(): Buffer {
  const base = process.env.NEXTAUTH_SECRET;
  if (!base && process.env.NODE_ENV === 'production') {
    // Fail closed: seller processor credentials must never be encrypted with
    // a public fallback key. The deploy pipeline always sets NEXTAUTH_SECRET
    // in production, so this only fires on a misconfigured deployment.
    throw new Error('NEXTAUTH_SECRET is required in production');
  }
  return createHash('sha256').update(`gg-secret-box:${base ?? 'greengate-fallback-box-key'}`).digest();
}

/** Encrypt a plaintext secret. Returns null when the input is empty. */
export function encryptSecret(plain: string): string | null {
  const value = plain.trim();
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', boxKey(), iv);
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(':');
}

/** Decrypt a stored secret. Returns null for absent/tampered/unreadable values. */
export function decryptSecret(box: string | null | undefined): string | null {
  if (!box) return null;
  const parts = box.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const enc = Buffer.from(parts[3], 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', boxKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** True when the stored box decrypts to a usable secret. */
export function secretIsSet(box: string | null | undefined): boolean {
  return Boolean(decryptSecret(box));
}
