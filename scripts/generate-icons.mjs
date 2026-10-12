/**
 * Generates the complete app-icon set from the Green Gate gate glyph:
 *   public/icon-192.png, public/icon-512.png          — brand tile (any purpose)
 *   public/icon-512-maskable.png                      — maskable (Android adaptive)
 *   public/apple-touch-icon.png                       — 180x180 iOS home screen
 *   public/favicon.ico                                — 16/32/48 multi-size
 * Green tile + white glyph = visible on light AND dark tabs, matching the
 * app launch splash (primary tile + GateMark). Additive assets only.
 */
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'node:fs';

const GREEN = '#16a34a';
const glyph = (stroke) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <path d="M4 28V14C4 8 9 4 16 4s12 4 12 10v14" stroke="${stroke}" stroke-width="2.6" stroke-linecap="square"/>
  <path d="M10 28v-9a6 6 0 0 1 12 0v9" stroke="${stroke}" stroke-width="2.6" stroke-linecap="square"/>
  <path d="M2 28h28" stroke="${stroke}" stroke-width="2.6" stroke-linecap="square"/>
</svg>`;

const tile = (size, glyphFraction) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
     <rect width="${size}" height="${size}" fill="${GREEN}"/>
   </svg>`,
);

async function makeTile(size, glyphFraction) {
  const g = Math.round(size * glyphFraction);
  const glyphBuf = await sharp(Buffer.from(glyph('#ffffff'))).resize(g, g).png().toBuffer();
  return sharp(tile(size, glyphFraction))
    .composite([{ input: glyphBuf, left: Math.round((size - g) / 2), top: Math.round((size - g) / 2) }])
    .png()
    .toBuffer();
}

const [i512, i512m, i192, i180] = await Promise.all([
  makeTile(512, 0.62),
  makeTile(512, 0.5),   // maskable: glyph inside the 80% safe zone
  makeTile(192, 0.62),
  makeTile(180, 0.62),
]);

writeFileSync('public/icon-512.png', i512);
writeFileSync('public/icon-512-maskable.png', i512m);
writeFileSync('public/icon-192.png', i192);
writeFileSync('public/apple-touch-icon.png', i180);

const icoSizes = [16, 32, 48];
const icoPngs = await Promise.all(icoSizes.map((s) => sharp(i512).resize(s, s).png().toBuffer()));
const ico = await pngToIco(icoPngs);
writeFileSync('public/favicon.ico', ico);

console.log('icons generated:', ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png', 'favicon.ico'].join(', '));
