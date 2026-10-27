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
// Persistence helpers
// ---------------------------------------------------------------------------

// One shopper's profile changes run one at a time (no lost updates); different
// shoppers no longer wait for each other — a single queue for every event on
// the server let a busy server fall further and further behind.
const subjectQueues = new Map<string, Promise<unknown>>();

function serializedFor<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (subjectQueues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  subjectQueues.set(key, tail);
  void tail.then(() => {
    if (subjectQueues.get(key) === tail) subjectQueues.delete(key);
  });
  return run;
}

async function loadJSON<T>(scope: string, fallback: T): Promise<T> {
  const row = await db.recommendationState.findUnique({ where: { scope } });
  // Always a fresh copy of the fallback: handing out the shared empty profile
  // let the next new visitor inherit whatever the previous one browsed.
  if (!row) return structuredClone(fallback);
  try {
    return JSON.parse(row.data) as T;
  } catch {
    return structuredClone(fallback);
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

// ---------------------------------------------------------------------------
// The shared model (popularity, liked-together links, click feedback)
// ---------------------------------------------------------------------------
//
// Every change to the shared model is an addition, so each server adds its
// changes up in memory and writes them together every few seconds — instead
// of reading and rewriting the whole model twice on every product view, which
// queued every request behind one database row under heavy traffic. Writes
// are checked against the row's last-changed time, so batches from many
// servers all land (none overwrites another). Reads use a copy at most a few
// seconds old with this server's unwritten changes already in it.

const MODEL_READ_MS = 10_000;
const MODEL_WRITE_MS = 5_000;
/** Strongest liked-together links kept per product (the model stays small). */
const CO_NEIGHBOURS_KEPT = 50;

type ModelChanges = Pick<GlobalModel, 'co' | 'pop' | 'feedback'> & { count: number };

const noChanges = (): ModelChanges => ({
  co: {},
  pop: {},
  feedback: { cf: { impressions: 0, clicks: 0 }, content: { impressions: 0, clicks: 0 }, pop: { impressions: 0, clicks: 0 } },
  count: 0,
});

let modelCopy: { model: GlobalModel; at: number } | null = null;
let modelReading: Promise<GlobalModel> | null = null;
let modelWrites = 0;
let pendingChanges = noChanges();
let writingChanges: Promise<void> | null = null;
let lastModelWrite = Date.now();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function addChanges(model: Pick<GlobalModel, 'co' | 'pop' | 'feedback'>, ch: ModelChanges): void {
  for (const [id, d] of Object.entries(ch.pop)) {
    const p = (model.pop[id] ??= { v: 0, c: 0, p: 0 });
    p.v += d.v;
    p.c += d.c;
    p.p += d.p;
  }
  for (const [a, row] of Object.entries(ch.co)) {
    const links = (model.co[a] ??= {});
    for (const [b, w] of Object.entries(row)) links[b] = (links[b] ?? 0) + w;
  }
  for (const s of ['cf', 'content', 'pop'] as const) {
    const f = (model.feedback[s] ??= { impressions: 0, clicks: 0 });
    f.impressions += ch.feedback[s].impressions;
    f.clicks += ch.feedback[s].clicks;
  }
}

/** The change goes into this server's unwritten batch and its current copy. */
function changeModel(edit: (m: Pick<GlobalModel, 'co' | 'pop' | 'feedback'>) => void): void {
  edit(pendingChanges);
  pendingChanges.count += 1;
  if (modelCopy) {
    edit(modelCopy.model);
    modelCopy.model.updatedAt = Date.now();
  }
  scheduleModelWrite();
}

const addPop = (productId: string, field: 'v' | 'c' | 'p') =>
  changeModel((m) => { (m.pop[productId] ??= { v: 0, c: 0, p: 0 })[field] += 1; });
const addCo = (a: string, b: string, w: number) =>
  changeModel((m) => { const links = (m.co[a] ??= {}); links[b] = (links[b] ?? 0) + w; });
const addFeedback = (source: 'cf' | 'content' | 'pop', field: 'impressions' | 'clicks', x: number) =>
  changeModel((m) => { (m.feedback[source] ??= { impressions: 0, clicks: 0 })[field] += x; });

/** A stored model with every part present (older snapshots may lack one). */
function wholeModel(m: Partial<GlobalModel> | null | undefined): GlobalModel {
  const empty = structuredClone(EMPTY_MODEL);
  return {
    co: m?.co ?? empty.co,
    pop: m?.pop ?? empty.pop,
    feedback: { cf: m?.feedback?.cf ?? empty.feedback.cf, content: m?.feedback?.content ?? empty.feedback.content, pop: m?.feedback?.pop ?? empty.feedback.pop },
    updatedAt: m?.updatedAt ?? 0,
  };
}

function keepStrongestLinks(model: GlobalModel): void {
  for (const [id, links] of Object.entries(model.co)) {
    const entries = Object.entries(links);
    if (entries.length <= CO_NEIGHBOURS_KEPT) continue;
    entries.sort((x, y) => y[1] - x[1]);
    model.co[id] = Object.fromEntries(entries.slice(0, CO_NEIGHBOURS_KEPT));
  }
}

/** The shared model as of a few seconds ago, plus this server's unwritten changes. */
async function readModel(): Promise<GlobalModel> {
  if (modelCopy && Date.now() - modelCopy.at < MODEL_READ_MS) return modelCopy.model;
  if (!modelReading) {
    const writesBefore = modelWrites;
    modelReading = loadJSON<GlobalModel>('model', EMPTY_MODEL)
      .then((loaded) => {
        // A batch written while this read was under way is newer — keep it.
        if (modelWrites !== writesBefore && modelCopy) return modelCopy.model;
        const stored = wholeModel(loaded);
        addChanges(stored, pendingChanges);
        modelCopy = { model: stored, at: Date.now() };
        return stored;
      })
      .finally(() => {
        modelReading = null;
      });
  }
  return modelReading;
}

function scheduleModelWrite(): void {
  if (writingChanges) return;
  // A timer can sit unfired while the server is paused between requests.
  if (Date.now() - lastModelWrite >= MODEL_WRITE_MS * 2) {
    void writeModelChanges();
    return;
  }
  if (!writeTimer) {
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void writeModelChanges();
    }, MODEL_WRITE_MS);
    writeTimer.unref?.();
  }
}

/** Write this server's added-up changes into the stored model. */
function writeModelChanges(): Promise<void> {
  if (writingChanges) return writingChanges;
  if (pendingChanges.count === 0) return Promise.resolve();
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const batch = pendingChanges;
  pendingChanges = noChanges();
  writingChanges = (async () => {
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const row = await db.recommendationState.findUnique({ where: { scope: 'model' } });
        let stored = wholeModel(null);
        if (row) {
          try {
            stored = wholeModel(JSON.parse(row.data) as Partial<GlobalModel>);
          } catch {
            // unreadable — start again from empty rather than fail forever
          }
        }
        addChanges(stored, batch);
        keepStrongestLinks(stored);
        stored.updatedAt = Date.now();
        const data = JSON.stringify(stored);
        let saved = false;
        if (row) {
          saved = (await db.recommendationState.updateMany({ where: { scope: 'model', updatedAt: row.updatedAt }, data: { data } })).count === 1;
        } else {
          saved = await db.recommendationState.create({ data: { scope: 'model', data } }).then(() => true, () => false);
        }
        if (saved) {
          modelWrites += 1;
          addChanges(stored, pendingChanges); // changes that arrived during the write
          modelCopy = { model: stored, at: Date.now() };
          return;
        }
        // Another server wrote first — read again and add on top of theirs.
        await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 120)));
      }
      throw new Error('the stored model kept changing');
    } catch (e) {
      // Not lost: the batch goes back and is written with the next one.
      addChanges(pendingChanges, batch);
      pendingChanges.count += batch.count;
      console.error('recommender model write failed (will retry):', e instanceof Error ? e.message : e);
    } finally {
      writingChanges = null;
      lastModelWrite = Date.now();
      if (pendingChanges.count > 0) scheduleModelWrite();
    }
  })();
  return writingChanges;
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
  const key = subjectKey(input.userId, input.guestId);
  const typeWeight = EVENT_WEIGHTS[input.type] ?? 1;
  addPop(input.productId, input.type === 'view' ? 'v' : input.type === 'purchase' ? 'p' : 'c');
  if (!key) return Promise.resolve();

  return serializedFor(key, async () => {
    const now = Date.now();
    const profile = await loadJSON<SubjectProfile>(key, EMPTY_PROFILE);
    applyDecay(profile.items, profile.updatedAt, now);
    applyDecay(profile.cats, profile.updatedAt, now);
    applyDecay(profile.brands, profile.updatedAt, now);
    applyDecay(profile.bands, profile.updatedAt, now);

    // --- co-preference learning: new item B against existing affinities A ---
    for (const [otherId, weight] of Object.entries(profile.items)) {
      if (otherId === input.productId || weight < 0.05) continue;
      addCo(otherId, input.productId, weight * typeWeight);
      addCo(input.productId, otherId, weight * typeWeight);
    }

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
export async function recordRecFeedback(
  clicked: { productId: string; attribution: Attribution } | null,
  impressions: Attribution[] | null,
  subject: { userId?: string | null; guestId?: string | null },
): Promise<{ weights: Record<string, number> }> {
  if (impressions) {
    for (const attr of impressions) {
      const total = attr.cf + attr.content + attr.pop;
      if (total <= 0) continue;
      if (attr.cf / total >= 0.1) addFeedback('cf', 'impressions', 1);
      if (attr.content / total >= 0.1) addFeedback('content', 'impressions', 1);
      if (attr.pop / total >= 0.1) addFeedback('pop', 'impressions', 1);
    }
  }

  if (clicked && clicked.attribution) {
    const { cf, content, pop } = clicked.attribution;
    const total = cf + content + pop;
    if (total > 0) {
      addFeedback('cf', 'clicks', cf / total);
      addFeedback('content', 'clicks', content / total);
      addFeedback('pop', 'clicks', pop / total);
    }
    // A recommendation click is also a strong interest signal — learn from it.
    const key = subjectKey(subject.userId, subject.guestId);
    if (key) {
      await serializedFor(key, () => applyInteractionToProfile(key, clicked.productId, 'rec_click', Date.now()));
    }
  }

  const model = await readModel();
  return { weights: ensembleWeights(model.feedback) };
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
): Promise<void> {
  const typeWeight = EVENT_WEIGHTS[type] ?? 1;
  const profile = await loadJSON<SubjectProfile>(key, EMPTY_PROFILE);
  applyDecay(profile.items, profile.updatedAt, now);
  applyDecay(profile.cats, profile.updatedAt, now);
  applyDecay(profile.brands, profile.updatedAt, now);
  applyDecay(profile.bands, profile.updatedAt, now);

  for (const [otherId, weight] of Object.entries(profile.items)) {
    if (otherId === productId || weight < 0.05) continue;
    addCo(otherId, productId, weight * typeWeight);
    addCo(productId, otherId, weight * typeWeight);
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
  const model = await readModel();
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
  const model = await readModel();
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
  const guestKey = `guest:${guestId}`;
  const userKey = `user:${userId}`;
  return serializedFor(userKey, async () => {
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
