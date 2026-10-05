import { NextRequest } from 'next/server';
import { mergeGuestIntoUser } from '@/lib/recommender';
import { requireUser, authErrorResponse } from '@/lib/auth';
import { rateLimit, tooManyRequests } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/recommendations/merge — called once after sign-in. Merges the
 * anonymous browser learning profile into the user's persistent profile, so
 * pre-signup browsing continues to shape recommendations. The guest row is
 * then retired: nothing is forgotten, and nothing is double-counted.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();
    const rl = rateLimit(`rec-merge:${session.user.id}`, 10, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await req.json()) as { guestId?: string };
    const guestId = typeof body.guestId === 'string' ? body.guestId.trim() : '';
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(guestId)) {
      return Response.json({ error: 'Invalid guest id.' }, { status: 400 });
    }

    await mergeGuestIntoUser(guestId, session.user.id);
    return Response.json({ ok: true });
  } catch (e) {
    const authRes = authErrorResponse(e);
    if (authRes) return authRes;
    console.error('POST /api/recommendations/merge error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not merge profiles.' }, { status: 500 });
  }
}
