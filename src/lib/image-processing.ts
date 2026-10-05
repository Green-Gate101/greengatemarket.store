import sharp from 'sharp';

/**
 * Automatic product photo background removal + white background composite.
 *
 * Strategy: flood-fill region growing from the image borders.
 * 1. Sample the border pixels to estimate the existing background colour.
 * 2. Grow a background region inward: a pixel joins the region when it is
 *    locally continuous with a background neighbour AND globally within a
 *    tolerance of the border estimate. This handles solid and gently
 *    gradient studio backgrounds.
 * 3. Make the region transparent, trim it, and composite the subject on a
 *    clean white square canvas with padding — every product ships with a
 *    consistent white studio background.
 */

const SEED_TOLERANCE = 58; // distance from border estimate to start a fill
const LOCAL_TOLERANCE = 22; // continuity between neighbouring background pixels
const GLOBAL_TOLERANCE = 60; // absolute ceiling vs. border estimate — must stay below the closest product colour

function dist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export interface ProcessedImage {
  buffer: Buffer;
  dataUrl: string;
}

export async function processProductImage(input: Buffer): Promise<ProcessedImage> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize(900, 900, { fit: 'inside', withoutEnlargement: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const px = new Uint8ClampedArray(data);
  const at = (x: number, y: number) => (y * width + x) * channels;

  // Estimate the background colour from a 2px border band.
  let br = 0, bg = 0, bb = 0, bn = 0;
  const band = 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < band || y < band || x >= width - band || y >= height - band) {
        const i = at(x, y);
        br += px[i]; bg += px[i + 1]; bb += px[i + 2]; bn++;
      }
    }
  }
  br = Math.round(br / bn);
  bg = Math.round(bg / bn);
  bb = Math.round(bb / bn);

  // BFS flood fill from the borders inward.
  const mask = new Uint8Array(width * height); // 1 = background
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * width + x;
    if (mask[p]) return;
    const i = p * channels;
    if (dist(px[i], px[i + 1], px[i + 2], br, bg, bb) <= SEED_TOLERANCE) {
      mask[p] = 1;
      queue.push(p);
    }
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }

  let head = 0;
  while (head < queue.length) {
    const p = queue[head++];
    const x = p % width;
    const y = (p - x) / width;
    const ci = p * channels;
    const neighbours = [
      [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
    ] as const;
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const np = ny * width + nx;
      if (mask[np]) continue;
      const ni = np * channels;
      const local = dist(px[ni], px[ni + 1], px[ni + 2], px[ci], px[ci + 1], px[ci + 2]);
      const global = dist(px[ni], px[ni + 1], px[ni + 2], br, bg, bb);
      if (local <= LOCAL_TOLERANCE && global <= GLOBAL_TOLERANCE) {
        mask[np] = 1;
        queue.push(np);
      }
    }
  }

  // Gradient fill: studio backdrops often fall off towards a darker hue at the
  // corners, out of reach of the border estimate. Grow from the already-masked
  // region along smooth, same-hue gradients only. Products are protected
  // because they differ in hue, sit outside the brightness window, or are too
  // low-saturation for hue to be meaningful.
  const rgbToHsv = (r: number, g: number, b: number): [number, number, number] => {
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf);
    const min = Math.min(rf, gf, bf);
    const d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === rf) h = ((gf - bf) / d) % 6;
      else if (max === gf) h = (bf - rf) / d + 2;
      else h = (rf - gf) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return [h, max === 0 ? 0 : d / max, max];
  };
  const [bgHue, bgSat, bgVal] = rgbToHsv(br, bg, bb);
  if (bgSat > 0.08) {
    let fillHead = 0;
    for (let p = 0; p < width * height; p++) if (mask[p]) queue.push(p);
    while (fillHead < queue.length) {
      const p = queue[fillHead++];
      const x = p % width;
      const y = (p - x) / width;
      const ci = p * channels;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (mask[np]) continue;
        const ni = np * channels;
        const local = dist(px[ni], px[ni + 1], px[ni + 2], px[ci], px[ci + 1], px[ci + 2]);
        if (local > 14) continue;
        const [h, s, v] = rgbToHsv(px[ni], px[ni + 1], px[ni + 2]);
        if (s < 0.15) continue;
        let dh = Math.abs(h - bgHue);
        if (dh > 0.5) dh = 1 - dh;
        if (dh > 0.06) continue;
        if (v < bgVal * 0.12 || v > bgVal * 1.06) continue;
        mask[np] = 1;
        queue.push(np);
      }
    }
  }

  // Second pass: absorb contact shadows. A shadow is the background colour
  // darkened by a brightness factor, and it always touches the
  // already-detected background region, so it can never eat into the product.
  // Only darkening scales are considered: brightening would match light
  // product surfaces adjacent to the background.
  const SCALES = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

  const matchesShadow = (i: number) => {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const [, s, v] = rgbToHsv(r, g, b);
    // Hue guard: a darkened backdrop keeps the backdrop hue. Without this,
    // products that merely match "background × brightness" (dark green on
    // light yellow) would be absorbed.
    if (s >= 0.15) {
      const [h] = rgbToHsv(r, g, b);
      let dh = Math.abs(h - bgHue);
      if (dh > 0.5) dh = 1 - dh;
      if (dh > 0.09) return false;
    } else if (v > bgVal * 0.55) {
      return false;
    }
    for (const sc of SCALES) {
      if (dist(r, g, b, br * sc, bg * sc, bb * sc) <= 24) return true;
    }
    return false;
  };

  let shadowHead = 0;
  for (let p = 0; p < width * height; p++) {
    if (!mask[p]) continue;
    queue.push(p); // reuse the queue as the shadow-region frontier
  }
  while (shadowHead < queue.length) {
    const p = queue[shadowHead++];
    const x = p % width;
    const y = (p - x) / width;
    const neighbours = [
      [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
    ] as const;
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const np = ny * width + nx;
      if (mask[np]) continue;
      if (matchesShadow(np * channels)) {
        mask[np] = 1;
        queue.push(np);
      }
    }
  }

  // Global cleanup: enclosed background (visible through handle gaps, between
  // straps) never touches the border, so the flood fill can't reach it. Pixels
  // closely matching the background colour — directly or darkened — are
  // removed regardless of connectivity.
  for (let p = 0; p < width * height; p++) {
    if (mask[p]) continue;
    const i = p * channels;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (dist(r, g, b, br, bg, bb) <= 40) {
      mask[p] = 1;
      continue;
    }
    for (const s of [0.5, 0.7, 0.85]) {
      if (dist(r, g, b, br * s, bg * s, bb * s) <= 20) {
        mask[p] = 1;
        break;
      }
    }
  }

  // Median filter on the alpha mask: dissolves dithered half-tone remnants and
  // ragged edges left by noisy gradients in a simultaneous pass, without
  // shifting hard product silhouettes the way iterative dilate/erode would.
  let alpha = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) alpha[p] = mask[p] ? 255 : 0;
  const window = new Uint8Array(9);
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(width - 1, Math.max(0, x + dx));
            window[n++] = alpha[yy * width + xx];
          }
        }
        // insertion sort of 9 samples
        for (let i = 1; i < 9; i++) {
          const v = window[i];
          let j = i - 1;
          while (j >= 0 && window[j] > v) { window[j + 1] = window[j]; j--; }
          window[j + 1] = v;
        }
        next[y * width + x] = window[4];
      }
    }
    alpha = next;
  }
  for (let p = 0; p < width * height; p++) mask[p] = alpha[p] >= 128 ? 1 : 0;

  // Enclosed background regions: gradient patches of the original backdrop can
  // survive inside gaps (between straps, under handles) where they never touch
  // the border. Components are labelled after breaking the thin antialiased
  // bridges that tie backdrop remnants to the product silhouette, so a gap
  // gradient forms its own component and can be removed without touching the
  // product.
  const skipLabel = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (mask[p]) continue;
      let nearMask = false;
      for (let dy = -2; dy <= 2 && !nearMask; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (mask[yy * width + xx]) { nearMask = true; break; }
        }
      }
      if (nearMask) skipLabel[p] = 1;
    }
  }

  const label = new Int32Array(width * height).fill(-1);
  const componentQueue: number[] = [];
  let componentCount = 0;
  for (let p = 0; p < width * height; p++) {
    if (mask[p] || skipLabel[p] || label[p] !== -1) continue;
    const id = componentCount++;
    label[p] = id;
    componentQueue.length = 0;
    componentQueue.push(p);
    let head = 0;
    while (head < componentQueue.length) {
      const cur = componentQueue[head++];
      const x = cur % width;
      const y = (cur - x) / width;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (mask[np] || skipLabel[np] || label[np] !== -1) continue;
        label[np] = id;
        componentQueue.push(np);
      }
    }
  }
  const compSize = new Int32Array(componentCount);
  const compR = new Float64Array(componentCount);
  const compG = new Float64Array(componentCount);
  const compB = new Float64Array(componentCount);
  const compBorder = new Uint8Array(componentCount);
  for (let p = 0; p < width * height; p++) {
    if (mask[p] || skipLabel[p]) continue;
    const id = label[p];
    compSize[id]++;
    const i = p * channels;
    compR[id] += px[i]; compG[id] += px[i + 1]; compB[id] += px[i + 2];
    const x = p % width;
    const y = (p - x) / width;
    if (x < 3 || y < 3 || x >= width - 3 || y >= height - 3) compBorder[id] = 1;
  }
  for (let id = 0; id < componentCount; id++) {
    if (compBorder[id] || compSize[id] < 30) continue;
    const avgR = compR[id] / compSize[id];
    const avgG = compG[id] / compSize[id];
    const avgB = compB[id] / compSize[id];
    if (dist(avgR, avgG, avgB, br, bg, bb) > 80) continue;
    for (let p = 0; p < width * height; p++) {
      if (mask[p]) continue;
      if (label[p] === id) { mask[p] = 1; continue; }
      if (skipLabel[p]) {
        // Halo: blend pixels bridging the removed region and its surroundings.
        const x = p % width;
        const y = (p - x) / width;
        let touches = false;
        for (let dy = -1; dy <= 1 && !touches; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            if (label[yy * width + xx] === id) { touches = true; break; }
          }
        }
        if (!touches) continue;
        const i = p * channels;
        if (dist(px[i], px[i + 1], px[i + 2], br, bg, bb) <= 110) mask[p] = 1;
      }
    }
  }

  // Zero the alpha of the background region.
  for (let p = 0; p < width * height; p++) {
    if (mask[p]) px[p * channels + 3] = 0;
  }

  // Trim transparent margins, then composite centred on a white square canvas.
  const trimmed = await sharp(px, { raw: { width, height, channels: 4 } })
    .png()
    .trim({ threshold: 0 })
    .toBuffer();

  const meta = await sharp(trimmed).metadata();
  const tw = meta.width ?? width;
  const th = meta.height ?? height;
  const pad = Math.round(Math.max(tw, th) * 0.07);
  const canvas = Math.max(tw, th) + pad * 2;

  const output = await sharp({
    create: { width: canvas, height: canvas, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: trimmed, gravity: 'centre' }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();

  return { buffer: output, dataUrl: `data:image/jpeg;base64,${output.toString('base64')}` };
}
