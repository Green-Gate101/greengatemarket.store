import { NextRequest } from 'next/server';
import { recordRecFeedback, type Attribution } from '@/lib/recommender';
import { rateLimit, clientIp, tooManyRequests } from '@/lib/rate-limit';
import { getSession } from '@/lib/auth';
import { readJsonObject, invalidJsonBody } from '@/lib/request-body';

export const dynamic = 'force-dynamic';

interface FeedbackBody {
  guestId?: string;
  click?: { productId?: string; attribution?: Partial<Attribution> };
  impressions?: Partial<Attribution>[];
}

function sanitizeAttribution(value: Partial<Attribution> | undefined): Attribution | null {
  if (!value) return null;
  const cf = Number(value.cf);
  const content = Number(value.content);
  const pop = Number(value.pop);
  if (![cf, content, pop].every((n) => Number.isFinite(n) && n >= 0 && n <= 1.0001)) return null;
  return { cf, content, pop };
}

/**
 * POST /api/recommendations/feedback — the learning loop's reward channel.
 *
 * The client echoes back the attribution map it received alongside its
 * impressions and any click. The engine uses this to adapt the ensemble
 * weights (Bayesian-smoothed CTR lift) and to learn from recommendation
 * clicks as strong interest signals. Numeric inputs are validated and
 * per-source influence is bounded, so the signal cannot be poisoned.
 */
export async function POST(req: NextRequest) {
  try {
    const rl = rateLimit(`rec-feedback:${clientIp(req)}`, 60, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const body = (await readJsonObject(req)) as FeedbackBody | null;
    if (!body) return invalidJsonBody();
    const guestId = typeof body.guestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.guestId) ? body.guestId : null;
    const session = await getSession();

    const impressions = Array.isArray(body.impressions)
      ? body.impressions.slice(0, 24).map(sanitizeAttribution).filter((a): a is Attribution => a !== null)
      : null;

    let click: { productId: string; attribution: Attribution } | null = null;
    if (body.click && typeof body.click.productId === 'string') {
      const attr = sanitizeAttribution(body.click.attribution);
      if (attr) click = { productId: body.click.productId, attribution: attr };
    }

    if (!click && (!impressions || impressions.length === 0)) {
      return Response.json({ error: 'No usable feedback in payload.' }, { status: 400 });
    }

    const { weights } = await recordRecFeedback(
      click,
      impressions,
      { userId: session?.user.id ?? null, guestId: session ? null : guestId },
    );

    return Response.json({ ok: true, weights });
  } catch (e) {
    console.error('POST /api/recommendations/feedback error:', e instanceof Error ? e.message : e);
    return Response.json({ error: 'Could not record feedback.' }, { status: 500 });
  }
}
