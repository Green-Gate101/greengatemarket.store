/**
 * Counters that many requests bump at once (a popular product's view count,
 * the day's API-usage tally) are added up in memory and written as one
 * increment every few seconds. Writing +1 on every request made all of them
 * queue for the same database row under heavy traffic.
 *
 * A failed write is kept and retried with the next one, so nothing is lost
 * while the server runs. Only the last few seconds can go missing if a server
 * is shut down mid-batch — fine for view counts and usage tallies, never used
 * for money or stock.
 */

const FLUSH_MS = 4_000;

interface Entry {
  n: number;
  write: (n: number) => Promise<unknown>;
}

const pending = new Map<string, Entry>();
let flushing: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastFlush = Date.now();

/** Add `n` to the counter `key`; `write(total)` stores the added-up amount. */
export function addToCounter(key: string, write: (n: number) => Promise<unknown>, n = 1): void {
  const entry = pending.get(key);
  if (entry) entry.n += n;
  else pending.set(key, { n, write });
  schedule();
}

function schedule(): void {
  if (flushing) return;
  // A timer can sit unfired while the server is paused between requests.
  if (Date.now() - lastFlush >= FLUSH_MS * 2) {
    void flushCounters();
    return;
  }
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flushCounters();
    }, FLUSH_MS);
    timer.unref?.();
  }
}

/** Write every added-up counter now. */
export function flushCounters(): Promise<void> {
  if (flushing) return flushing;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return Promise.resolve();
  const batch = [...pending.entries()];
  pending.clear();
  flushing = (async () => {
    // A few at a time — a burst of distinct counters never floods the pool.
    for (let i = 0; i < batch.length; i += 8) {
      await Promise.all(
        batch.slice(i, i + 8).map(async ([key, entry]) => {
          try {
            await entry.write(entry.n);
          } catch (e) {
            // Kept: added back and written with the next batch.
            const now = pending.get(key);
            if (now) now.n += entry.n;
            else pending.set(key, entry);
            console.error(`counter ${key.split(':')[0]} write failed (will retry):`, e instanceof Error ? e.message : e);
          }
        }),
      );
    }
  })().finally(() => {
    flushing = null;
    lastFlush = Date.now();
    if (pending.size > 0) schedule();
  });
  return flushing;
}
