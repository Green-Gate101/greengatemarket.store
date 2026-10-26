# Seller subscriptions

Sellers pay Green Gate a subscription to sell. Only the administrator's own store is free
automatically; the administrator can give any other store free access.

## The rules

| | |
|---|---|
| Monthly | **R499** for 1 calendar month |
| Yearly | **R6 999** for 12 calendar months |
| Free trial | **30 days**, once per store, starting the day the store is approved |
| Free access | the administrator's own store, plus any store the admin grants it to (admin console → Subscriptions → "Give free access") |
| Not paid | the store **pauses**: its store page and products are hidden everywhere buyers look, and its listing tools are locked |
| Paying again | brings everything back instantly, and nothing is deleted |

Prices can be changed without code: set `SELLER_PLAN_MONTHLY_CENTS` and/or
`SELLER_PLAN_YEARLY_CENTS` (in cents) in Vercel and redeploy. Note that 12 × R499 = R5 988,
so the yearly plan costs more than paying monthly.

**What a subscription includes** (`SUBSCRIPTION_FEATURES` in `src/lib/subscription.ts`,
shown to sellers before they apply and on their dashboard):
- a store page with logo and banner;
- unlimited listings, with up to 8 photos each;
- automatic white backgrounds for product photos;
- buyers pay the seller directly through their own PayFast, Ozow or Yoco account, with no commission;
- live Courier Guy delivery quotes;
- order management with buyer updates;
- sales analytics;
- placement in search and recommendations;
- protection against AI-generated and counterfeit listings;
- in-app messages with Green Gate.

## How payment works

1. The seller picks a plan in the dashboard. `POST /api/seller/subscription` creates a
   `SubscriptionPayment` (`pending`, reference `SUB-XXXXXXXX`) and a checkout on **Green Gate's
   own Yoco account** (`YOCO_PLATFORM_SECRET_KEY`).
2. The seller pays by card on Yoco's secure page (top-level, never framed).
3. Yoco sends the seller back to `/api/seller/subscription/return?ref=…`. Arriving there proves
   nothing on its own. The server retrieves the checkout stored on that payment from Yoco, and
   credits it only if Yoco reports it paid **with exactly the plan amount**.
4. Crediting is an atomic claim (`settleSubscriptionPayment`), so the return page, the dashboard
   re-check and the daily job can never count one payment twice. The new period starts when the
   current access ends: paying during the trial or a paid period adds time after it, and paying
   after a lapse starts from today.

**If the browser never comes back** (the seller closed the tab), the payment is still found:
- every time the seller opens the dashboard, it re-checks their payments from the last 2 days;
- the daily job re-checks all payments from the last 3 days.

Checkouts left unpaid for 3 days are marked `cancelled`.

There is **no automatic debit**: Yoco's checkout takes one-off payments, so sellers renew by
paying again. They get an in-app reminder 3 days before access ends, and a notice when the
store pauses.

## Where it is enforced

The rule lives in `src/lib/subscription.ts`:
- `sellingStoreWhere()` is a database filter;
- `storeCanSell()` checks a store row already loaded;
- `storeAccess()` returns the state shown to the seller.

**Hidden when not paid:**
- the catalogue and search;
- search suggestions;
- the store directory and store page;
- product pages;
- recommendations;
- adding to cart, wishlist saves, reviews and checkout;
- product and store images;
- the sitemap and the crawlable landing pages.

**Locked for the seller when not paid** (the API answers 402 with a clear message):
- creating and editing listings (`requireSellerTools`);
- the store profile (logo and banner);
- payment and bank settings;
- analytics.

**Always open, even when not paid:**
- orders to fulfil (buyers who already paid must get their goods);
- messages with Green Gate;
- payouts;
- the subscription itself.

## Admin console

**Subscriptions** tab:
- counts of paying, trial, unpaid (paused) and free-access stores;
- revenue this month, in the last 30 days and all time, from confirmed payments only;
- every store with its status, access date, total paid and last payment;
- "Give free access" / "Remove free access" and "Message" per store;
- the newest 300 subscription payments.

**Messages** tab: one text thread per store, with unread counts. Opening a thread or replying
marks the seller's messages as read. Sellers reply from the "Messages with Green Gate" card on
their dashboard and get an in-app notification for every message.

Paid subscription payments are financial records. An account with paid subscriptions can't be
deleted; suspend it instead.

## Daily housekeeping

This runs inside `/api/cron/abandoned-checkouts`, because the Hobby plan allows only two cron
jobs. Adding a third would fail every deploy. Each run it:
- confirms pending payments with Yoco;
- closes stale checkouts;
- sends the 3-day reminder (`billingNotice` makes sure it goes out only once);
- sends the "store paused" notice.

## Testing

`qa/subscription-check.mjs` (42 checks) and `qa/subscription-ui.cjs` (42 checks) run against the
local QA store with a stand-in Yoco (`qa/fake-yoco.cjs`). The QA store reads
`YOCO_API_BASE` and the stand-in key from `qa/.extra-env.json`. `YOCO_API_BASE` is
**ignored on Vercel production builds**, where the app always talks to Yoco itself.
