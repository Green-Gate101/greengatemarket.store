import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureSeed } from '@/lib/seed';
import { sendSellerWelcome } from '@/lib/email';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await ensureSeed();
    const sellers = await db.seller.findMany({
      include: { _count: { select: { products: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json({
      sellers: sellers.map((s) => ({
        id: s.id,
        storeName: s.storeName,
        ownerName: s.ownerName,
        email: s.email,
        phone: s.phone,
        location: s.location,
        createdAt: s.createdAt.toISOString(),
        productCount: s._count.products,
      })),
    });
  } catch (e) {
    console.error('GET /api/sellers error:', e);
    return NextResponse.json({ error: 'Failed to load sellers' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const storeName = String(body.storeName ?? '').trim();
    const ownerName = String(body.ownerName ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const phone = String(body.phone ?? '').trim();
    const location = String(body.location ?? '').trim();

    const errors: string[] = [];
    if (storeName.length < 2) errors.push('Store name must be at least 2 characters');
    if (ownerName.length < 2) errors.push('Owner name must be at least 2 characters');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email address');
    if (phone.replace(/\D/g, '').length < 9) errors.push('Enter a valid phone number');
    if (location.length < 3) errors.push('Tell us where your store is based');
    if (errors.length > 0) return NextResponse.json({ error: errors.join('; ') }, { status: 400 });

    const exists = await db.seller.findUnique({ where: { email } });
    if (exists) return NextResponse.json({ error: 'A store with this email already exists. Open the dashboard and select it.' }, { status: 409 });

    const seller = await db.seller.create({
      data: { storeName, ownerName, email, phone, location },
    });

    sendSellerWelcome({ to: email, storeName, ownerName }).catch(() => undefined);

    return NextResponse.json({ seller }, { status: 201 });
  } catch (e) {
    console.error('POST /api/sellers error:', e);
    return NextResponse.json({ error: 'Failed to create seller account' }, { status: 500 });
  }
}
