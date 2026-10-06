#!/usr/bin/env bun
/**
 * Algolia index maintenance — syncs the products index to the live catalogue.
 *
 *  - Deletes stale index objects (products that no longer exist / are not
 *    live in the marketplace database).
 *  - Upserts every live approved product with the canonical field set.
 *
 * Usage:  bun scripts/reindex-algolia.mjs
 * Env:    reads ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY / ALGOLIA_INDEX_NAME and
 *         DATABASE_URL from .env in the project root. Idempotent — safe to
 *         re-run any time (e.g. after restoring a database or rotating keys).
 */

import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

// --- env -------------------------------------------------------------------
const env = {};
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch {}

const APP_ID = env.ALGOLIA_APP_ID;
const ADMIN_KEY = env.ALGOLIA_ADMIN_KEY;
const INDEX = env.ALGOLIA_INDEX_NAME || 'products';
if (!APP_ID || !ADMIN_KEY) {
  console.error('ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY missing from .env');
  process.exit(1);
}

const dbPath = (env.DATABASE_URL ?? '').replace(/^file:/, '');
if (!dbPath) {
  console.error('DATABASE_URL missing from .env');
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true });

async function algolia(method, path, body) {
  const res = await fetch(`https://${APP_ID}-dsn.algolia.net/1${path}`, {
    method,
    headers: {
      'x-algolia-application-id': APP_ID,
      'x-algolia-api-key': ADMIN_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Algolia ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// --- live catalogue ----------------------------------------------------------
const products = [];
const rows = db
  .query(
    `SELECT p.id, p.name, p.description, p.priceCents, s.name AS storeName, c.name AS categoryName
     FROM Product p
     JOIN Store s ON s.id = p.storeId
     LEFT JOIN Category c ON c.id = p.categoryId
     WHERE p.status = 'approved'`,
  )
  .all();
for (const r of rows) {
  products.push({
    objectID: r.id,
    name: r.name,
    description: r.description,
    category: r.categoryName ?? '',
    price: r.priceCents / 100,
    sellerName: r.storeName,
  });
}
const liveIds = new Set(products.map((p) => p.objectID));
console.log(`Live approved products: ${products.length}`);

// --- current index contents ---------------------------------------------------
const indexedIds = new Set();
let cursor;
for (;;) {
  const params = new URLSearchParams({ attributesToRetrieve: 'objectID', hitsPerPage: '1000' });
  if (cursor) params.set('cursor', cursor);
  const page = await algolia('GET', `/indexes/${INDEX}/browse?${params.toString()}`);
  for (const hit of page.hits ?? []) indexedIds.add(hit.objectID);
  cursor = page.cursor;
  if (!cursor) break;
}
console.log(`Objects currently in index: ${indexedIds.size}`);

// --- sync ---------------------------------------------------------------------
const ops = [];
for (const id of indexedIds) {
  if (!liveIds.has(id)) ops.push({ action: 'deleteObject', body: { objectID: id } });
}
for (const p of products) {
  ops.push({ action: 'updateObject', body: p });
}

if (ops.length === 0) {
  console.log('Index already in sync.');
  process.exit(0);
}
const res = await algolia('POST', `/indexes/${INDEX}/batch`, { requests: ops });
console.log(
  `Batch submitted: taskID=${res.taskID} (stale to delete: ${ops.filter((o) => o.action === 'deleteObject').length}, to upsert: ${ops.filter((o) => o.action === 'updateObject').length ? products.length : 0})`,
);

// Wait for the task to finish so a re-run right after is still a no-op.
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const task = await algolia('GET', `/indexes/${INDEX}/task/${res.taskID}`);
  if (task.status === 'published') {
    console.log('Task published — index is in sync.');
    process.exit(0);
  }
}
console.log('Task still processing; check the Algolia dashboard.');
