/**
 * Shared image responder for /api/images/*: decodes a stored base64 data URL
 * into binary, or redirects when the image already lives in object storage
 * (https URL — see src/lib/storage.ts). Edge-cached for a day; browsers keep
 * it for an hour, so a moderated listing's photo stops serving quickly.
 */
const ALLOWED = /^data:(image\/(?:jpeg|png|webp|gif|avif));base64,([A-Za-z0-9+/=\s]+)$/;

export function imageResponse(stored: string): Response {
  if (/^https:\/\//i.test(stored)) return Response.redirect(stored, 308);
  const match = ALLOWED.exec(stored);
  if (!match) return new Response('Not found', { status: 404 });
  const bytes = Buffer.from(match[2], 'base64');
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': match[1],
      'Content-Length': String(bytes.length),
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
