#!/usr/bin/env node
/**
 * Green Gate — deterministic Vercel REST deploy.
 *
 * Mirrors the vercel CLI's own protocol (POST /v2/files per file with
 * x-now-digest headers, then POST /v13/deployments and poll). Use this when
 * the CLI deploy hangs (observed in some sandboxed environments).
 *
 * Usage:
 *   VERCEL_TOKEN=... ./scripts/deploy-rest.mjs
 *   VERCEL_TOKEN=... VERCEL_PROJECT=green-gate ./scripts/deploy-rest.mjs
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = process.env.VERCEL_TOKEN;
const PROJECT = process.env.VERCEL_PROJECT || 'greengate';
const TEAM = process.env.VERCEL_TEAM || '';
const CWD = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://api.vercel.com';

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

// 1. Collect tracked files (repo .gitignore excludes node_modules/.next/db/.env*/dev.log)
const paths = execSync('git ls-files', { cwd: CWD, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const files = paths.map(p => {
  const buf = readFileSync(join(CWD, p));
  return { file: p, sha: createHash('sha1').update(buf).digest('hex'), size: buf.length, buf };
});
console.log(`collected ${files.length} tracked files`);

// 2. Upload each file (idempotent — already-stored files return immediately)
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
    await new Promise(r => setTimeout(r, 1500 * attempt));
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

// 3. Create the production deployment (project settings inherited from the project)
const dep = await api(`/v13/deployments${TEAM ? `?teamId=${TEAM}` : ''}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: PROJECT,
    target: 'production',
    files: files.map(f => ({ file: f.file, size: f.size, mode: 420, sha: f.sha })),
  }),
});
const uid = dep.uid ?? dep.id;
console.log('deployment created:', uid ?? '(uid missing — follow via project page)', '|', dep.url);

// 4. Poll until ready
const t0 = Date.now();
while (true) {
  await new Promise(r => setTimeout(r, 5000));
  const poll = uid ? await api(`/v13/deployments/${uid}${TEAM ? `?teamId=${TEAM}` : ''}`) : null;
  const s = poll ? poll.readyState : 'QUEUED';
  if (s === 'READY') { console.log(`\nREADY in ${Math.round((Date.now()-t0)/1000)}s → https://${poll.url}`); process.exit(0); }
  if (['ERROR', 'CANCELED', 'DELETED'].includes(s)) {
    console.log(`\nFAILED: ${s}`);
    const events = await api(`/v2/deployments/${uid}/events?limit=30`).catch(() => null);
    if (Array.isArray(events)) for (const e of events.slice(-12)) {
      const t = e.payload?.text || e.payload?.info?.name || e.text || '';
      if (t) console.log(' ', String(t).slice(0, 250));
    }
    process.exit(1);
  }
  process.stdout.write(`  ${s} (${Math.round((Date.now()-t0)/1000)}s)   \r`);
}
