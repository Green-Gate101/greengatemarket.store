import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { payfastEnabled } from '@/lib/payfast';

export const dynamic = 'force-dynamic';

/** Order detail with the full status timeline. Access: buyer, seller of the store, or admin. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await ctx.params;

    const order = await db.order.findUnique({
      where: id.startsWith('GG-') ? { number: id } : { id },
      include: {
        items: {
          select: { id: true, productId: true, name: true, variantLabel: true, quantity: true, unitPriceCents: true, product: { select: { slug: true, images: { take: 1, orderBy: { position: 'asc' }, select: { dataUrl: true } } } } },
        },
        events: { orderBy: { createdAt: 'asc' } },
        store: { select: { id: true, slug: true, name: true, location: true, payoutProvider: true, payoutLink: true, payoutNote: true } },
      },
    });
    if (!order) return Response.json({ error: 'Order not found.' }, { status: 404 });

    const isBuyer = order.buyerId === session.user.id;
    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true } });
    const isSeller = store && order.storeId === store.id;
    const isAdmin = session.user.role === 'ADMIN';
    if (!isBuyer && !isSeller && !isAdmin) {
      return Response.json({ error: 'You do not have access to this order.' }, { status: 403 });
    }

    return Response.json({
      order: {
        ...order,
        items: order.items.map((i) => ({ ...i, image: i.product.images[0]?.dataUrl ?? null, product: undefined })),
      },
      payments: { payfast: payfastEnabled() },
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('order detail error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load the order.' }, { status: 500 });
  }
}
