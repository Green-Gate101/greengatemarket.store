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
  order numbers are all safe under concurrent requests.

## Before growth (in order)

1. **Vercel plan.** Move from Hobby to Pro: function concurrency and duration, cron every minute,
   and no Hobby fair-use limits. Point an external pinger at the system watch until then.
2. **Database connection pooling.** Use the pooled endpoint (`POSTGRES_PRISMA_URL`, PgBouncer)
   for serverless traffic — already the runtime default. Size the Postgres plan for peak
   connections, and add read replicas for catalogue reads when needed.
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
