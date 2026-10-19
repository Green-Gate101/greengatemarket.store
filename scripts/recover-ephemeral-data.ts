/**
 * Recover marketplace data from warm Vercel instances that still hold the old
 * ephemeral /tmp SQLite DB. Polls the public APIs many times; every response
 * that contains rows is accumulated (deduped by id) so we snapshot whatever
 * still lives on any instance. Output: /tmp/gg-recovery.json
 */
const BASE = 'https://greengatemarket.store';
const stores = new Map();
const products = new Map();

function j(res) { return res.json(); }

async function poll(n, delayMs) {
  for (let i = 0; i < n; i++) {
    try {
      const [sRes, pRes] = await Promise.all([
        fetch(`${BASE}/api/sellers?offset=0`, { cache: 'no-store' }),
        fetch(`${BASE}/api/products?page=1&pageSize=48`, { cache: 'no-store' }),
      ]);
      if (sRes.ok) {
        const d = await j(sRes);
        for (const s of d.stores ?? []) stores.set(s.id, s);
      }
      if (pRes.ok) {
        const d = await j(pRes);
        for (const p of d.products ?? []) products.set(p.id, p);
      }
      // Per-store product sweep too (different route = different instance pool)
      for (const s of [...stores.values()]) {
        try {
          const r = await fetch(`${BASE}/api/products?store=${encodeURIComponent(s.slug)}&pageSize=48`, { cache: 'no-store' });
          if (r.ok) {
            const d = await j(r);
            for (const p of d.products ?? []) products.set(p.id, p);
          }
        } catch { /* ignore */ }
      }
      if (i % 5 === 0) console.log(`poll ${i + 1}/${n}: stores=${stores.size} products=${products.size}`);
    } catch (e) {
      console.log('poll error', String(e).slice(0, 80));
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

const n = Number(process.argv[2] ?? 30);
const delay = Number(process.argv[3] ?? 250);
await poll(n, delay);
const out = {
  recoveredAt: new Date().toISOString(),
  stores: [...stores.values()],
  products: [...products.values()],
};
await Bun.write('/tmp/gg-recovery.json', JSON.stringify(out, null, 1));
console.log(`DONE: stores=${stores.size} products=${products.size} → /tmp/gg-recovery.json`);
