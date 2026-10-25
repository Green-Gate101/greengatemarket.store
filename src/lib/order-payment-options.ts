import { payfastSellerReady, ozowSellerReady } from '@/lib/seller-payments';
import { yocoKeyUsable, yocoStoreReady } from '@/lib/yoco';
import { decryptSecret } from '@/lib/secret-box';
import { EFT_STORE_SELECT, type EftDetails } from '@/lib/payments';
import { payfastEnabled } from '@/lib/payfast';

/**
 * The buyer-facing payment options of an order's store — computed from the
 * SAME readiness checks the payment routes enforce, so a button is only ever
 * shown for a rail that can really take the money (a half-configured
 * processor used to show a button that could only fail). Processor secrets
 * and bank columns are stripped; bank details are returned only as `eft`,
 * and only when the caller is the order's buyer and the order awaits payment.
 */

/** Store columns the options need (merge into a Prisma store select). */
export const STORE_PAYMENT_SELECT = {
  payoutProvider: true, payoutLink: true, payoutNote: true,
  payfastMerchantId: true, payfastMerchantKeyEnc: true, payfastPassphraseEnc: true,
  ozowSiteCode: true, ozowPrivateKeyEnc: true, ozowApiKeyEnc: true,
  yocoSecretKey: true,
  ...EFT_STORE_SELECT,
} as const;

const PRIVATE_KEYS = [
  'payfastMerchantId', 'payfastMerchantKeyEnc', 'payfastPassphraseEnc',
  'ozowSiteCode', 'ozowPrivateKeyEnc', 'ozowApiKeyEnc', 'yocoSecretKey',
  'bankName', 'bankAccountHolder', 'bankAccountNumber', 'bankBranchCode', 'bankAccountType',
] as const satisfies readonly (keyof typeof STORE_PAYMENT_SELECT)[];

type PaymentStore = {
  id: string;
  name: string;
  payoutProvider: string | null;
  payfastMerchantId: string | null;
  payfastMerchantKeyEnc: string | null;
  payfastPassphraseEnc: string | null;
  ozowSiteCode: string | null;
  ozowPrivateKeyEnc: string | null;
  ozowApiKeyEnc: string | null;
  yocoSecretKey: string | null;
  bankName: string | null;
  bankAccountHolder: string | null;
  bankAccountNumber: string | null;
  bankBranchCode: string | null;
  bankAccountType: string | null;
};

export type PublicPaymentStore<S> = Omit<S, (typeof PRIVATE_KEYS)[number]> & {
  payfastReady: boolean;
  ozowReady: boolean;
  yocoReady: boolean;
  eft: EftDetails | null;
};

/**
 * Owner's rule: buyers pay ONLY through a payment processor the seller has
 * connected (PayFast, Ozow or Yoco — or the marketplace's own PayFast
 * account when configured). Those confirm instantly; bank transfers (EFT)
 * and pasted payment-page links needed manual confirmation and are no
 * longer offered to buyers.
 */
export function storeTakesOnlinePayment(store: PaymentStore): boolean {
  return payfastSellerReady(store) || ozowSellerReady(store) || yocoStoreReady(store) || payfastEnabled();
}

export function publicPaymentStore<S extends PaymentStore>(
  store: S,
  _order: { status: string; paymentStatus: string },
  _opts: { showEft: boolean },
): PublicPaymentStore<S> {
  const rest: Record<string, unknown> = { ...store };
  for (const k of PRIVATE_KEYS) delete rest[k];
  // No pasted payment-page links for buyers (no instant confirmation).
  if ('payoutLink' in rest) rest.payoutLink = null;
  if ('payoutNote' in rest) rest.payoutNote = null;
  return {
    ...(rest as Omit<S, (typeof PRIVATE_KEYS)[number]>),
    payfastReady: payfastSellerReady(store),
    ozowReady: ozowSellerReady(store),
    yocoReady: yocoStoreReady(store),
    // Bank transfer (EFT) is not a buyer payment method any more.
    eft: null,
  };
}

export interface SellerPaymentStatus {
  /** Ready = buyers are really offered this option at checkout right now. */
  payfastReady: boolean;
  ozowReady: boolean;
  yocoReady: boolean;
  eftReady: boolean;
  /** What buyers can pay this seller with right now, in plain words. */
  available: string[];
  /** Plain-language problems the seller must fix (empty when all is well). */
  warnings: string[];
}

/**
 * The seller's own view of their payment setup — "connected" only when the
 * checkout would actually offer it (the same checks publicPaymentStore and
 * the payment routes enforce), plus what to fix when something is saved but
 * unusable (PayFast without a passphrase, Ozow without an API key, a Yoco
 * test key, unreadable keys, a chosen processor that is not set up).
 */
export function sellerPaymentStatus(store: PaymentStore & { payoutLink?: string | null }): SellerPaymentStatus {
  const payfastReady = payfastSellerReady(store);
  const ozowReady = ozowSellerReady(store);
  const yocoReady = yocoStoreReady(store);
  const eftReady = Boolean(store.bankName?.trim() && store.bankAccountNumber?.trim() && store.bankAccountHolder?.trim());
  const warnings: string[] = [];

  if (store.payfastMerchantId && !payfastReady) {
    if (!decryptSecret(store.payfastMerchantKeyEnc)) warnings.push('PayFast: your saved merchant key can no longer be read — enter your Merchant ID, Merchant key and passphrase again.');
    else if (!decryptSecret(store.payfastPassphraseEnc)) warnings.push('PayFast is saved WITHOUT a passphrase, so buyers cannot pay with PayFast (payments could not be verified). Set a passphrase in PayFast → Settings → Developer Settings, then enter it here and save.');
  }
  if (store.ozowSiteCode && !ozowReady) {
    if (!decryptSecret(store.ozowPrivateKeyEnc)) warnings.push('Ozow: your saved private key can no longer be read — enter your site code, private key and API key again.');
    else if (!decryptSecret(store.ozowApiKeyEnc)) warnings.push('Ozow is saved WITHOUT an API key, so buyers cannot pay with Ozow (Ozow needs it to create a payment). Copy the API key from your Ozow dashboard (Merchants → Merchant Details), enter it here and save.');
  }
  if (store.yocoSecretKey) {
    const key = decryptSecret(store.yocoSecretKey);
    if (!key) warnings.push('Yoco: your saved key can no longer be read — paste your LIVE secret key again.');
    else if (!yocoKeyUsable(key)) warnings.push('Your saved Yoco key is a TEST key (sk_test_…). Test payments move no money, so buyers cannot pay with Yoco until you save your LIVE secret key (sk_live_…).');
  }

  const chosen = store.payoutProvider ?? '';
  const label: Record<string, string> = { payfast: 'PayFast', ozow: 'Ozow', yoco: 'Yoco', mastercard: 'Yoco (Mastercard & Visa)' };
  const chosenReady = chosen === 'payfast' ? payfastReady : chosen === 'ozow' ? ozowReady : chosen === 'yoco' || chosen === 'mastercard' ? yocoReady : true;
  if (label[chosen] && !chosenReady) {
    warnings.push(`You chose ${label[chosen]}, but it is not fully connected yet — buyers are not offered it.`);
  }
  const available = [
    payfastReady && 'PayFast (card / instant EFT)',
    ozowReady && 'Ozow (instant EFT)',
    yocoReady && 'Yoco (Mastercard & Visa)',
  ].filter((x): x is string => Boolean(x));
  if (available.length === 0) {
    warnings.unshift('Buyers CANNOT buy from your store yet — connect PayFast, Ozow or Yoco. Buyers no longer pay by bank transfer (EFT) or a pasted payment link; until a processor is connected, checkout refuses your products.');
  }
  return { payfastReady, ozowReady, yocoReady, eftReady, available, warnings };
}
