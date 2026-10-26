# Every device — old phones, smart TVs, every browser

## What is supported

`package.json` → `browserslist`: Chrome / Android 69+, Samsung Internet 10+, Edge 79+,
Firefox 78+, Safari / iOS 12.1+ (12.2+ on iPhone), Opera 56+. That covers older Samsung and
Hisense phones, Android WebViews, and the Samsung Tizen and Hisense VIDAA TV browsers.

Screens must fit a **320 px** wide phone with no sideways scroll.

## How it works

- **JavaScript.** Next.js would target Chrome 111+ by default. The browserslist makes the build
  produce ES2019, and `src/app/layout.tsx` adds small ES5 polyfills before the app starts
  (`LEGACY_POLYFILLS`). Check after a build:
  `npx es-check es2019 ".next/static/**/*.js"`.
- **CSS.** `postcss-legacy-compat.cjs` (after Tailwind) unwraps `@layer` (old Chromium ignored the
  whole stylesheet), gives colours an RGB fallback for see-through tints, and adds `transform`
  and `top/left` fallbacks. Modern browsers render pixel-identically.
- **Product photo boxes** stay square without `aspect-ratio` (`globals.css`).
- **Browser APIs** are feature-detected (`typeof IntersectionObserver === 'undefined'`, …).
- Two-column layouts use `[&>*]:min-w-0`; long button labels wrap.

## How it is tested

- **Device lab** (`.github/workflows/device-lab.yml`, every push to `main`) builds the store, seeds
  a throwaway shop and drives it with old Chromium engines (88–110) using Samsung and Hisense
  phone and TV profiles: the app starts, styles apply, photos show, a buyer signs in and
  reaches the seller's PayFast payment. **A red run means older devices broke — fix before shipping.**
- **Local suites** run modern Chrome, Safari (WebKit) and Firefox at phone and desktop sizes —
  see [testing.md](testing.md).
- **Visual regression** compares screenshots pixel by pixel with the last good build.
