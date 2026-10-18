#!/usr/bin/env node
/**
 * Green Gate — deploy the standalone Admin Console to Vercel.
 *
 * Deploys ONLY the admin-console/ subtree (uploaded with paths relative to
 * admin-console/ so Vercel builds the console app itself, not the marketplace).
 * Target project: greengate-admin-console — Git-connected to
 * github.com/Green-Gate101/greengate-admin-console and serving the custom
 * domain admin.greengatemarket.store (git pushes auto-deploy; this script is
 * the manual fallback).
 *
 * Usage:
 *   VERCEL_TOKEN=... node scripts/deploy-admin-rest.mjs
 *   VERCEL_TOKEN=... VERCEL_TEAM=team_xxx MAIN_SITE_URL=https://www.greengatemarket.store node scripts/deploy-admin-rest.mjs
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = process.env.VERCEL_TOKEN;
const PROJECT = process.env.VERCEL_PROJECT || 'greengate-admin-console';
const TEAM = process.env.VERCEL_TEAM || '';
const MAIN_URL = process.env.MAIN_SITE_URL || 'https://www.greengatemarket.store';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = join(REPO, 'admin-console');
const BASE = 'https://api.vercel.com';
const Q = TEAM ? `?teamId=${TEAM}` : '';

if (!TOKEN) { console.error('✗ VERCEL_TOKEN is required'); process.exit(1); }

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 300)}`);
  return data;
}

// 1. Collect tracked files under admin-console/ (paths relative to the app root)
const rel = (p) => relative(APP_ROOT, p);
const paths = execSync('git ls-files admin-console', { cwd: REPO, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).map(rel).filter(Boolean);
if (paths.length === 0) {
  console.error('✗ No tracked files under admin-console/ — commit the console first (git add admin-console).');
  process.exit(1);
}
const files = paths.map((p) => {
  const buf = readFileSync(join(APP_ROOT, p));
  return { file: p, sha: createHash('sha1').update(buf).digest('hex'), size: buf.length, buf };
});
console.log(`collected ${files.length} admin-console files`);

// 2. Upload (idempotent)
let done = 0, failed = 0;
async function upload(f) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/v2/files`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/octet-stream',
          'x-now-digest': f.sha,
          'x-now-size': String(f.size),
        },
        body: f.buf,
      });
      if (res.ok || res.status === 409) return true;
      console.log(`  warn ${f.file}: ${res.status} (attempt ${attempt})`);
    } catch (e) { console.log(`  warn ${f.file}: ${e.message.slice(0, 80)} (attempt ${attempt})`); }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return false;
}
const POOL = 10;
let idx = 0;
async function worker() {
  while (idx < files.length) {
    const f = files[idx++];
    if (await upload(f)) { done++; if (done % 25 === 0) console.log(`  uploaded ${done}/${files.length}`); }
    else failed++;
  }
}
await Promise.all(Array.from({ length: POOL }, worker));
console.log(`uploads complete: ${done}/${files.length}${failed ? ` (${failed} FAILED)` : ''}`);
if (failed > 0) process.exit(1);

// 3. Ensure MAIN_SITE_URL exists for production (only adds when missing)
try {
  const envs = await api(`/v9/projects/${PROJECT}/env${Q}`);
  const has = (envs.envs ?? []).some((e) => e.key === 'MAIN_SITE_URL' && (e.target ?? []).includes('production'));
  if (!has) {
    await api(`/v9/projects/${PROJECT}/env${Q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'MAIN_SITE_URL', value: MAIN_URL, type: 'encrypted', target: ['production', 'preview'] }),
    });
    console.log(`+ MAIN_SITE_URL=${MAIN_URL} added to ${PROJECT}`);
  } else {
    console.log('= MAIN_SITE_URL already set');
  }
} catch (e) {
  console.log(`  note: env check failed (${String(e).slice(0, 140)}) — the console defaults to ${MAIN_URL} anyway`);
}

// 4. Create the production deployment
const dep = await api(`/v13/deployments${Q}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: PROJECT,
    target: 'production',
    files: files.map((f) => ({ file: f.file, size: f.size, mode: 420, sha: f.sha })),
  }),
});
const uid = dep.uid ?? dep.id;
console.log('deployment created:', uid ?? '(uid missing)', '|', dep.url);

// 5. Poll until ready
const t0 = Date.now();
while (true) {
  await new Promise((r) => setTimeout(r, 5000));
  const poll = uid ? await api(`/v13/deployments/${uid}${Q}`) : null;
  const s = poll ? poll.readyState : 'QUEUED';
  if (s === 'READY') { console.log(`\nREADY in ${Math.round((Date.now() - t0) / 1000)}s → https://${poll.url}`); process.exit(0); }
  if (['ERROR', 'CANCELED', 'DELETED'].includes(s)) {
    console.log(`\nFAILED: ${s}`);
    const events = await api(`/v2/deployments/${uid}/events?limit=30`).catch(() => null);
    if (Array.isArray(events)) for (const e of events.slice(-12)) {
      const t = e.payload?.text || e.payload?.info?.name || e.text || '';
      if (t) console.log(' ', String(t).slice(0, 250));
    }
    process.exit(1);
  }
  process.stdout.write(`  ${s} (${Math.round((Date.now() - t0) / 1000)}s)   \r`);
}
