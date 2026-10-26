import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireStoreSeller, authErrorResponse } from '@/lib/auth';
import { bootstrap } from '@/lib/bootstrap';
import { audit } from '@/lib/audit';
import { rateLimitShared, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { maybeUploadDataUrl } from '@/lib/storage';
import { prepareStoreImage } from '@/lib/store-images';

export const dynamic = 'force-dynamic';

/**
 * Store profile branding — the seller adds, replaces or removes their store
 * LOGO and banner at any time (before, a logo could only be added once, on
 * the store application). Multipart form: `logo` / `banner` files,
 * `removeLogo=1` / `removeBanner=1`. Owner only; every change is audited.
 */
export async function POST(req: NextRequest) {
  try {
    await bootstrap();
    const session = await requireStoreSeller();
    const rl = await rateLimitShared(`store-branding:${session.user.id}:${clientIp(req)}`, 30, 3600_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const store = await db.store.findUnique({ where: { userId: session.user.id }, select: { id: true, name: true } });
    if (!store) return Response.json({ error: 'Create your store first.' }, { status: 404 });

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: 'Send the images as a form upload.' }, { status: 400 });
    }
    const logo = form.get('logo');
    const banner = form.get('banner');
    const removeLogo = form.get('removeLogo') === '1';
    const removeBanner = form.get('removeBanner') === '1';

    const data: { logoData?: string | null; bannerData?: string | null } = {};
    if (logo instanceof File && logo.size > 0) {
      const r = await prepareStoreImage(logo, 'logo');
      if (!r.ok) return Response.json({ error: r.error }, { status: 422 });
      data.logoData = await maybeUploadDataUrl(r.dataUrl, 'stores');
    } else if (removeLogo) {
      data.logoData = null;
    }
    if (banner instanceof File && banner.size > 0) {
      const r = await prepareStoreImage(banner, 'banner');
      if (!r.ok) return Response.json({ error: r.error }, { status: 422 });
      data.bannerData = await maybeUploadDataUrl(r.dataUrl, 'stores');
    } else if (removeBanner) {
      data.bannerData = null;
    }
    if (Object.keys(data).length === 0) {
      return Response.json({ error: 'Choose a logo or banner image (or remove one).' }, { status: 400 });
    }

    const updated = await db.store.update({ where: { id: store.id }, data, select: { logoData: true, bannerData: true } });
    await audit({
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: 'store_branding_updated',
      target: store.name,
      detail: Object.entries(data).map(([k, v]) => `${k === 'logoData' ? 'logo' : 'banner'} ${v ? 'set' : 'removed'}`).join(', '),
      ip: clientIp(req),
    });
    return Response.json({ ok: true, hasLogo: Boolean(updated.logoData), hasBanner: Boolean(updated.bannerData) });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('store branding error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not save your store images. Please try again.' }, { status: 500 });
  }
}
