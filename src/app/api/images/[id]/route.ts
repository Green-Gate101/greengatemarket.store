import { db } from '@/lib/db';
import { imageResponse } from '../serve';

/**
 * Product photo as a real, CDN-cacheable image file (additive). Listings
 * store photos as base64 data URLs, which link-preview bots (WhatsApp,
 * Facebook, X) and image search cannot read — the landing pages' og:image
 * and JSON-LD point here instead. Only photos of APPROVED products in ACTIVE
 * stores are served (the catalogue's visibility rule).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return new Response('Not found', { status: 404 });
  try {
    const image = await db.productImage.findUnique({
      where: { id },
      select: { dataUrl: true, product: { select: { status: true, store: { select: { status: true } } } } },
    });
    if (!image || image.product.status !== 'approved' || image.product.store.status !== 'active') {
      return new Response('Not found', { status: 404 });
    }
    return imageResponse(image.dataUrl);
  } catch (e) {
    console.error('product image error:', e instanceof Error ? e.message : e);
    return new Response('Image unavailable', { status: 500 });
  }
}
