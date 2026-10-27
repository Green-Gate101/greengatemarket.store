/**
 * Shared image responder for /api/images/*: decodes a stored base64 data URL
 * into binary, or redirects when the image already lives in object storage
 * (https URL — see src/lib/storage.ts). Edge-cached for a day; browsers keep
 * it for an hour, so a moderated listing's photo stops serving quickly.
 */
import { loadSharp } from '@/lib/sharp-loader';

const ALLOWED = /^data:(image\/(?:jpeg|png|webp|gif|avif));base64,([A-Za-z0-9+/=\s]+)$/;
const CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';

export function imageResponse(stored: string): Response {
  if (/^https:\/\//i.test(stored)) return Response.redirect(stored, 308);
  const match = ALLOWED.exec(stored);
  if (!match) return new Response('Not found', { status: 404 });
  const bytes = Buffer.from(match[2], 'base64');
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': match[1],
      'Content-Length': String(bytes.length),
      'Cache-Control': CACHE,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Card and thumbnail sizes (a fixed few, so each is made once and edge-cached). */
const WIDTHS = [160, 320, 640, 960];

/** `?w=` → the smallest offered width that covers it; none (or wider) → the original. */
export function requestedWidth(req: Request): number | null {
  const w = Number(new URL(req.url).searchParams.get('w'));
  if (!Number.isFinite(w) || w <= 0) return null;
  return WIDTHS.find((x) => x >= w) ?? null;
}

/**
 * The photo at a smaller width for cards, carts and thumbnails — a full-size
 * photo is 3–5× the bytes a small slot needs, on every visitor's data bundle.
 * Never enlarged; transparent parts go white; any failure serves the original.
 */
export async function sizedImageResponse(stored: string, width: number | null): Promise<Response> {
  const match = width ? ALLOWED.exec(stored) : null;
  if (!width || !match || match[1] === 'image/gif') return imageResponse(stored);
  try {
    const sharp = await loadSharp();
    const out = await sharp(Buffer.from(match[2], 'base64'))
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    return new Response(new Uint8Array(out), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(out.length),
        'Cache-Control': CACHE,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    console.error('image resize failed, serving the original:', e instanceof Error ? e.message : e);
    return imageResponse(stored);
  }
}
