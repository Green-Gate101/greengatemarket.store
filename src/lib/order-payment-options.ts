import { payfastSellerReady, ozowSellerReady } from '@/lib/seller-payments';
import { yocoStoreReady } from '@/lib/yoco';
import { eftDetailsFor, EFT_STORE_SELECT, type EftDetails } from '@/lib/payments';

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

export function publicPaymentStore<S extends PaymentStore>(
  store: S,
  order: { status: string; paymentStatus: string },
  opts: { showEft: boolean },
): PublicPaymentStore<S> {
  const rest: Record<string, unknown> = { ...store };
  for (const k of PRIVATE_KEYS) delete rest[k];
  return {
    ...(rest as Omit<S, (typeof PRIVATE_KEYS)[number]>),
    payfastReady: payfastSellerReady(store),
    ozowReady: ozowSellerReady(store),
    yocoReady: yocoStoreReady(store),
    eft: opts.showEft ? eftDetailsFor(store, order) : null,
  };
}
