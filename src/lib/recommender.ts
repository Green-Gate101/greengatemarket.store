import { db } from '@/lib/db';

/**
 * Green Gate recommendation engine.
 *
 * A real, persistent learning system (not mock scoring):
 *
 *  1. Implicit-feedback profiles — every view / wishlist / cart / click /
 *     purchase updates a per-shopper affinity profile (items, categories,
 *     brands, price bands) with exponential recency decay (45-day half-life).
 *  2. Item-item collaborative filtering — a weighted co-preference matrix
 *     ("shoppers who engaged with A also engaged with B") is updated
 *     incrementally on every event.
 *  3. Content-based scoring — category / brand / price-band affinity.
 *  4. Popularity prior — Bayesian-shrunk view/cart/purchase popularity so
 *     cold-start shoppers still get sensible results.
 *  5. Online ensemble learning — the three signals are blended with weights
 *     that adapt to observed click-through (Bayesian smoothed lift against a
 *     prior CTR), so the algorithm literally learns what works for shoppers.
 *
 * All state lives in the RecommendationState table (one row per subject plus a
 * global 'model' row), so learning survives restarts and redeployments — the
 * marketplace never forgets what it has learned.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_WEIGHTS: Record<string, number> = {
  view: 1,
  wishlist: 2,
  cart: 3,
  rec_click: 4,
  purchase: 5,
};

/** Recency half-life in days — yesterday matters more than last month. */
const HALF_LIFE_DAYS = 45;
const DAY_MS = 86_400_000;

/** Price bands used for content-based affinity (ZAR cents). */
const PRICE_BANDS: [max: number, label: string][] = [
  [15_000, 'under-r150'],
  [50_000, 'r150-r500'],
  [150_000, 'r500-r1500'],
  [500_000, 'r1500-r5000'],
  [Number.MAX_SAFE_INTEGER, 'over-r5000'],
];

export function priceBandOf(priceCents: number): string {
  for (const [max, label] of PRICE_BANDS) {
    if (priceCents <= max) return label;
  }
  return 'over-r5000';
}

// ---------------------------------------------------------------------------
// State shapes (persisted as JSON)
// ---------------------------------------------------------------------------

interface SubjectProfile {
  /** productId -> accumulated, decayed engagement weight */
  items: Record<string, number>;
  /** products the subject actually bought (never recommended again) */
  purchased: Record<string, 1>;
  cats: Record<string, number>;
  brands: Record<string, number>;
  bands: Record<string, number>;
  signals: number;
  updatedAt: number;
}

interface SourceFeedback {
  /** impression-weighted exposure count for this source */
  impressions: number;
  clicks: number;
}

interface GlobalModel {
  /** itemId -> neighbour itemId -> co-preference weight */
  co: Record<string, Record<string, number>>;
  /** itemId -> { v: views, c: carts+lists, p: purchases } */
  pop: Record<string, { v: number; c: number; p: number }>;
  /** click feedback per ensemble source — drives the weight learning */
  feedback: Record<'cf' | 'content' | 'pop', SourceFeedback>;
  updatedAt: number;
}

export interface Attribution {
  cf: number;
  content: number;
  pop: number;
}

const EMPTY_PROFILE: SubjectProfile = {
  items: {},
  purchased: {},
  cats: {},
  brands: {},
  bands: {},
  signals: 0,
  updatedAt: 0,
};

const EMPTY_MODEL: GlobalModel = {
  co: {},
  pop: {},
  feedback: {
    cf: { impressions: 0, clicks: 0 },
    content: { impressions: 0, clicks: 0 },
    pop: { impressions: 0, clicks: 0 },
  },
  updatedAt: 0,
};

// ---------------------------------------------------------------------------
// Persistence helpers (serialized in-process to avoid lost updates)
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

/** Serialize state mutations; SQLite writes are fast but not concurrent-safe here. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function loadJSON<T>(scope: string, fallback: T): Promise<T> {
  const row = await db.recommendationState.findUnique({ where: { scope } });
  if (!row) return fallback;
  try {
    return JSON.parse(row.data) as T;
  } catch {
    return fallback;
  }
}

async function saveJSON(scope: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data);
  await db.recommendationState.upsert({
    where: { scope },
    update: { data: json },
    create: { scope, data: json },
  });
}

/**
 * Apply recency decay relative to the profile's own last update so weights
 * fade when a shopper goes quiet.
 */
function applyDecay(weights: Record<string, number>, updatedAt: number, now: number): void {
  if (!updatedAt) return;
  const days = (now - updatedAt) / DAY_MS;
  if (days < 1) return;
  const factor = Math.exp(-(Math.LN2 * days) / HALF_LIFE_DAYS);
  for (const key of Object.keys(weights)) {
    const value = weights[key] * factor;
    if (value < 0.01) delete weights[key];
    else weights[key] = value;
  }
}

function subjectKey(userId: string | null | undefined, guestId: string | null | undefined): string | null {
  if (userId) return `user:${userId}`;
  if (guestId && /^[A-Za-z0-9_-]{8,64}$/.test(guestId)) return `guest:${guestId}`;
  return null;
}

// ---------------------------------------------------------------------------
// Learning: record an interaction
// ---------------------------------------------------------------------------

export interface InteractionInput {
  productId: string;
  type: keyof typeof EVENT_WEIGHTS;
  userId?: string | null;
  guestId?: string | null;
  /** Product attributes for content affinity; fetched server-side when omitted. */
  catSlug?: string | null;
  brand?: string | null;
  priceCents?: number | null;
}

/**
 * Update the subject profile, the co-preference matrix and the popularity
 * model from one observed interaction. Cheap enough to run inline.
 */
export function recordInteraction(input: InteractionInput): Promise<void> {
  return serialized(async () => {
    const key = subjectKey(input.userId, input.guestId);
    const typeWeight = EVENT_WEIGHTS[input.type] ?? 1;
    const now = Date.now();

    const model = await loadJSON('model', EMPTY_MODEL);
    const pop = model.pop[input.productId] ?? { v: 0, c: 0, p: 0 };
    if (input.type === 'view') pop.v += 1;
    else if (input.type === 'purchase') pop.p += 1;
    else pop.c += 1;
    model.pop[input.productId] = pop;
    model.updatedAt = now;
    await saveJSON('model', model);

    if (!key) return;

    const profile = await loadJSON<SubjectProfile>(key, EMPTY_PROFILE);
    applyDecay(profile.items, profile.updatedAt, now);
    applyDecay(profile.cats, profile.updatedAt, now);
    applyDecay(profile.brands, profile.updatedAt, now);
    applyDecay(profile.bands, profile.updatedAt, now);

    // --- co-preference learning: new item B against existing affinities A ---
    const co = model.co;
    for (const [otherId, weight] of Object.entries(profile.items)) {
      if (otherId === input.productId || weight < 0.05) continue;
      (co[otherId] ??= {})[input.productId] = (co[otherId]?.[input.productId] ?? 0) + weight * typeWeight;
      (co[input.productId] ??= {})[otherId] = (co[input.productId]?.[otherId] ?? 0) + weight * typeWeight;
    }
    model.updatedAt = now;
    await saveJSON('model', model);

    // --- profile update ---
    profile.items[input.productId] = (profile.items[input.productId] ?? 0) + typeWeight;
    if (input.type === 'purchase') profile.purchased[input.productId] = 1;
    if (input.catSlug) profile.cats[input.catSlug] = (profile.cats[input.catSlug] ?? 0) + typeWeight;
    if (input.brand) profile.brands[input.brand] = (profile.brands[input.brand] ?? 0) + typeWeight;
    if (input.priceCents) {
      const band = priceBandOf(input.priceCents);
      profile.bands[band] = (profile.bands[band] ?? 0) + typeWeight;
    }
    profile.signals += 1;
    profile.updatedAt = now;
    await saveJSON(key, profile);
  });
}

// ---------------------------------------------------------------------------
// Ensemble weight learning (click-through)
// ---------------------------------------------------------------------------

const PRIOR_CTR = 0.03;
const PRIOR_STRENGTH = 40;

/**
 * Update the learned ensemble weights from click feedback.
 * `attribution` is the per-source contribution map the API returned for the
 * clicked product; sources that contributed get credit proportional to their
 * contribution. Weights follow smoothed CTR lift against the prior.
 */
export function recordRecFeedback(
  clicked: { productId: string; attribution: Attribution } | null,
  impressions: Attribution[] | null,
  subject: { userId?: string | null; guestId?: string | null },
): Promise<{ weights: Record<string, number> }> {
  return serialized(async () => {
    const now = Date.now();
    const model = await loadJSON('model', EMPTY_MODEL);
    const fb = model.feedback;

    if (impressions) {
      for (const attr of impressions) {
        const total = attr.cf + attr.content + attr.pop;
        if (total <= 0) continue;
        if (attr.cf / total >= 0.1) fb.cf.impressions += 1;
        if (attr.content / total >= 0.1) fb.content.impressions += 1;
        if (attr.pop / total >= 0.1) fb.pop.impressions += 1;
      }
    }

    if (clicked && clicked.attribution) {
      const { cf, content, pop } = clicked.attribution;
      const total = cf + content + pop;
      if (total > 0) {
        fb.cf.clicks += cf / total;
        fb.content.clicks += content / total;
        fb.pop.clicks += pop / total;
      }
      // A recommendation click is also a strong interest signal — learn from it.
      const key = subjectKey(subject.userId, subject.guestId);
      if (key) {
        await applyInteractionToProfile(key, clicked.productId, 'rec_click', now, model);
      }
    }

    model.updatedAt = now;
    await saveJSON('model', model);
    return { weights: ensembleWeights(fb) };
  });
}

function ensembleWeights(fb: GlobalModel['feedback']): Record<string, number> {
  const priors: Record<string, number> = { cf: 0.45, content: 0.35, pop: 0.2 };
  const out: Record<string, number> = {};
  let sum = 0;
  for (const source of Object.keys(priors)) {
    const f = fb[source as keyof typeof fb] ?? { impressions: 0, clicks: 0 };
    const ctr = (f.clicks + PRIOR_CTR * PRIOR_STRENGTH) / (f.impressions + PRIOR_STRENGTH);
    const lift = Math.min(2.5, Math.max(0.4, ctr / PRIOR_CTR));
    out[source] = priors[source] * lift;
    sum += out[source];
  }
  for (const source of Object.keys(out)) out[source] /= sum || 1;
  return out;
}

/** Shared profile-update path used by recordInteraction and click feedback. */
async function applyInteractionToProfile(
  key: string,
  productId: string,
  type: keyof typeof EVENT_WEIGHTS,
  now: number,
  model: GlobalModel,
): Promise<void> {
  const typeWeight = EVENT_WEIGHTS[type] ?? 1;
  const profile = await loadJSON<SubjectProfile>(key, EMPTY_PROFILE);
  applyDecay(profile.items, profile.updatedAt, now);
  applyDecay(profile.cats, profile.updatedAt, now);
  applyDecay(profile.brands, profile.updatedAt, now);
  applyDecay(profile.bands, profile.updatedAt, now);

  const co = model.co;
  for (const [otherId, weight] of Object.entries(profile.items)) {
    if (otherId === productId || weight < 0.05) continue;
    (co[otherId] ??= {})[productId] = (co[otherId]?.[productId] ?? 0) + weight * typeWeight;
    (co[productId] ??= {})[otherId] = (co[productId]?.[otherId] ?? 0) + weight * typeWeight;
  }

  profile.items[productId] = (profile.items[productId] ?? 0) + typeWeight;
  profile.signals += 1;
  profile.updatedAt = now;
  await saveJSON(key, profile);
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/** Minimal product attributes the engine scores against. */
export interface CandidateProduct {
  id: string;
  catSlug: string | null;
  brand: string | null;
  priceCents: number;
  stock: number;
  variantStock: number;
  storeId: string;
}

interface ScoredCandidate {
  id: string;
  score: number;
  attribution: Attribution;
}

export interface RecOptions {
  userId?: string | null;
  guestId?: string | null;
  limit?: number;
  excludeIds?: string[];
  /** Candidate pool (already filtered to approved + in stock). */
  candidates: CandidateProduct[];
}

export interface RecResult {
  order: string[];
  attribution: Record<string, Attribution>;
  source: 'personalized' | 'trending';
  weights: Record<string, number>;
}

/**
 * Personalised ranking of the candidate pool. Falls back to trending when the
 * subject has no learned affinity yet — never returns fake data.
 */
export async function recommend(opts: RecOptions): Promise<RecResult> {
  const limit = Math.min(24, Math.max(1, opts.limit ?? 8));
  const exclude = new Set(opts.excludeIds ?? []);
  const key = subjectKey(opts.userId, opts.guestId);
  const model = await loadJSON('model', EMPTY_MODEL);
  const profile = key
    ? await loadJSON<SubjectProfile>(key, EMPTY_PROFILE)
    : EMPTY_PROFILE;

  const pool = opts.candidates.filter((c) => !exclude.has(c.id) && c.stock + c.variantStock > 0);
  if (pool.length === 0) {
    return { order: [], attribution: {}, source: 'trending', weights: ensembleWeights(model.feedback) };
  }

  const hasAffinity =
    profile.signals > 0 && (Object.keys(profile.items).length > 0 || Object.keys(profile.cats).length > 0);

  const scored: ScoredCandidate[] = pool.map((c) => {
    const attr: Attribution = { cf: 0, content: 0, pop: 0 };

    if (hasAffinity) {
      // Collaborative filtering: neighbours of the subject's strongest items.
      const items = Object.entries(profile.items)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
      for (const [itemId, weight] of items) {
        const neighbours = model.co[itemId];
        if (!neighbours) continue;
        const nb = neighbours[c.id];
        if (!nb) continue;
        let outSum = 0;
        for (const other of Object.values(neighbours)) outSum += other;
        attr.cf += (nb / (1 + outSum)) * Math.min(weight, 5);
      }

      // Content: category / brand / price-band affinity.
      const catTotal = Object.values(profile.cats).reduce((a, b) => a + b, 0) || 1;
      const brandTotal = Object.values(profile.brands).reduce((a, b) => a + b, 0) || 1;
      const bandTotal = Object.values(profile.bands).reduce((a, b) => a + b, 0) || 1;
      if (c.catSlug && profile.cats[c.catSlug]) attr.content += 0.55 * (profile.cats[c.catSlug] / catTotal);
      if (c.brand && profile.brands[c.brand]) attr.content += 0.2 * (profile.brands[c.brand] / brandTotal);
      if (profile.bands[priceBandOf(c.priceCents)]) {
        attr.content += 0.25 * (profile.bands[priceBandOf(c.priceCents)] / bandTotal);
      }

      // Items the shopper already engaged with heavily get no boost here —
      // discovery is the goal. Purchased items are excluded entirely below.
      if (profile.purchased[c.id]) {
        attr.cf = 0;
        attr.content = 0;
      }
    }

    // Popularity prior (Bayesian shrink toward a small baseline).
    const p = model.pop[c.id] ?? { v: 0, c: 0, p: 0 };
    attr.pop = (p.v + 3 * p.c + 6 * p.p + 8) / (p.v + p.c + p.p + 40);

    return { id: c.id, score: 0, attribution: attr };
  });

  const purchasedItems = new Set(Object.keys(profile.purchased ?? {}));
  const eligible = scored.filter((s) => !(hasAffinity && purchasedItems.has(s.id)));
  const list = eligible.length > 0 ? eligible : scored;

  const weights = ensembleWeights(model.feedback);
  const maxCf = Math.max(...list.map((s) => s.attribution.cf), 0.000001);
  const maxContent = Math.max(...list.map((s) => s.attribution.content), 0.000001);
  const maxPop = Math.max(...list.map((s) => s.attribution.pop), 0.000001);

  for (const s of list) {
    s.attribution.cf = s.attribution.cf / maxCf;
    s.attribution.content = s.attribution.content / maxContent;
    s.attribution.pop = s.attribution.pop / maxPop;
    s.score =
      (weights.cf ?? 0.45) * s.attribution.cf +
      (weights.content ?? 0.35) * s.attribution.content +
      (weights.pop ?? 0.2) * s.attribution.pop;
  }

  list.sort((a, b) => b.score - a.score);

  // Diversity: at most 3 per category and 2 per store.
  const catCount = new Map<string, number>();
  const storeCount = new Map<string, number>();
  const chosen: ScoredCandidate[] = [];
  for (const s of list) {
    const cand = pool.find((c) => c.id === s.id)!;
    const cN = catCount.get(cand.catSlug ?? '-') ?? 0;
    const sN = storeCount.get(cand.storeId) ?? 0;
    if (cN >= 3 || sN >= 2) continue;
    catCount.set(cand.catSlug ?? '-', cN + 1);
    storeCount.set(cand.storeId, sN + 1);
    chosen.push(s);
    if (chosen.length >= limit) break;
  }
  if (chosen.length < Math.min(limit, list.length)) {
    for (const s of list) {
      if (chosen.length >= limit) break;
      if (!chosen.includes(s)) chosen.push(s);
    }
  }

  // Impression feedback for the learning loop (per returned item).
  void recordRecFeedback(null, chosen.map((s) => s.attribution), { userId: opts.userId, guestId: opts.guestId }).catch(
    () => undefined,
  );

  const attribution: Record<string, Attribution> = {};
  for (const s of chosen) attribution[s.id] = s.attribution;

  return {
    order: chosen.map((s) => s.id),
    attribution,
    source: hasAffinity ? 'personalized' : 'trending',
    weights,
  };
}

/**
 * "More like this" — co-preference neighbours of one product, backed by
 * same-category popularity when the matrix is still cold.
 */
export async function similarProducts(
  productId: string,
  candidates: CandidateProduct[],
  limit = 6,
): Promise<string[]> {
  const model = await loadJSON('model', EMPTY_MODEL);
  const neighbours = Object.entries(model.co[productId] ?? {})
    .filter(([id]) => candidates.some((c) => c.id === id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  if (neighbours.length >= limit) return neighbours;

  const self = candidates.find((c) => c.id === productId);
  const fallback = candidates
    .filter((c) => c.id !== productId && !neighbours.includes(c.id))
    .filter((c) => (self ? c.catSlug === self.catSlug : true))
    .sort((a, b) => {
      const pa = model.pop[a.id] ?? { v: 0, c: 0, p: 0 };
      const pb = model.pop[b.id] ?? { v: 0, c: 0, p: 0 };
      const sa = (pa.v + 3 * pa.c + 6 * pa.p + 8) / (pa.v + pa.c + pa.p + 40);
      const sb = (pb.v + 3 * pb.c + 6 * pb.p + 8) / (pb.v + pb.c + pb.p + 40);
      return sb - sa;
    })
    .slice(0, limit - neighbours.length)
    .map((c) => c.id);

  return [...neighbours, ...fallback];
}

// ---------------------------------------------------------------------------
// Guest → user merge (never lose a shopper's learned profile)
// ---------------------------------------------------------------------------

/**
 * Merge an anonymous browser profile into the signed-in user's profile when
 * they sign in, so pre-signup browsing continues to shape recommendations.
 */
export function mergeGuestIntoUser(guestId: string, userId: string): Promise<void> {
  return serialized(async () => {
    const guestKey = `guest:${guestId}`;
    const userKey = `user:${userId}`;
    if (guestKey === userKey) return;

    const [guest, user] = await Promise.all([
      loadJSON<SubjectProfile>(guestKey, EMPTY_PROFILE),
      loadJSON<SubjectProfile>(userKey, EMPTY_PROFILE),
    ]);
    if (guest.signals === 0) return;

    const merged: SubjectProfile = {
      items: { ...user.items },
      purchased: { ...user.purchased, ...guest.purchased },
      cats: { ...user.cats },
      brands: { ...user.brands },
      bands: { ...user.bands },
      signals: user.signals + guest.signals,
      updatedAt: Date.now(),
    };
    for (const [id, w] of Object.entries(guest.items)) merged.items[id] = (merged.items[id] ?? 0) + w;
    for (const [id, w] of Object.entries(guest.cats)) merged.cats[id] = (merged.cats[id] ?? 0) + w;
    for (const [id, w] of Object.entries(guest.brands)) merged.brands[id] = (merged.brands[id] ?? 0) + w;
    for (const [id, w] of Object.entries(guest.bands)) merged.bands[id] = (merged.bands[id] ?? 0) + w;

    await saveJSON(userKey, merged);
    await db.recommendationState.deleteMany({ where: { scope: guestKey } });
  });
}
