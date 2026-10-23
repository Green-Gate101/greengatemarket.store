import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'crypto';

/**
 * Password hashing with Node's built-in scrypt (memory-hard KDF).
 * Format: scrypt$<saltHex>$<hashHex> — passwords are never stored or logged.
 */

const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = scryptSync(password, salt, KEYLEN);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 8) issues.push('at least 8 characters');
  if (!/[a-zA-Z]/.test(password)) issues.push('a letter');
  if (!/[0-9]/.test(password)) issues.push('a number');
  return issues;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function orderNumber(): string {
  // 8 chars from a 31-symbol alphabet (~8.5e11 combinations) drawn from the
  // CSPRNG: 6 Math.random() chars collided on the unique column after only
  // ~30k orders. Checkout also retries on the rare collision.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[randomInt(alphabet.length)];
  return `GG-${out}`;
}

export function storeSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'store';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export function productSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'product';
  return `${base}-${randomBytes(4).toString('hex')}`;
}
