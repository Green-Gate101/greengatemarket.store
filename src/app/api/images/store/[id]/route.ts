import { db } from '@/lib/db';
import { imageResponse } from '../../serve';

/** Store logo as a real image file for /store/<slug> link previews (active stores only). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return new Response('Not found', { status: 404 });
  try {
    const store = await db.store.findUnique({ where: { id }, select: { status: true, logoData: true } });
    if (!store || store.status !== 'active' || !store.logoData) return new Response('Not found', { status: 404 });
    return imageResponse(store.logoData);
  } catch (e) {
    console.error('store logo error:', e instanceof Error ? e.message : e);
    return new Response('Image unavailable', { status: 500 });
  }
}
