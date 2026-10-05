import { NextRequest, NextResponse } from 'next/server';
import { getShippingRates } from '@/lib/shipping';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const sellerLocation = String(body?.sellerLocation ?? 'Cape Town, South Africa');
    const buyerAddress = String(body?.buyerAddress ?? '').trim();
    const weightKg = Number(body?.weightKg) > 0 ? Number(body.weightKg) : 1;

    const rates = await getShippingRates({ sellerLocation, buyerAddress, weightKg });
    return NextResponse.json({ rates });
  } catch (e) {
    console.error('POST /api/shipping error:', e);
    return NextResponse.json({ error: 'Failed to calculate shipping' }, { status: 500 });
  }
}
