import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { bootstrap } from '@/lib/bootstrap';
import { processProductImage } from '@/lib/image-processing';
import { guardImage } from '@/lib/ai-image-guard';
import { indexProduct } from '@/lib/algolia';
import { requireRole, authErrorResponse } from '@/lib/auth';
import { productSlug } from '@/lib/password';
import { audit } from '@/lib/audit';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_IMAGES = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Server-side magic-byte sniffing — client MIME types are never trusted (spec #15). */
function sniffMime(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// ---------------------------------------------------------------------------
// GET — public catalogue with search, filters, sorting, pagination
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    const sp = new URL(req.url).searchParams;
    const q = sp.get('q')?.trim() ?? '';
    const categorySlug = sp.get('category') ?? '';
    const storeSlugParam = sp.get('store') ?? '';
    const brand = sp.get('brand')?.trim() ?? '';
    const minPrice = Number(sp.get('minPrice') ?? '');
    const maxPrice = Number(sp.get('maxPrice') ?? '');
    const inStock = sp.get('inStock') === '1';
    const sort = sp.get('sort') ?? 'newest';
    const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
    const pageSize = Math.min(48, Math.max(1, Number(sp.get('pageSize') ?? 24) || 24));

    const where: Record<string, unknown> = { status: 'approved' };
    if (categorySlug && categorySlug !== 'all') {
      // Category filter covers the parent slug and all of its children.
      const cat = await db.category.findUnique({ where: { slug: categorySlug } });
      if (cat) {
        const children = await db.category.findMany({ where: { parentId: cat.id }, select: { id: true } });
        where.categoryId = { in: [cat.id, ...children.map((c) => c.id)] };
      } else {
        where.categoryId = '__none__';
      }
    }
    if (storeSlugParam) where.store = { slug: storeSlugParam, status: 'active' };
    // Only live stores are shoppable — pending/declined/suspended stores stay
    // out of the catalogue entirely (application review + moderation).
    where.store = { ...((where.store as object) ?? {}), status: 'active' };
    if (brand) where.brand = { contains: brand };
    if (Number.isFinite(minPrice) && minPrice > 0) where.priceCents = { ...(where.priceCents as object ?? {}), gte: Math.round(minPrice * 100) };
    if (Number.isFinite(maxPrice) && maxPrice > 0) where.priceCents = { ...(where.priceCents as object ?? {}), lte: Math.round(maxPrice * 100) };
    if (inStock) where.OR = [{ stock: { gt: 0 } }, { variants: { some: { stock: { gt: 0 }, active: true } } }];

    const orderBy: Record<string, 'asc' | 'desc' | { _count: 'desc' }> =
      sort === 'price_asc' ? { priceCents: 'asc' }
      : sort === 'price_desc' ? { priceCents: 'desc' }
      : sort === 'popular' ? { viewCount: 'desc' }
      : { createdAt: 'desc' };

    // Primary search via Algolia (typo tolerant); DB search is the fallback.
    if (q) {
      const { searchProductIds } = await import('@/lib/algolia');
      const algoliaIds = await searchProductIds(q);
      if (algoliaIds && algoliaIds.length > 0) {
        where.id = { in: algoliaIds };
      } else {
        // Database fallback: every word must match somewhere in the product
        // or its store name. Search clauses live under AND so they never
        // dilute the in-stock OR clause above.
        const words = q.split(/\s+/).filter(Boolean).slice(0, 6);
        const wordClauses = words.map((word) => ({
          OR: [
            { name: { contains: word } },
            { description: { contains: word } },
            { brand: { contains: word } },
            { tags: { contains: word } },
            { store: { name: { contains: word } } },
            { category: { name: { contains: word } } },
          ],
        }));
        if (wordClauses.length > 0) {
          where.AND = [...(Array.isArray(where.AND) ? where.AND : []), ...wordClauses];
        }
      }
    }

    const [total, products] = await Promise.all([
      db.product.count({ where }),
      db.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, slug: true, name: true, priceCents: true, salePriceCents: true, brand: true,
          stock: true, status: true, createdAt: true,
          store: { select: { id: true, slug: true, name: true, location: true } },
          category: { select: { slug: true, name: true } },
          images: { orderBy: { position: 'asc' }, take: 1, select: { dataUrl: true } },
        },
      }),
    ]);

    // Real rating aggregates for this page only (no N+1 on the whole table).
    const ids = products.map((p) => p.id);
    const reviewAgg = ids.length
      ? await db.review.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _avg: { rating: true }, _count: { rating: true } })
      : [];
    const ratingMap = new Map(reviewAgg.map((r) => [r.productId, { avg: r._avg.rating ?? 0, count: r._count.rating }]));

    return Response.json({
      products: products.map((p) => ({
        ...p,
        image: p.images[0]?.dataUrl ?? null,
        images: undefined,
        ratingAvg: Number((ratingMap.get(p.id)?.avg ?? 0).toFixed(2)),
        ratingCount: ratingMap.get(p.id)?.count ?? 0,
      })),
      total,
      page,
      pageSize,
    }, {
      // Public catalogue responses are identical for every visitor, so the CDN
      // (Vercel Edge Network) serves repeat lookups from the edge instead of
      // hitting the database. Short TTL keeps new listings near-instant.
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
      },
    });
  } catch (e) {
    console.error('GET /api/products error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load products. Please try again.' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST — create a product (seller only, images guarded + auto white background)
// ---------------------------------------------------------------------------

interface VariantInput { attributes: Record<string, string>; sku?: string; stock?: number; price?: number | null }

export async function POST(req: NextRequest) {
  try {
    const session = await requireRole('SELLER', 'ADMIN');
    const rl = rateLimit(`product-create:${session.user.id}`, 20, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const store = await db.store.findUnique({ where: { userId: session.user.id } });
    if (!store || store.status !== 'active') {
      return Response.json({ error: 'Create your store before listing products.' }, { status: 403 });
    }

    const form = await req.formData();
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    const categorySlug = String(form.get('category') ?? '').trim();
    const brand = String(form.get('brand') ?? '').trim() || null;
    const condition = String(form.get('condition') ?? 'new');
    const tags = String(form.get('tags') ?? '').trim() || null;
    const price = Number(form.get('price'));
    const salePrice = form.get('salePrice') ? Number(form.get('salePrice')) : null;
    const stock = Number(form.get('stock') ?? 0);
    const weightGrams = Number(form.get('weightGrams') ?? 1000);
    // Declared parcel size in cm — what the seller will physically box the item
    // in. Defaults match the historical 30×25×15 quote parcel so legacy API
    // payloads keep working; the seller form always sends them.
    const lengthCm = Number(form.get('lengthCm') ?? 30);
    const widthCm = Number(form.get('widthCm') ?? 25);
    const heightCm = Number(form.get('heightCm') ?? 15);
    const status = form.get('draft') === '1' ? 'draft' : 'approved';

    // Validation (spec #14)
    const errors: string[] = [];
    if (name.length < 3 || name.length > 140) errors.push('Product name must be 3–140 characters');
    if (description.length < 20) errors.push('Description must be at least 20 characters');
    if (!Number.isFinite(price) || price <= 0) errors.push('Price must be greater than zero');
    if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice <= 0 || salePrice >= price)) {
      errors.push('Sale price must be a positive amount below the normal price');
    }
    if (!Number.isFinite(stock) || stock < 0 || !Number.isInteger(stock)) errors.push('Stock must be a whole number of zero or more');
    if (!Number.isFinite(weightGrams) || weightGrams < 1 || weightGrams > 30000) errors.push('Weight must be between 1 and 30000 grams');
    for (const [label, v] of [['Length', lengthCm], ['Width', widthCm], ['Height', heightCm]] as const) {
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 200) errors.push(`${label} must be a whole number between 1 and 200 cm`);
    }
    if (!['new', 'refurbished', 'pre_loved'].includes(condition)) errors.push('Invalid condition');
    const cat = categorySlug ? await db.category.findUnique({ where: { slug: categorySlug } }) : null;
    if (!cat) errors.push('Choose a valid category');

    // Variants (optional) — real inventory rows, not text
    let variants: VariantInput[] = [];
    const variantsRaw = form.get('variants');
    if (typeof variantsRaw === 'string' && variantsRaw.trim()) {
      try {
        const parsed = JSON.parse(variantsRaw) as VariantInput[];
        if (!Array.isArray(parsed)) throw new Error('not array');
        variants = parsed
          .map((v) => ({
            attributes: v.attributes ?? {},
            sku: String(v.sku ?? '').trim(),
            stock: Math.max(0, Math.floor(Number(v.stock ?? 0)) || 0),
            price: Number.isFinite(Number(v.price)) && Number(v.price) > 0 ? Number(v.price) : null,
          }))
          .filter((v) => Object.keys(v.attributes).length > 0);
        if (variants.length > 50) errors.push('A product can have at most 50 variants');
      } catch {
        errors.push('Variant data is malformed');
      }
    }

    // Images: 1–8, validated by magic bytes, size, AI guard, then auto white background
    const files = form.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length < 1) errors.push('At least one product photo is required');
    if (files.length > MAX_IMAGES) errors.push(`At most ${MAX_IMAGES} photos per product`);

    const buffers: { buffer: Buffer; mime: string }[] = [];
    for (const file of files.slice(0, MAX_IMAGES)) {
      if (file.size > MAX_FILE_BYTES) { errors.push('Each photo must be smaller than 8MB'); continue; }
      const buf = Buffer.from(await file.arrayBuffer());
      const mime = sniffMime(buf);
      if (!mime || !IMAGE_MIME.includes(mime as (typeof IMAGE_MIME)[number])) {
        errors.push('Photos must be real JPEG, PNG or WebP files');
        continue;
      }
      buffers.push({ buffer: buf, mime });
    }
    if (errors.length > 0) return Response.json({ error: errors.join('. ') }, { status: 400 });

    // AI-image guard on every photo (metadata forensics + visual analysis)
    const guardResults = await Promise.all(buffers.map((b) => guardImage(b.buffer, b.mime)));
    const rejected = guardResults.find((g) => !g.allowed);
    if (rejected) {
      await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'ai_image_rejected', target: name, detail: rejected.reason, ip: clientIp(req) });
      return Response.json({ error: `Photo rejected: ${rejected.reason} Green Gate only allows real product photos.` }, { status: 422 });
    }

    // Automatic white-background studio processing
    let processed: { buffer: Buffer; dataUrl: string }[];
    try {
      processed = await Promise.all(buffers.map((b) => processProductImage(b.buffer)));
    } catch {
      return Response.json({ error: 'A photo could not be processed. Try a different image.' }, { status: 400 });
    }

    // Variant SKUs: use seller-provided or generate; guarantee global uniqueness.
    const variantRows = variants.map((v, i) => ({
      sku: v.sku || `GG-${Date.now().toString(36).toUpperCase()}-${i}${Math.floor(Math.random() * 36).toString(36).toUpperCase()}`,
      attributes: JSON.stringify(v.attributes),
      stock: v.stock,
      priceCents: v.price ? Math.round(v.price * 100) : null,
    }));

    const created = await db.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          storeId: store.id,
          categoryId: cat!.id,
          name,
          slug: productSlug(name),
          description,
          brand,
          condition,
          tags,
          status,
          priceCents: Math.round(price * 100),
          salePriceCents: salePrice ? Math.round(salePrice * 100) : null,
          stock: variants.length > 0 ? 0 : stock,
          weightGrams: Math.round(weightGrams),
          lengthCm: Math.round(lengthCm),
          widthCm: Math.round(widthCm),
          heightCm: Math.round(heightCm),
        },
      });
      await tx.productImage.createMany({
        data: processed.map((p, i) => ({ productId: product.id, dataUrl: p.dataUrl, position: i })),
      });
      if (variantRows.length > 0) {
        await tx.productVariant.createMany({ data: variantRows.map((v) => ({ ...v, productId: product.id })) });
      }
      await tx.productEvent.createMany({
        data: processed.map(() => ({ productId: product.id, type: 'published' })),
      });
      return product;
    });

    await indexProduct({
      objectID: created.id,
      name: created.name,
      description: created.description,
      category: cat!.name,
      price: created.priceCents / 100,
      sellerName: store.name,
    });

    await audit({ actorId: session.user.id, actorEmail: session.user.email, action: 'product_created', target: created.id, detail: name });
    return Response.json({ ok: true, product: { id: created.id, slug: created.slug } }, { status: 201 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    if (e instanceof Error && e.message.includes('Unique constraint')) {
      return Response.json({ error: 'A variant SKU is already in use. Use unique SKUs.' }, { status: 409 });
    }
    console.error('POST /api/products error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not create the product. Please try again.' }, { status: 500 });
  }
}
