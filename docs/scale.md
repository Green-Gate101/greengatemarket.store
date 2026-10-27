# Scale — readiness for 10 million users

Honest status. "Done" means built and in production. "Before growth" means it must be done
before traffic reaches that level, not that it is broken today.

## Done

- **Hosted Postgres** in production, with indexes on the hot paths: product status +
  created/category, order status + payment status + date, order item product, store status,
  Yoco checkout id. The production build refuses to deploy without it.
- **Small public payloads.** Catalogue, recommendations, store pages and the store directory
  return image addresses (edge-cached files), never image data.
- **Edge caching** of product and store images (a day at the edge); store images carry a
  version so changes show at once.
- **Shared rate limiting** for security-sensitive limits through Upstash Redis
  (`rateLimitShared`), falling back to the in-process limiter if Redis is slow.
- **Every external call has a hard timeout**, and search falls back to the database when Algolia fails.
- **Admin daily figures** are summed in SQL on Postgres instead of loading rows.
- **Bounded queries.** Store directory capped at 200 per page; seller analytics capped at 400 days;
  checkout and delivery quotes cap parcels and cart lines.
- **Delivery quotes** are one request per address (typing pauses first), and the cart's products
  are loaded in one query.
- **Atomic money paths.** Payment settlement, stock decrement, admin payment confirmation and
  order numbers are all safe under concurrent requests. Checkout, card settlement and
  subscription crediting allow a busy database 10 s to hand out a connection and 20 s to finish
  (the library defaults of 2 s / 5 s failed orders under load).
- **No hot rows.** Counters many visitors bump at once — a product's view count, the daily
  API-usage tallies — are added up in memory and written every few seconds
  (`src/lib/batched-counter.ts`). The recommender's shared model is no longer read and rewritten
  twice per product view: each server adds its changes up and writes one batch every few seconds,
  checked against the row's last-changed time so batches from many servers all land
  (`src/lib/recommender.ts`); it keeps the 50 strongest liked-together links per product so it
  stays small. Shoppers' profile updates queue per shopper, not in one queue per server.
- **Edge caching of public answers**: the catalogue, product detail, search suggestions, store
  pages and directory (30 s, then served stale while refreshing), categories and plans (5 min),
  found addresses (1 h). Each server also reuses the recommendation candidate pool for 20 s.
- **Card-sized photos.** `/api/images/<id>?w=160|320|640|960` serves a smaller JPEG (made once,
  edge-cached); product cards, cart, wishlist, suggestions and thumbnails use it
  (`sizedImage` in `src/lib/utils.ts`) — a fraction of the bytes of the full photo.
- **Algolia steps aside** for a minute after a plan-limit, refusal, error or timeout, so searches
  go straight to the database search instead of waiting on Algolia each time.
- **Per-IP limits sized for carrier NAT** (many South African mobile users share one address):
  registration 120/h, reset and verification emails 60/h per IP — per-email limits stay strict.
- **Admin usage figures** read the product-event index on (type, date), not the whole table.
- **Product events are kept for 180 days** (`src/lib/retention.ts`). The daily cron deletes older
  ones in chunks with whatever time is left after the order and subscription jobs (a backlog
  finishes over the next runs). Lifetime figures live elsewhere and stay: a product's total
  views, orders, reviews and the recommender's model. Seller analytics says when a chosen period
  reaches further back than the kept events.

## Before growth (in order)

1. **Vercel plan.** The team is on **Hobby** (checked 27 Oct 2026). Hobby is for non-commercial
   use and has hard monthly limits on function calls and data transfer; when they are used up
   the project is paused. Move to Pro before any launch push: function concurrency and duration,
   cron every minute, usage-based billing instead of a pause. Point an external pinger at the
   system watch until then.
2. **Database plan and pooling.** Production runs on Supabase Postgres (us-east-1, the same
   region as the functions) through the pooled endpoint (`POSTGRES_PRISMA_URL`). A free Supabase
   project has a small database size limit and few pooled connections; every product view
   writes an event row, so size the plan (Pro or above) for storage and peak connections before
   launch, and add read replicas for catalogue reads when needed. (Product events are already
   kept for 180 days only — see Done.)
3. **Images to object storage.** Configure the S3 path in `src/lib/storage.ts` so new photos and
   logos are stored as files instead of database text. Database rows shrink and the image
   routes redirect to the CDN.
4. **Store directory query.** It still reads each store's full logo and banner data from the
   database to build the version. With images in object storage this becomes a short URL.
   Otherwise add a stored image-version column.
5. **Per-IP limits that are still in-process** (delivery quotes, some public routes) count per
   instance. Move them to `rateLimitShared` if abuse appears.
6. **Seller analytics** for very large stores: pre-aggregate daily figures with a scheduled job
   instead of reading orders and views per request.
7. **Search.** Keep Algolia on a paid plan sized for query volume; the database search is a
   fallback, not a primary at that scale.
8. **Email.** Upgrade the Resend plan before order volume passes its free daily limit.
9. **Load test** the checkout and catalogue against a copy of production (never production data)
   before each 10× step.
