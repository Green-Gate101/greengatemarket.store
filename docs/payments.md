# Payments

## The rule

**Buyers pay only through a payment processor the seller connected** — PayFast, Ozow or
Yoco — or the marketplace's own PayFast account when it is configured. These confirm a
payment within seconds, so an order is confirmed without delay.

Not buyer payment methods (removed on purpose): bank transfer (EFT), pasted payment-page
links, card numbers typed into Green Gate. Seller bank details are still stored, but only
for marketplace payouts.

`storeTakesOnlinePayment(store)` in `src/lib/order-payment-options.ts` is the single gate:

- `POST /api/cart` and `POST /api/checkout` answer **409** for a store without a ready processor;
- the product page shows **"Not available to buy"** (`canBuy: false`);
- order views only show a pay button the processor can actually complete.

## How each processor works

| Processor | Whose account | How the buyer pays | How we know it was paid |
|---|---|---|---|
| PayFast | seller's own (or the marketplace's) | signed form posted to `www.payfast.co.za/eng/process` (top-level page, never framed) | ITN to `/api/payments/payfast/itn`: signature over fields in the order received, merchant id + store binding, amount = order total, then PayFast's own `VALID` confirmation |
| Ozow | seller's own | redirect to the URL from `POST api.ozow.com/postpaymentrequest` | notify to `/api/payments/ozow/notify`: SHA-512 hash check (lower-cased recipe), site code must match the store, `IsTest=true` never pays a live order |
| Yoco | seller's own | Yoco Checkout page | webhook + return: only the checkout id stored on the order is trusted, and Yoco's amount must equal the order total; deployed builds accept live keys only |
| GGPay card | marketplace | — | **hidden and refused on every deployed build** until a real card acquirer is wired. Never remove this guard. |

Every path ends in `settleOrderPayment()` (`src/lib/ggpay.ts`), the one place that marks an
order paid. It is an atomic claim, so a payment can't be counted twice, and a cancelled or
refunded order can't be settled.

**Seller-owned rails do not queue a payout.** The money already went straight into the
seller's own processor account. Only marketplace rails (marketplace PayFast) create a
Payout, for the gross amount less the platform fee (`GG_PLATFORM_FEE_PERCENT`, default 5%).

## Seller setup

Seller dashboard → **Payment details** shows:

- a step-by-step guide per processor (`processor-setup-guide.tsx`), with this site's real notify, return and website links;
- the live status — "Buyers can pay you with: …" — plus plain warnings (missing passphrase, missing API key, test key, and so on).

Secrets are encrypted and never sent back to any browser.

## Never weaken

- PayFast ITN must match the seller's passphrase signature **and** merchant id **and** the order's store.
- Ozow stamps a transaction id only after positive proof.
- Yoco: only the stored checkout id counts, and the amount must match (fail closed when unknown).
- Payouts for cancelled, refunded or returned orders are **on hold** and cannot be paid out.
- Paid orders and their payment records can't be deleted (suspend the account instead).

## Testing

Real money has **not** been moved in testing. Before announcing a processor live, run one
small real payment per processor with a real seller account and refund it.
