import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';

export const dynamic = 'force-dynamic';

/**
 * One saved delivery address, scoped strictly to its owner.
 * PATCH  — edit fields or promote to "always deliver here" (default).
 * DELETE — remove; if the default is removed the newest remaining one is promoted.
 */

interface AddressPatchBody {
  label?: string;
  recipientName?: string;
  phone?: string;
  street?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  locationSource?: string;
  isDefault?: boolean;
}

async function ownedAddress(userId: string, id: string) {
  return db.address.findFirst({ where: { id, userId } });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await bootstrap();
    const session = await requireUser();
    const { id } = await ctx.params;
    const existing = await ownedAddress(session.user.id, id);
    if (!existing) return Response.json({ error: 'Location not found.' }, { status: 404 });

    const body = (await req.json()) as AddressPatchBody;
    const data: Record<string, string | number | null | boolean> = {};

    if (body.label !== undefined) data.label = String(body.label).trim().slice(0, 40) || 'Home';
    if (body.recipientName !== undefined) {
      const v = String(body.recipientName).trim();
      if (v.length < 2) return Response.json({ error: 'Enter the recipient name' }, { status: 400 });
      data.recipientName = v;
    }
    if (body.phone !== undefined) {
      const v = String(body.phone).trim();
      if (v.replace(/\D/g, '').length < 9) return Response.json({ error: 'Enter a valid contact number' }, { status: 400 });
      data.phone = v;
    }
    if (body.street !== undefined) {
      const v = String(body.street).trim();
      if (v.length < 4) return Response.json({ error: 'Enter the street address' }, { status: 400 });
      data.street = v;
    }
    if (body.city !== undefined) {
      const v = String(body.city).trim();
      if (v.length < 2) return Response.json({ error: 'Enter the city or town' }, { status: 400 });
      data.city = v;
    }
    if (body.province !== undefined) {
      const v = String(body.province).trim();
      if (v.length < 2) return Response.json({ error: 'Enter the province' }, { status: 400 });
      data.province = v;
    }
    if (body.postalCode !== undefined) {
      const v = String(body.postalCode).trim();
      if (v.replace(/\D/g, '').length < 4) return Response.json({ error: 'Enter a valid postal code' }, { status: 400 });
      data.postalCode = v;
    }
    if (body.latitude !== undefined && Number.isFinite(body.latitude)) data.latitude = Number(body.latitude);
    if (body.longitude !== undefined && Number.isFinite(body.longitude)) data.longitude = Number(body.longitude);
    if (body.locationSource === 'gps' || body.locationSource === 'manual') data.locationSource = body.locationSource;

    const updated = await db.$transaction(async (tx) => {
      if (body.isDefault === true) {
        await tx.address.updateMany({ where: { userId: session.user.id, isDefault: true }, data: { isDefault: false } });
        data.isDefault = true;
      }
      return tx.address.update({ where: { id: existing.id }, data });
    });

    return Response.json({ ok: true, address: { id: updated.id, isDefault: updated.isDefault } });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('addresses PATCH error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not update this location.' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await bootstrap();
    const session = await requireUser();
    const { id } = await ctx.params;
    const existing = await ownedAddress(session.user.id, id);
    if (!existing) return Response.json({ error: 'Location not found.' }, { status: 404 });

    await db.$transaction(async (tx) => {
      await tx.address.delete({ where: { id: existing.id } });
      if (existing.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId: session.user.id },
          orderBy: { updatedAt: 'desc' },
        });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });

    return Response.json({ ok: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('addresses DELETE error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not remove this location.' }, { status: 500 });
  }
}
