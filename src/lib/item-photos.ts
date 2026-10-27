import { db } from '@/lib/db';

/**
 * First photo of each product for lists (orders, wishlists). A product that is
 * live — approved, in a store that may sell — gets the address of its
 * edge-cached image file (`/api/images/<id>`), a few bytes in the answer
 * instead of ~200 KB of inline base64. Only products that are no longer on
 * sale (whose image route answers 404) still carry the photo inline, so old
 * orders keep their pictures.
 */
export async function firstPhotos(products: { id: string; live: boolean }[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(products.map((p) => p.id))];
  if (ids.length === 0) return out;
  const live = new Set(products.filter((p) => p.live).map((p) => p.id));
  const images = await db.productImage.findMany({
    where: { productId: { in: ids } },
    orderBy: [{ productId: 'asc' }, { position: 'asc' }],
    select: { id: true, productId: true },
  });
  const first = new Map<string, string>();
  for (const img of images) if (!first.has(img.productId)) first.set(img.productId, img.id);
  const inlineIds: string[] = [];
  for (const id of ids) {
    const imageId = first.get(id);
    if (!imageId) out.set(id, null);
    else if (live.has(id)) out.set(id, `/api/images/${imageId}`);
    else inlineIds.push(imageId);
  }
  if (inlineIds.length > 0) {
    const inline = await db.productImage.findMany({ where: { id: { in: inlineIds } }, select: { productId: true, dataUrl: true } });
    for (const img of inline) out.set(img.productId, img.dataUrl);
  }
  return out;
}
