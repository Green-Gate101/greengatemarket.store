import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { payfastEnabled } from '@/lib/payfast';
import { ggpayAcceptsCards } from '@/lib/ggpay';
import { publicPaymentStore, STORE_PAYMENT_SELECT } from '@/lib/order-payment-options';

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
        store: {
          // Readiness computed server-side; secrets/bank columns mapped out.
          select: { id: true, slug: true, name: true, location: true, ...STORE_PAYMENT_SELECT },
        },
      },
    });
    if (!order) return Response.json({ error: 'Order not found.' }, { status: 404 });

    const isBuyer = order.buyerId === session.user.id;
    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true } });
    const isSeller = store && order.storeId === store.id;
    // Role re-read from the database — the session token is not authoritative.
    const isAdmin = !isBuyer && !isSeller
      && (await db.user.findUnique({ where: { id: session.user.id }, select: { role: true } }))?.role === 'ADMIN';
    if (!isBuyer && !isSeller && !isAdmin) {
      return Response.json({ error: 'You do not have access to this order.' }, { status: 403 });
    }

    return Response.json({
      order: {
        ...order,
        // EFT bank details go to the order's BUYER only (while unpaid).
        store: publicPaymentStore(order.store, order, { showEft: isBuyer }),
        items: order.items.map((i) => ({ ...i, image: i.product.images[0]?.dataUrl ?? null, product: undefined })),
      },
      payments: { payfast: payfastEnabled(), ggpay: ggpayAcceptsCards() },
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('order detail error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load the order.' }, { status: 500 });
  }
}
