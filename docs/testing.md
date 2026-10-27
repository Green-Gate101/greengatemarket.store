# Testing

## What "verified" means here

A change is verified when:

1. type checks and lint are clean in both apps;
2. the local suites pass against a production build of the change;
3. the device lab is green for the pushed commit;
4. both live domains serve the new build and the live checks pass.

Say exactly which of these ran. Never claim a check that did not run.

## The local QA store

A production build (`next build`, standalone) served on `http://localhost:3301` with its own
SQLite database (`db/qa.db`) and three fixed accounts:

| Account | Role |
|---|---|
| `qa-buyer@example.test` | buyer |
| `qa-seller@example.test` | seller, owns "Mama's Kitchen & Home" (PayFast connected) |
| `qa-admin@example.test` | administrator |

The passwords live with the QA scripts, not here. Build environment: `DATABASE_URL=file:<repo>/db/qa.db`,
a local `NEXTAUTH_SECRET`, `NEXTAUTH_URL=http://localhost:3301`. On Windows, copy
`.next/static` and `public` into `.next/standalone/` and sharp's DLLs into
`.next/standalone/node_modules/@img/sharp-win32-x64/lib/`.

Sign-in is limited to 10 attempts per 15 minutes per email and IP. Restart the local server
between suites that sign in many times.

## Suites

| Suite | What it covers |
|---|---|
| API checks | stock with sizes, cart and checkout rules, payment gating, seller edits |
| Screen checks + failure states | every main screen loads; failed loads say so and offer Try again |
| Signed-in sweep | buyer, seller and admin screens on 12 device profiles (Chrome, Safari, Firefox) |
| New-flow checks | sign-in returns to checkout, ended sessions, sellers without a processor, no bank details |
| Branding + courier checks | logo/banner upload rules, white backgrounds, versioned addresses, per-seller delivery quotes |
| UI branding check | Store profile card, store page logo, checkout delivery options — iPhone SE 320 px, Galaxy, desktop Firefox; typing an address key by key sends one quote |
| Admin drills | admin console sign-in, held payouts, failure handling |
| Visual regression | pixel comparison of key screens against the last good build |
| Subscriptions (API + screens) | `qa/subscription-check.mjs`, `qa/subscription-ui.cjs` with a stand-in Yoco: trial, paying, pausing, free access, two payments at once, messages both ways (including long conversations), suggestions while typing |
| Broken request bodies | `qa/bad-body-probe.mjs`: every JSON route answers broken JSON, `null`, a list or a bare value with 400 (never 500); the per-account change ceiling (300/min) |
| Seller applications | `qa/application-check.cjs`: the real six-step form (signature sent and saved), administrators notified, only admins can read an application, the console shows every answer (desktop, two phones, Firefox), Decline with a reason and Approve reach the seller |
| Recommendations at scale | `qa/rec-scale-check.mjs`: a brand-new visitor never inherits another's browsing; 150 simultaneous views are all counted (model and product) through the batched writes |
| Product-event retention | `qa/retention-check.cjs`: the daily cron deletes every kind of event older than 180 days (more than one chunk), keeps newer ones and lifetime view counts, a second run deletes nothing; seller analytics notes the kept days for "This year" (API + phone screen) |
| Live (read-only) | `qa/subscription-live.mjs`, `qa/suggest-live.cjs`, `qa/api-sweep.mjs --live`, `qa/run.cjs <url> --public-only`: nothing written, no accounts |
| Dependency scan | `qa/osv-scan.mjs <appDir>`: every installed package version against the OSV advisory database |
| Device lab (CI) | old Chromium 88–110 on Samsung and Hisense profiles |

The local Firefox runs use the installed Firefox through Playwright's BiDi driver. It needs a
fresh page load per screen because it never reports "load" for a hash-only change.

## Writing a new check

Test what a real person does. For example, type an address one key at a time — the
paste-style `fill` hid a bug where every keystroke sent a delivery quote. Restore any data
the check changes (the visual baselines depend on the QA store staying the same).
