import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureSeed } from '@/lib/seed';
import { processProductImage } from '@/lib/image-processing';
import { indexProduct, searchProductIds } from '@/lib/algolia';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    await ensureSeed();
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q')?.trim() ?? '';
    const category = searchParams.get('category')?.trim() ?? '';
    const sellerId = searchParams.get('sellerId')?.trim() ?? '';
    const limit = Math.min(Number(searchParams.get('limit') ?? 48) || 48, 96);

    const where: Record<string, unknown> = {};
    if (category && category !== 'All') where.category = category;
    if (sellerId) where.sellerId = sellerId;

    if (q) {
      // Primary search runs on Algolia; the database filter is the fallback
      // (the index may hold objects from previous database generations).
      const ids = await searchProductIds(q);
      const prismaWhere: Record<string, unknown> = { ...where };
      let products;
      if (ids && ids.length > 0) {
        prismaWhere.id = { in: ids };
        products = await db.product.findMany({
          where: prismaWhere,
          include: { seller: { select: { id: true, storeName: true, location: true } } },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
      }
      if (!products || products.length === 0) {
        products = await db.product.findMany({
          where: { ...where, searchName: { contains: q.toLowerCase() } },
          include: { seller: { select: { id: true, storeName: true, location: true } } },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
      }
      return NextResponse.json({ products });
    }

    const products = await db.product.findMany({
      where,
      include: { seller: { select: { id: true, storeName: true, location: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return NextResponse.json({ products });
  } catch (e) {
    console.error('GET /api/products error:', e);
    return NextResponse.json({ error: 'Failed to load products' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const sellerId = String(form.get('sellerId') ?? '');
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    const category = String(form.get('category') ?? '').trim();
    const price = Number(form.get('price'));
    const stock = Number(form.get('stock'));
    const image = form.get('image');

    const errors: string[] = [];
    if (!sellerId) errors.push('A seller account is required');
    if (name.length < 3) errors.push('Product name must be at least 3 characters');
    if (description.length < 10) errors.push('Description must be at least 10 characters');
    if (!category) errors.push('Choose a category');
    if (!Number.isFinite(price) || price <= 0) errors.push('Price must be greater than zero');
    if (!Number.isInteger(stock) || stock < 0) errors.push('Stock must be a whole number of zero or more');
    if (!(image instanceof File) || image.size === 0) errors.push('A product photo is required');
    else if (image.size > 10 * 1024 * 1024) errors.push('Photo must be smaller than 10MB');
    else if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type)) errors.push('Photo must be a JPEG, PNG or WebP file');
    if (errors.length > 0) return NextResponse.json({ error: errors.join('; ') }, { status: 400 });

    const seller = await db.seller.findUnique({ where: { id: sellerId } });
    if (!seller) return NextResponse.json({ error: 'Seller account not found' }, { status: 404 });

    const inputBuffer = Buffer.from(await (image as File).arrayBuffer());
    let processed;
    try {
      processed = await processProductImage(inputBuffer);
    } catch {
      return NextResponse.json({ error: 'The photo could not be processed. Try a different image.' }, { status: 400 });
    }

    const product = await db.product.create({
      data: {
        sellerId,
        name,
        description,
        category,
        price: Math.round(price * 100) / 100,
        stock,
        imageData: processed.dataUrl,
        searchName: `${name} ${description} ${category}`.toLowerCase(),
      },
      include: { seller: { select: { id: true, storeName: true, location: true } } },
    });

    await indexProduct({
      objectID: product.id,
      name: product.name,
      description: product.description,
      category: product.category,
      price: product.price,
      sellerName: seller.storeName,
    });

    return NextResponse.json({ product }, { status: 201 });
  } catch (e) {
    console.error('POST /api/products error:', e);
    return NextResponse.json({ error: 'Failed to create product' }, { status: 500 });
  }
}
