import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { rateLimitShared, clientIp, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Saved delivery addresses ("always deliver here" locations).
 * GET  — list the signed-in user's saved locations (default first).
 * POST — save a location captured via real-time GPS fix or typed manually.
 *        The first saved location automatically becomes the default.
 */

const MAX_ADDRESSES = 20;

interface AddressBody {
  label?: string;
  recipientName?: string;
  phone?: string;
  street?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  locationSource?: string;
  isDefault?: boolean;
}

export async function GET() {
  try {
    await bootstrap();
    const session = await requireUser();
    const rows = await db.address.findMany({
      where: { userId: session.user.id },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    return Response.json({
      addresses: rows.map((a) => ({
        id: a.id,
        label: a.label,
        recipientName: a.recipientName,
        phone: a.phone,
        street: a.street,
        city: a.city,
        province: a.province,
        postalCode: a.postalCode,
        latitude: a.latitude,
        longitude: a.longitude,
        accuracyMeters: a.accuracyMeters,
        locationSource: a.locationSource,
        isDefault: a.isDefault,
        createdAt: a.createdAt,
      })),
    });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('addresses GET error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not load your saved locations.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireUser();
    const rl = await rateLimitShared(`addresses:${session.user.id}:${clientIp(req)}`, 30, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await req.json()) as AddressBody;
    const label = String(body.label ?? 'Home').trim().slice(0, 40) || 'Home';
    const recipientName = String(body.recipientName ?? '').trim();
    const phone = String(body.phone ?? '').trim();
    const street = String(body.street ?? '').trim();
    const city = String(body.city ?? '').trim();
    const province = String(body.province ?? '').trim();
    const postalCode = String(body.postalCode ?? '').trim();
    const latitude = Number.isFinite(body.latitude) ? Number(body.latitude) : null;
    const longitude = Number.isFinite(body.longitude) ? Number(body.longitude) : null;
    const accuracyMeters = Number.isFinite(body.accuracyMeters) ? Math.round(Number(body.accuracyMeters)) : null;
    // manual = typed by hand · gps = live GPS fix · search = picked from
    // address-search suggestions (exact geocoded pin, no live GPS lock).
    const locationSource = ['gps', 'search'].includes(String(body.locationSource)) ? String(body.locationSource) : 'manual';
    const isDefault = Boolean(body.isDefault);

    const errors: string[] = [];
    if (recipientName.length < 2) errors.push('Enter the recipient name');
    if (phone.replace(/\D/g, '').length < 9) errors.push('Enter a valid contact number');
    if (street.length < 4) errors.push('Enter the street address');
    if (city.length < 2) errors.push('Enter the city or town');
    if (province.length < 2) errors.push('Enter the province');
    if (postalCode.replace(/\D/g, '').length < 4) errors.push('Enter a valid postal code');
    if (errors.length > 0) return Response.json({ error: errors.join('. ') }, { status: 400 });

    const count = await db.address.count({ where: { userId: session.user.id } });
    if (count >= MAX_ADDRESSES) {
      return Response.json({ error: `You can save up to ${MAX_ADDRESSES} delivery locations. Remove one first.` }, { status: 400 });
    }

    const created = await db.$transaction(async (tx) => {
      // The very first saved location is always the default ("always deliver here").
      const makeDefault = isDefault || count === 0;
      if (makeDefault) {
        await tx.address.updateMany({ where: { userId: session.user.id, isDefault: true }, data: { isDefault: false } });
      }
      return tx.address.create({
        data: {
          userId: session.user.id,
          label,
          recipientName,
          phone,
          street,
          city,
          province,
          postalCode,
          latitude,
          longitude,
          accuracyMeters,
          locationSource,
          isDefault: makeDefault,
        },
      });
    });

    return Response.json({ ok: true, address: { id: created.id, isDefault: created.isDefault } }, { status: 201 });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('addresses POST error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not save this location.' }, { status: 500 });
  }
}
