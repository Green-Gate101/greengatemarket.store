import type { Prisma } from '@prisma/client';

/**
 * Put an order's reserved stock back (checkout decremented it). Used inside
 * the SAME transaction that atomically moves the order to `cancelled`, so
 * stock is restored exactly once per cancellation.
 */
export async function restockOrderItems(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const items = await tx.orderItem.findMany({ where: { orderId }, select: { productId: true, variantId: true, quantity: true } });
  for (const it of items) {
    if (it.variantId) {
      await tx.productVariant.updateMany({ where: { id: it.variantId }, data: { stock: { increment: it.quantity } } });
    } else {
      await tx.product.updateMany({ where: { id: it.productId }, data: { stock: { increment: it.quantity } } });
    }
  }
  // Every caller cancels the order: a discount code it used gets its use back.
  const { releaseDiscountUse } = await import('@/lib/discounts');
  await releaseDiscountUse(tx, orderId);
}
