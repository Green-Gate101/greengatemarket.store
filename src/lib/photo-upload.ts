/**
 * Browser-side photo fitting for uploads (client components only).
 *
 * Vercel refuses any request body over 4.5 MB before the app even runs
 * (413 FUNCTION_PAYLOAD_TOO_LARGE), so a listing with several phone photos
 * (2-6 MB each) could never be sent. Photos are sent untouched whenever they
 * fit; otherwise the largest are re-drawn smaller (long edge 1600 px first —
 * the server stores product photos at 900 px and store images at 1280 px, so
 * nothing visible is lost) until the whole set fits one request.
 *
 * Re-drawing drops the file's metadata, which the server's AI-photo check
 * reads. Each shrunk photo therefore travels with the first bytes of its
 * original file (where EXIF, XMP and content credentials live) for the server
 * to scan the same way.
 */

/** Photo bytes allowed in one request — under Vercel's 4.5 MB with room for the form fields. */
export const UPLOAD_BUDGET_BYTES = 4_000_000;
const META_SAMPLE_BYTES = 128 * 1024;
const STEPS = [
  { side: 1600, quality: 0.85 },
  { side: 1280, quality: 0.8 },
  { side: 1024, quality: 0.75 },
];

export interface FittedPhotos {
  /** Photos to send, in the original order. */
  files: File[];
  /** Original-file samples for the photos that were shrunk (server scans their metadata). */
  metaSamples: Blob[];
}

export async function fitPhotosForUpload(originals: File[], budget = UPLOAD_BUDGET_BYTES): Promise<FittedPhotos> {
  const out = [...originals];
  const shrunk = new Set<number>();
  const total = () => out.reduce((sum, f) => sum + f.size, 0);
  for (const step of STEPS) {
    if (total() <= budget) break;
    // Largest first, so the fewest photos are touched.
    const order = out.map((_, i) => i).sort((a, b) => out[b].size - out[a].size);
    for (const i of order) {
      if (total() <= budget) break;
      const smaller = await shrinkPhoto(originals[i], step.side, step.quality).catch(() => null);
      if (smaller && smaller.size < out[i].size) {
        out[i] = smaller;
        shrunk.add(i);
      }
    }
  }
  if (total() > budget) {
    throw new Error('These photos are too large to upload together. Try fewer photos, or smaller ones.');
  }
  // Copied into fresh blobs: Safari/WebKit uploads a SLICE of a file wrongly
  // (the request body is cut off and the server cannot read the form).
  const metaSamples: Blob[] = [];
  for (const i of [...shrunk].sort((a, b) => a - b)) {
    const bytes = await readBytes(originals[i].slice(0, META_SAMPLE_BYTES));
    metaSamples.push(new Blob([bytes], { type: originals[i].type }));
  }
  return { files: out, metaSamples };
}

function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  // Older browsers (Safari < 14): no Blob.arrayBuffer().
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('This photo could not be read.'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Re-draws a photo as a JPEG no larger than `maxSide` px on its long edge, upright and on white. */
async function shrinkPhoto(file: File, maxSide: number, quality: number): Promise<File | null> {
  const info = file.type === 'image/jpeg' ? await readJpegInfo(file).catch(() => null) : null;
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;
    const orientation = info?.orientation ?? 1;
    const turns = orientation >= 5; // 90° turns swap width and height
    // Current browsers already draw camera photos upright; older ones draw the
    // raw sensor pixels and leave the turn to us. Telling them apart: a turned
    // photo the browser righted reports its frame size swapped.
    let browserTurned = true;
    if (orientation > 1) {
      if (turns && info && info.width && info.height && info.width !== info.height) {
        browserTurned = w === info.height && h === info.width;
      } else {
        browserTurned = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('image-orientation', 'from-image');
      }
    }
    const manual = orientation > 1 && !browserTurned;
    const uprightW = manual && turns ? h : w;
    const uprightH = manual && turns ? w : h;
    const scale = Math.min(1, maxSide / Math.max(uprightW, uprightH));
    const cw = Math.max(1, Math.round(uprightW * scale));
    const ch = Math.max(1, Math.round(uprightH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // JPEG has no transparency — transparent areas become white, as on the server.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    if (manual) {
      switch (orientation) {
        case 2: ctx.transform(-1, 0, 0, 1, cw, 0); break;
        case 3: ctx.transform(-1, 0, 0, -1, cw, ch); break;
        case 4: ctx.transform(1, 0, 0, -1, 0, ch); break;
        case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
        case 6: ctx.transform(0, 1, -1, 0, cw, 0); break;
        case 7: ctx.transform(0, -1, -1, 0, cw, ch); break;
        case 8: ctx.transform(0, -1, 1, 0, 0, ch); break;
      }
      ctx.drawImage(img, 0, 0, turns ? ch : cw, turns ? cw : ch);
    } else {
      ctx.drawImage(img, 0, 0, cw, ch);
    }
    const blob = await canvasToJpeg(canvas, quality);
    if (!blob) return null;
    const name = `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`;
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // decode() unpacks the photo off the main thread where supported, so
    // the screen stays responsive while big photos are redrawn.
    img.onload = () => {
      if (typeof img.decode === 'function') img.decode().then(() => resolve(img), () => resolve(img));
      else resolve(img);
    };
    img.onerror = () => reject(new Error('This photo could not be read.'));
    img.src = src;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
      return;
    }
    // Very old browsers: no toBlob — go through a data URL.
    try {
      const data = canvas.toDataURL('image/jpeg', quality);
      const bin = atob(data.split(',')[1] ?? '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      resolve(new Blob([bytes], { type: 'image/jpeg' }));
    } catch {
      resolve(null);
    }
  });
}

/** EXIF orientation and the stored (unturned) frame size of a JPEG. */
async function readJpegInfo(file: File): Promise<{ orientation: number; width: number; height: number } | null> {
  const v = new DataView(await file.slice(0, 512 * 1024).arrayBuffer());
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let orientation = 1;
  let p = 2;
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) break;
    const marker = v.getUint8(p + 1);
    if (marker === 0xff) { p += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { p += 2; continue; }
    const len = v.getUint16(p + 2);
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(v, p + 4);
    // Start-of-frame (not DHT/JPG/DAC): precision, then height and width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (p + 9 > v.byteLength) break;
      return { orientation, height: v.getUint16(p + 5), width: v.getUint16(p + 7) };
    }
    if (marker === 0xda) break; // image data starts — no frame header found
    p += 2 + len;
  }
  return { orientation, width: 0, height: 0 };
}

function exifOrientation(v: DataView, start: number): number {
  if (start + 14 > v.byteLength || v.getUint32(start) !== 0x45786966) return 1; // "Exif"
  const tiff = start + 6;
  const little = v.getUint16(tiff) === 0x4949;
  const ifd = tiff + v.getUint32(tiff + 4, little);
  if (ifd + 2 > v.byteLength) return 1;
  const count = v.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 10 > v.byteLength) break;
    if (v.getUint16(entry, little) === 0x0112) {
      const o = v.getUint16(entry + 8, little);
      return o >= 1 && o <= 8 ? o : 1;
    }
  }
  return 1;
}
