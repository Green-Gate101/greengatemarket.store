# Images — product photos, store logos, banners

## Product photos (`src/lib/image-processing.ts`)

Every product photo ends on a white background whenever an honest cut is possible:

1. **Studio cut, built-in.** A flood fill from the photo's edges removes plain or gently
   graded backdrops and contact shadows. The product is then centred on a white square.
   Runs everywhere, free.
2. **remove.bg (optional).** Photos the studio cut declines — busy rooms, textured tables —
   are sent to remove.bg **only when `REMOVE_BG_API_KEY` is set in Vercel**. Each photo uses
   remove.bg credits. remove.bg only removes the background; the product pixels stay the
   seller's real photo. Every use is counted in the admin console's API & billing tab.
3. **AI edit (dev sandbox only).** `aiWhiteBackground` uses the `z-ai-web-dev-sdk`, which needs a
   `.z-ai-config` file. That file exists only in the original development sandbox, **not on
   Vercel**, so in production this step is skipped.
4. **Original.** If nothing above worked, the seller's photo ships as it is, straightened and
   resized. A listing never fails because of background processing.

**In production today, without a remove.bg key**, plain-background photos turn white and
busy-background photos keep their background. Add a remove.bg key to whiten those too.

## AI-image guard (`src/lib/ai-image-guard.ts`)

AI-generated product images are not allowed. Every upload is checked:

- **File forensics** (always on): C2PA content credentials, generator names (Midjourney,
  DALL·E, Stable Diffusion, Firefly, Gemini, Flux, …), diffusion prompt chunks, EXIF/XMP tool
  fields. A match is refused.
- **Visual check** (vision model): uses the same dev-sandbox SDK, so **it does not run on
  Vercel**; uploads pass with the forensics layer only.

Store logos and banners get the forensics layer only (`guardBrandImage`). A logo is a
design, so a "is this a real photo?" check would wrongly refuse it.

## Store logo and banner (`src/lib/store-images.ts`, `POST /api/sellers/branding`)

Sellers add, change or remove both at any time: Seller dashboard → **Store profile**.

- Real JPEG, PNG or WebP files only (checked by file bytes), up to 8 MB; AI signatures are refused.
- Transparent areas become **white**, like the product photos.
- Logo: at most 512 px, JPEG quality 90 with full colour detail (crisp lettering).
- Banner: at most 1600 px wide, JPEG quality 85.
- Only the store owner can change them (buyers 403, guests 401); 30 changes per hour; every change is audited (`store_branding_updated`).
- Public pages load them from `/api/images/store/<storeId>?v=<version>` (and `&kind=banner`). The
  version changes whenever the image changes, so the day-long edge cache can never show
  an old logo.
- The store page shows the **whole** logo (`object-contain` on white). Wide wordmarks used to be cropped.

The logo from the store application is also flattened onto white. Transparent logos
uploaded before October 2026 may have black areas; the seller can simply upload again.

## Serving

`/api/images/<imageId>` and `/api/images/store/<storeId>` turn stored data into real image
files with long cache headers, or redirect when the image lives in object storage (S3). Public
lists carry image addresses, never the image data itself.
