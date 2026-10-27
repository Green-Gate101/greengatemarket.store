/* eslint-disable */
// Device lab: drives an OLD Chromium engine (the one bundled with the
// Playwright Docker image this runs in) through the store with Samsung and
// Hisense phone / smart-TV profiles. Written in ES2017 for the old Node
// versions inside those images. Run by .github/workflows/device-lab.yml.
//
// Usage: node old-device-check.js <baseUrl> <label>
'use strict';
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:3301';
const LABEL = process.argv[3] || 'old-chromium';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const PROFILES = [
  { name: 'samsung-phone', mobile: true, buyer: true, viewport: { width: 360, height: 740 }, scale: 3,
    ua: 'Mozilla/5.0 (Linux; Android 11; SM-A125F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36' },
  { name: 'hisense-phone', mobile: true, buyer: true, viewport: { width: 320, height: 640 }, scale: 2,
    ua: 'Mozilla/5.0 (Linux; Android 10; Hisense Infinity H40 Lite) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.181 Mobile Safari/537.36' },
  { name: 'samsung-tv', mobile: false, buyer: false, viewport: { width: 1920, height: 1080 }, scale: 1,
    ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36' },
  { name: 'hisense-tv', mobile: false, buyer: false, viewport: { width: 1920, height: 1080 }, scale: 1,
    ua: 'Mozilla/5.0 (Linux; VIDAA 6.0; Hisense SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36' },
];

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  [' + LABEL + '] ' + name + (detail ? ' — ' + detail : ''));
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function go(page, hash) {
  await page.goto('about:blank');
  await page.goto(BASE + '/' + hash, { waitUntil: 'load', timeout: 60000 });
  await sleep(3500);
}

/** Styles really applied (layers, colours) and nothing wider than the screen. */
async function layoutState(page) {
  return page.evaluate(function () {
    const header = document.querySelector('header');
    const greens = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (b) {
      const bg = getComputedStyle(b).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return m && +m[2] > +m[1] + 40 && +m[2] > +m[3] + 30; // a green button
    }).length;
    const imgBoxes = Array.prototype.slice.call(document.querySelectorAll('article img, main img')).map(function (i) { return Math.round(i.getBoundingClientRect().height); });
    return {
      headerSticky: !!header && getComputedStyle(header).position === 'sticky',
      greenButtons: greens,
      tallestImage: imgBoxes.length ? Math.max.apply(null, imgBoxes) : -1,
      scrollWidth: document.documentElement.scrollWidth,
      width: window.innerWidth,
      signInToContinue: /Sign in to continue/.test(document.body.innerText),
    };
  });
}

(async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  console.log('engine: Chromium ' + browser.version());
  for (const prof of PROFILES) {
    const context = await browser.newContext({ viewport: prof.viewport, deviceScaleFactor: prof.scale, isMobile: prof.mobile, hasTouch: prof.mobile, userAgent: prof.ua });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', function (e) { errors.push(String(e.message || e).slice(0, 200)); });
    const tag = prof.name + ' (Chromium ' + browser.version() + ')';
    try {
      // Home: the app starts, styles apply, product photos have height.
      await go(page, '#/');
      let s = await layoutState(page);
      await page.screenshot({ path: path.join(SHOTS, LABEL + '__' + prof.name + '__home.png') });
      check(tag + ' · home loads with styles', errors.length === 0 && s.headerSticky && s.scrollWidth <= s.width + 1,
        'sticky=' + s.headerSticky + ' width=' + s.scrollWidth + '/' + s.width + (errors.length ? ' errors: ' + errors.join(' | ') : ''));
      check(tag + ' · product photos visible', s.tallestImage > 50, 'tallest image ' + s.tallestImage + 'px');

      // Product page: the buy button is there, green and enabled.
      errors.length = 0;
      await go(page, '#/product/qa-steel-kettle-1a2b3c4d');
      s = await layoutState(page);
      const buy = await page.evaluate(function () {
        const b = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (x) { return /Add to Cart/i.test(x.innerText); })[0];
        return b ? { disabled: b.disabled, bg: getComputedStyle(b).backgroundColor } : null;
      });
      await page.screenshot({ path: path.join(SHOTS, LABEL + '__' + prof.name + '__product.png') });
      check(tag + ' · product page buy button', !!buy && !buy.disabled && s.greenButtons > 0 && errors.length === 0,
        JSON.stringify(buy) + (errors.length ? ' errors: ' + errors.join(' | ') : ''));

      if (prof.buyer) {
        // Sign in → add to cart → checkout → pay with the seller's processor.
        errors.length = 0;
        await go(page, '#/signin');
        // Like a real shopper: answer the cookie banner first (on a 320px
        // screen it covers the bottom of the form until it is answered).
        await page.evaluate(function () {
          const b = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (x) { return /Decline optional/.test(x.innerText); })[0];
          if (b) b.click();
        });
        await sleep(500);
        await page.fill('#auth-email', 'qa-buyer@example.test');
        await page.fill('#auth-password', 'BuyerPass123');
        await page.click('form button[type="submit"]:not([aria-label])');
        let signedIn = false;
        for (let i = 0; i < 20 && !signedIn; i++) {
          await sleep(1000);
          signedIn = await page.evaluate(function () {
            return fetch('/api/auth/me').then(function (r) { return r.json(); }).then(function (d) { return !!d.user; });
          });
        }
        check(tag + ' · buyer signs in', signedIn, errors.join(' | '));
        await go(page, '#/product/qa-steel-kettle-1a2b3c4d');
        await page.evaluate(function () {
          const b = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (x) { return /Add to Cart/i.test(x.innerText); })[0];
          if (b) b.click();
        });
        await sleep(2500);
        await go(page, '#/account');
        await page.waitForSelector('#co-phone', { timeout: 30000 });
        await page.fill('#co-phone', '0821234567');
        await page.fill('#co-address', '12 Long Street, Durban Central, 4001');
        await sleep(3000);
        // The checkout screen itself: signed in, nothing wider than the screen.
        s = await layoutState(page);
        await page.screenshot({ path: path.join(SHOTS, LABEL + '__' + prof.name + '__checkout.png') });
        // "Place order & pay" goes straight to the seller's PayFast page
        // (stood in for here, so the lab needs no outside site).
        let paid = '';
        await page.route(/payfast\.co\.za/, function (route) {
          if (!paid) paid = route.request().url();
          return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>PayFast</title><p>PayFast test page</p>' });
        });
        await page.evaluate(function () {
          const b = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function (x) { return /Place order/.test(x.innerText); })[0];
          if (b) b.click();
        });
        for (let i = 0; i < 30 && !paid; i++) await sleep(1000);
        check(tag + ' · Place order & pay opens the seller\'s PayFast payment', !!paid && !s.signInToContinue && s.scrollWidth <= s.width + 1 && errors.length === 0,
          'opened=' + (paid ? paid.slice(0, 45) : 'no') + ' signInToContinue=' + s.signInToContinue + ' width=' + s.scrollWidth + '/' + s.width + (errors.length ? ' errors: ' + errors.join(' | ') : ''));
      }
    } catch (e) {
      check(tag + ' · flow', false, String(e.message || e).split('\n')[0]);
    }
    await context.close();
  }
  await browser.close();
  console.log('==== [' + LABEL + '] ' + pass + '/' + (pass + fail) + ' checks passed ====');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
