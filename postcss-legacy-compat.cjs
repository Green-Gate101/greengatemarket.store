/**
 * PostCSS step that runs AFTER Tailwind: makes the stylesheet work on older
 * browsers (Samsung Internet / Android WebView / smart-TV browsers based on
 * Chromium 69-110, as found on many Samsung and Hisense devices) WITHOUT
 * changing what modern browsers render.
 *
 * Tailwind 4 targets Chrome 111+. On older engines:
 *  1. Cascade layers (@layer, Chrome 99+) are ignored, so the WHOLE stylesheet
 *     was dropped below Chrome 99 → layers are unwrapped (source order kept;
 *     only colour variables live outside the layers, so nothing changes rank).
 *  2. Tinted colours (bg-primary/15 …) use color-mix() (Chrome 111+) and fell
 *     back to the SOLID colour → unreadable badges and black overlays. The
 *     fallback becomes a real see-through colour: rgb(var(--x-rgb) / 15%),
 *     with --x-rgb triplets generated next to every colour variable.
 *  3. translate / rotate / scale properties (Chrome 104+) → a transform
 *     fallback inside @supports not (translate: 0) (dialogs stay centred).
 *  4. inset (Chrome 87+) → top/right/bottom/left before it (overlays cover).
 *  5. @property initial values (Chrome 85+) → the existing Safari/Firefox
 *     fallback block is applied unconditionally (same values, lowest rank).
 * Modern browsers keep using the original declarations: every fallback is
 * either overridden by the next declaration or guarded by @supports.
 */

/* ---------- colour maths: any CSS colour → sRGB 0-255 triplet ---------- */
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ].map(clamp255);
}
function labToRgb(L, a, b) {
  // CIE Lab (D50) → XYZ D50 → XYZ D65 → linear sRGB
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const e = 216 / 24389, k = 24389 / 27;
  const xr = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
  const yr = L > k * e ? ((L + 16) / 116) ** 3 : L / k;
  const zr = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
  const X50 = xr * 0.3457 / 0.3585, Y50 = yr, Z50 = zr * (1 - 0.3457 - 0.3585) / 0.3585;
  const X = 0.9554734527042182 * X50 - 0.023098536874261423 * Y50 + 0.0632593086610217 * Z50;
  const Y = -0.028369706963208136 * X50 + 1.0099954580058226 * Y50 + 0.021041398966943008 * Z50;
  const Z = 0.012314001688319899 * X50 - 0.020507696433477912 * Y50 + 1.3303659366080753 * Z50;
  return [
    toSrgb(3.2409699419045226 * X - 1.537383177570094 * Y - 0.4986107602930034 * Z),
    toSrgb(-0.9692436362808796 * X + 1.8759675015077202 * Y + 0.04155505740717559 * Z),
    toSrgb(0.05563007969699366 * X - 0.20397695888897652 * Y + 1.0569715142428786 * Z),
  ].map(clamp255);
}
const num = (t, pctScale = 1) => (t.endsWith('%') ? (parseFloat(t) / 100) * pctScale : parseFloat(t));
const hue = (t) => (t.endsWith('turn') ? parseFloat(t) * 360 : t.endsWith('rad') ? (parseFloat(t) * 180) / Math.PI : parseFloat(t));

function colorToTriplet(value) {
  const v = value.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = v.match(/^(oklch|oklab|lab|lch|rgba?)\(([^)]*)\)$/);
  if (!m) return null;
  const parts = m[2].split('/')[0].trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3 || parts.some((p) => p === 'none' || p.startsWith('var'))) return null;
  const [p0, p1, p2] = parts;
  switch (m[1]) {
    case 'oklch': { const L = num(p0), C = num(p1, 0.4), H = (hue(p2) * Math.PI) / 180; return oklabToRgb(L, C * Math.cos(H), C * Math.sin(H)); }
    case 'oklab': return oklabToRgb(num(p0), num(p1, 0.4), num(p2, 0.4));
    case 'lab': return labToRgb(num(p0, 100), num(p1, 125), num(p2, 125));
    case 'lch': { const L = num(p0, 100), C = num(p1, 150), H = (hue(p2) * Math.PI) / 180; return labToRgb(L, C * Math.cos(H), C * Math.sin(H)); }
    default: return [p0, p1, p2].map((t) => (t.endsWith('%') ? Math.round((parseFloat(t) / 100) * 255) : Math.round(parseFloat(t))));
  }
}

/* ---------- helpers ---------- */
/** Space-separated values at depth 0. Tailwind's output is already minified,
 *  so back-to-back functions ("var(--a)var(--b)") are split too. */
function splitTopLevel(value) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
    if (ch === ')') {
      depth--;
      if (depth === 0) { out.push(cur); cur = ''; }
    }
  }
  if (cur) out.push(cur);
  return out;
}
const withDefault = (token, dflt) => token.replace(/var\((--[\w-]+)\)/g, `var($1, ${dflt})`);
function insideKeyframes(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'atrule' && /keyframes$/i.test(p.name)) return true;
  return false;
}

const plugin = () => ({
  postcssPlugin: 'greengate-legacy-compat',
  OnceExit(root, { postcss }) {
    // 1. --x-rgb triplets next to every colour variable (both themes).
    const rgbVars = new Set();
    root.walkDecls(/^--/, (decl) => {
      if (decl.prop.endsWith('-rgb')) return;
      const t = colorToTriplet(decl.value);
      if (!t || t.some((x) => !Number.isFinite(x))) return;
      decl.cloneAfter({ prop: `${decl.prop}-rgb`, value: t.join(' ') });
      rgbVars.add(decl.prop);
    });

    // 2. color-mix(…, var(--x) NN%, transparent) → see-through fallback.
    root.walkAtRules('supports', (at) => {
      if (!/color-mix\(/.test(at.params)) return;
      at.walkDecls((decl) => {
        const m = decl.value.match(/^color-mix\(in [a-z]+\s*,\s*var\((--[\w-]+)\)\s*([\d.]+)%\s*,\s*transparent\s*\)$/i);
        if (!m || !rgbVars.has(m[1])) return;
        const fallbackValue = `rgb(var(${m[1]}-rgb) / ${m[2]}%)`;
        const sel = decl.parent && decl.parent.selector;
        let sib = at.prev();
        for (let i = 0; sib && i < 4; i++, sib = sib.prev()) {
          if (sib.type === 'rule' && sib.selector === sel) {
            let done = false;
            sib.walkDecls(decl.prop, (fd) => { if (/^var\(--[\w-]+\)$/.test(fd.value.trim())) { fd.value = fallbackValue; done = true; } });
            if (done) return;
          }
        }
        // No matching fallback rule: add one just before the @supports block.
        if (sel) at.before(postcss.rule({ selector: sel, nodes: [postcss.decl({ prop: decl.prop, value: fallbackValue })] }));
      });
    });

    // 3. Unwrap cascade layers (keep order); apply the @property fallback block.
    root.walkAtRules('layer', (at) => {
      if (!at.nodes) { at.remove(); return; }
      if (at.params.trim() === 'properties') {
        at.each((child) => { if (child.type === 'atrule' && child.name === 'supports') child.replaceWith(child.nodes || []); });
      }
      at.replaceWith(at.nodes);
    });

    // 4. inset → physical sides first (modern browsers apply inset after).
    root.walkDecls(/^inset(-inline|-block)?$/, (decl) => {
      if (insideKeyframes(decl)) return;
      const v = splitTopLevel(decl.value);
      const sides = decl.prop === 'inset-inline' ? { left: v[0], right: v[1] || v[0] }
        : decl.prop === 'inset-block' ? { top: v[0], bottom: v[1] || v[0] }
        : v.length === 1 ? { top: v[0], right: v[0], bottom: v[0], left: v[0] }
        : v.length === 2 ? { top: v[0], right: v[1], bottom: v[0], left: v[1] }
        : v.length === 3 ? { top: v[0], right: v[1], bottom: v[2], left: v[1] }
        : { top: v[0], right: v[1], bottom: v[2], left: v[3] };
      for (const [prop, value] of Object.entries(sides)) decl.cloneBefore({ prop, value });
    });

    // 5. Individual transform properties → transform fallback (old engines only).
    root.walkRules((rule) => {
      if (insideKeyframes(rule)) return;
      const parts = [];
      rule.each((d) => {
        if (d.type !== 'decl' || d.value.trim() === 'none') return;
        const t = splitTopLevel(d.value);
        if (d.prop === 'translate') parts[0] = t.length === 1 ? `translate(${withDefault(t[0], 0)})` : t.length === 2 ? `translate(${withDefault(t[0], 0)}, ${withDefault(t[1], 0)})` : `translate3d(${t.map((x) => withDefault(x, 0)).join(', ')})`;
        if (d.prop === 'rotate' && t.length === 1) parts[1] = `rotate(${withDefault(t[0], '0deg')})`;
        if (d.prop === 'scale') parts[2] = t.length === 1 ? `scale(${withDefault(t[0], 1)})` : `scale(${withDefault(t[0], 1)}, ${withDefault(t[1], 1)})`;
      });
      const transform = parts.filter(Boolean).join(' ');
      if (!transform) return;
      const guard = postcss.atRule({ name: 'supports', params: 'not (translate: 0)' });
      guard.append(postcss.rule({ selector: rule.selector, nodes: [postcss.decl({ prop: 'transform', value: transform })] }));
      rule.after(guard);
    });
  },
});
plugin.postcss = true;
module.exports = plugin;
