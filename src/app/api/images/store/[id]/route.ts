import { db } from '@/lib/db';
import { imageResponse } from '../../serve';

/** Store logo (default) or banner (`?kind=banner`) as a real, edge-cached
 *  image file — for link previews and the public store directory/pages
 *  (active stores only). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return new Response('Not found', { status: 404 });
  const banner = new URL(req.url).searchParams.get('kind') === 'banner';
  try {
    const store = await db.store.findUnique({ where: { id }, select: { status: true, logoData: true, bannerData: true } });
    const stored = banner ? store?.bannerData : store?.logoData;
    if (!store || store.status !== 'active' || !stored) return new Response('Not found', { status: 404 });
    return imageResponse(stored);
  } catch (e) {
    console.error('store image error:', e instanceof Error ? e.message : e);
    return new Response('Image unavailable', { status: 500 });
  }
}
