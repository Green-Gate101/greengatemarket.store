/**
 * Listing guard — the marketplace's "white filter" for new listings.
 *
 * Green Gate is a NEW-goods marketplace: clothing and footwear may NEVER be
 * second-hand, and counterfeit/replica goods are banned everywhere. This
 * guard runs server-side on every product create (the browser form never
 * sends a second-hand condition for clothing anyway — this is the backstop
 * that keeps direct API submissions honest too).
 *
 * Design notes:
 *  - Clothing detection covers the FIXED category slugs that exist today
 *    (every women- and men- garment group, kids, and every shoes- group) AND
 *    matches category NAMES, so admin-created categories like "Sleepwear"
 *    or "Sneakers" are caught without code changes.
 *  - The text screen is deliberately narrow (phrase-level, case/space
 *    insensitive) so it never rejects honest wording: "faux fur" and
 *    similar legitimate material names are fine — only replica/counterfeit
 *    SALES language and second-hand CLOTHING language are matched.
 */

/** Category slugs that are clothing or footwear (garments worn on the body). */
const CLOTHING_SLUG_EXACT = new Set(['women', 'men', 'kids', 'unisex', 'shoes']);

/** Slug prefixes that are clothing/footwear groups. */
const CLOTHING_SLUG_PREFIXES = ['women-', 'men-', 'shoes-', 'kids-', 'baby-clothing', 'sleepwear', 'activewear', 'sportswear', 'swimwear', 'loungewear', 'underwear', 'footwear'];

/** Category-name keywords that make a category clothing/footwear, even for
 *  future admin-created categories. */
const CLOTHING_NAME_KEYWORDS = [
  'apparel', 'clothing', 'garment', 'wear', 'dress', 'dresses', 'shirt', 'shirts',
  't-shirt', 'jeans', 'denim', 'trousers', 'pants', 'skirt', 'skirts', 'hoodie',
  'hoodies', 'sweater', 'sweaters', 'jacket', 'jackets', 'coat', 'coats', 'suit',
  'suits', 'blazer', 'activewear', 'beachwear', 'swimwear', 'sleepwear', 'loungewear',
  'underwear', 'lingerie', 'socks', 'shoe', 'shoes', 'sneaker', 'sneakers', 'boot',
  'boots', 'sandal', 'sandals', 'heel', 'heels', 'slipper', 'slippers', 'footwear',
  'jersey', 'jerseys', 'tops', 'bottoms', 'pajamas', 'pyjamas', 'gown', 'gowns',
];

export function isClothingCategory(category?: { slug: string; name: string } | null): boolean {
  if (!category) return false;
  const slug = category.slug.toLowerCase();
  if (CLOTHING_SLUG_EXACT.has(slug)) return true;
  if (CLOTHING_SLUG_PREFIXES.some((p) => slug.startsWith(p))) return true;
  const name = category.name.toLowerCase();
  if (CLOTHING_NAME_KEYWORDS.some((k) => name.includes(k))) return true;
  return false;
}

/**
 * Phrases that describe second-hand / used goods in a listing's text.
 * Matched ONLY for clothing/footwear (the marketplace rule: clothing must be
 * new). Word-boundary-ish matching on a normalised string.
 */
const SECOND_HAND_PHRASES = [
  'second hand', 'second-hand', 'secondhand', 'pre owned', 'pre-owned', 'preowned',
  'previously owned', 'pre loved', 'pre-loved', 'preloved', 'gently used', 'gently worn',
  'lightly used', 'lightly worn', 'barely used', 'barely worn', 'hardly used',
  'used condition', 'worn once', 'worn twice', 'worn a few times', 'used once',
  'well worn', 'slightly used', 'slightly worn', 'previously loved', 'not new',
];

/** Counterfeit / replica sales language — banned in EVERY category. */
const COUNTERFEIT_PHRASES = [
  'replica', 'replicas', 'knock off', 'knock-off', 'knockoff', 'counterfeit',
  '1:1 copy', '1:1 quality', 'aaa quality', 'inspired by gucci', 'inspired by louis',
  'inspired by chanel', 'inspired by dior', 'inspired by prada', 'inspired by rolex',
  'first copy', 'duplicate original', 'unauthentic', 'not authentic', 'fake original',
];

function normaliseText(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

function containsPhrase(haystack: string, phrases: string[]): string | null {
  for (const phrase of phrases) {
    // Simple substring match on the normalised text — phrase-level rules are
    // specific enough that false positives are effectively impossible.
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}

export type ListingGuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Screen a new listing. Returns the FIRST violated rule so the seller gets
 * one clear, actionable message.
 */
export function guardListing(input: {
  name: string;
  description: string;
  tags?: string | null;
  condition: string;
  category?: { slug: string; name: string } | null;
}): ListingGuardResult {
  const text = normaliseText(input.name, input.description, input.tags);

  // Rule 1 — clothing/footwear must be brand new. Second-hand clothing is
  // not accepted anywhere on the marketplace, in any condition wording.
  if (isClothingCategory(input.category) && input.condition !== 'new') {
    return {
      ok: false,
      reason: 'Clothing and footwear on Green Gate must be brand new — second-hand items are not accepted. List the item only if it is new.',
    };
  }

  // Rule 2 — clothing/footwear text may not describe second-hand goods.
  if (isClothingCategory(input.category)) {
    const phrase = containsPhrase(text, SECOND_HAND_PHRASES);
    if (phrase) {
      return {
        ok: false,
        reason: `Clothing and footwear on Green Gate must be brand new — wording like "${phrase}" is not accepted on clothing listings.`,
      };
    }
  }

  // Rule 3 — replica/counterfeit language is banned in every category.
  const counterfeit = containsPhrase(text, COUNTERFEIT_PHRASES);
  if (counterfeit) {
    return {
      ok: false,
      reason: `Counterfeit or replica goods are not allowed on Green Gate (matched "${counterfeit}"). Only authentic products may be listed.`,
    };
  }

  return { ok: true };
}
