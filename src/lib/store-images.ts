import { guardBrandImage } from './ai-image-guard';
import { loadSharp } from './sharp-loader';

/**
 * Store logo / banner preparation for the seller's store profile.
 *
 * - Real image files only (magic bytes: JPEG, PNG, WebP), at most 8 MB.
 * - AI-generator signatures in the file are refused (brand-image guard — no
 *   "is this a photo?" test, logos are designs).
 * - Transparent areas become WHITE, like every product photo (owner's rule:
 *   store images sit on the same white background as the listings).
 *   Logos: at most 512 px, JPEG q90 without chroma subsampling so coloured
 *   lettering stays crisp. Banners: at most 1600 px wide, JPEG q85. Both
 *   stay small enough for every store row and page.
 */
export const STORE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export type StoreImageResult = { ok: true; dataUrl: string } | { ok: false; error: string };

function sniffImageMime(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export async function prepareStoreImage(file: File, kind: 'logo' | 'banner'): Promise<StoreImageResult> {
  const what = kind === 'logo' ? 'logo' : 'banner';
  if (file.size === 0) return { ok: false, error: `The ${what} file is empty.` };
  if (file.size > STORE_IMAGE_MAX_BYTES) return { ok: false, error: `The ${what} is too large — use an image under 8 MB.` };
  const buf = Buffer.from(await file.arrayBuffer());
  if (!sniffImageMime(buf)) return { ok: false, error: `The ${what} must be a JPEG, PNG or WebP image.` };
  const guard = await guardBrandImage(buf);
  if (!guard.allowed) return { ok: false, error: `This ${what} was refused: ${guard.reason ?? 'it looks AI-generated'}` };
  try {
    const sharp = await loadSharp();
    const out = kind === 'logo'
      ? await sharp(buf).rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
      : await sharp(buf).rotate().resize({ width: 1600, height: 900, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
    return { ok: true, dataUrl: `data:image/jpeg;base64,${out.toString('base64')}` };
  } catch (e) {
    console.error(`store ${what} processing failed:`, e instanceof Error ? e.message : e);
    return { ok: false, error: `The ${what} could not be read — try another image file.` };
  }
}

/**
 * Short, URL-safe fingerprint of a stored image so its public address
 * changes when the image changes (store images are edge-cached for a day —
 * without this a new logo kept showing the old one).
 */
export function storeImageVersion(stored: string): string {
  // Length + samples from the middle and the end: a JPEG's final bytes are
  // nearly identical for every image, the middle is not.
  const n = stored.length;
  const at = (f: number) => stored.slice(Math.floor(n * f), Math.floor(n * f) + 8);
  return `${n.toString(36)}${(at(0.5) + at(0.75) + stored.slice(-6)).replace(/[^A-Za-z0-9]/g, '')}`;
}
