# Green Gate — internal documentation

Internal handbook for the people (and coding agents) who run and change
Green Gate Marketplace. Start here, then open the page you need.

| Page | What it answers |
|---|---|
| [architecture.md](architecture.md) | How the two apps fit together, where the code lives, the rules that keep it safe |
| [payments.md](payments.md) | How buyers pay (seller processors only), how each processor is wired, what must never change |
| [subscriptions.md](subscriptions.md) | Seller subscriptions (R499/month, R6 999/year, 30-day trial), pausing unpaid stores, free access, admin ↔ seller messages |
| [delivery.md](delivery.md) | The Courier Guy integration: live quotes, how delivery is charged, what is not built yet |
| [images.md](images.md) | Product photos, store logos and banners, white backgrounds, the AI-image guard |
| [operations.md](operations.md) | Deploying both apps, environment variables, monitoring, runbooks for common incidents |
| [devices.md](devices.md) | Old phones, smart TVs and every browser: how support works and how it is tested |
| [testing.md](testing.md) | The local QA store, the test suites, the device lab, what "verified" means here |
| [scale.md](scale.md) | Readiness for 10 million users: what is done, what to do before each growth step |

`CLAUDE.md` in the repository root is the short rule sheet for coding agents;
these pages are the longer explanation for humans. When the two disagree, fix
whichever is wrong in the same change.

## The owner's standing rules

1. **Never break working code.** Changes are additive; working systems are not rewritten.
2. **Nothing fake.** No seeded or invented data, no fake payment approvals, no made-up analytics,
   honest error messages.
3. **Buyers pay only through a payment processor the seller connected** (PayFast, Ozow, Yoco).
   No bank transfers (EFT), no pasted payment links, no card numbers typed into Green Gate.
4. **Every screen works on every device** — down to a 320 px phone and old Samsung/Hisense
   browsers — with no sideways scrolling.
5. **Both apps ship together** (storefront and admin console), and every deploy is verified live.
6. English only.
