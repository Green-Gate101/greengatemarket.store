import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { storeCanSell } from '@/lib/subscription';
import { firstPhotos } from '@/lib/item-photos';
import { sweepPendingBookings } from '@/lib/courier-booking';

export const dynamic = 'force-dynamic';

/** Orders for the signed-in seller's store. Seller data is strictly isolated (spec #12/#71). */
export async function GET() {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const store = await db.store.findUnique({ where: { userId: session.user.id } });
    if (!store) return Response.json({ orders: [] });

    const orders = await db.order.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        items: {
          where: { storeId: store.id },
          select: { id: true, productId: true, name: true, variantLabel: true, quantity: true, unitPriceCents: true, product: { select: { slug: true, status: true } } },
        },
      },
    });
    // Photos by address for live products (up to 200 orders used to carry a
    // full inline photo per item); items no longer on sale keep theirs inline.
    const canSell = storeCanSell(store);
    const photos = await firstPhotos(orders.flatMap((o) => o.items.map((i) => ({ id: i.productId, live: canSell && i.product.status === 'approved' }))));
    // Passive courier retry: a seller opening their dashboard re-attempts any
    // courier bookings that failed earlier (e.g. empty TCG wallet) — paid
    // orders get their waybill without anyone filing a support ticket.
    void sweepPendingBookings({ storeId: store.id, limit: 3 }).catch(() => undefined);
    return Response.json({
      orders: orders.map((o) => ({
        ...o,
        items: o.items.map((i) => ({ ...i, image: photos.get(i.productId) ?? null, product: undefined })),
      })),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('seller orders error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your orders.' }, { status: 500 });
  }
}
