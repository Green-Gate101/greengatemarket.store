'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { LayoutGrid, Search, Store as StoreIcon, TrendingUp } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { Route } from './header';

interface SuggestData {
  q: string;
  popular: string[];
  categories: { slug: string; name: string }[];
  stores: { slug: string; name: string; location: string }[];
  products: { slug: string; name: string; priceCents: number; image: string | null; storeName: string }[];
}

type Item =
  | { kind: 'search'; label: string; q: string }
  | { kind: 'popular'; label: string; q: string }
  | { kind: 'store'; label: string; sub: string; slug: string }
  | { kind: 'product'; label: string; sub: string; slug: string; image: string | null }
  | { kind: 'category'; label: string; slug: string };

const money = (cents: number) => {
  try {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', minimumFractionDigits: 2 }).format(cents / 100);
  } catch {
    return `R ${(cents / 100).toFixed(2)}`;
  }
};

/**
 * Header search with suggestions as you type: matching stores, products and
 * categories (and popular searches when the box is empty), keyboard
 * navigation (↑ ↓ Enter Esc) and an accessible combobox. Pressing Enter with
 * nothing highlighted still runs the full search, exactly as before.
 */
export function SearchSuggest({ value, onValueChange, onPick }: {
  value: string;
  onValueChange: (v: string) => void;
  /** Navigate: a search ({ name: 'store', q }) or a product/store/category route. */
  onPick: (route: Route) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  // `active` comes from the arrow keys only — Enter opens it. `hover` is the
  // mouse: it shades an option but never decides what Enter does (a resting
  // pointer used to hijack Enter and open a random suggestion).
  const [active, setActive] = useState(-1);
  const [hover, setHover] = useState(-1);
  const [data, setData] = useState<SuggestData | null>(null);
  const [term, setTerm] = useState(value.trim());
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce what we ask the server for (one request per pause in typing).
  useEffect(() => {
    const t = setTimeout(() => setTerm(value.trim()), 180);
    return () => clearTimeout(t);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const ctrl = typeof AbortController === 'undefined' ? null : new AbortController();
    fetch(`/api/search/suggest?q=${encodeURIComponent(term)}`, ctrl ? { signal: ctrl.signal } : undefined)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SuggestData | null) => {
        if (d) {
          setData(d);
          setActive(-1);
          setHover(-1);
        }
      })
      .catch(() => { /* offline or aborted: keep the last suggestions */ });
    return () => ctrl?.abort();
  }, [term, open]);

  useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); }, []);

  const q = value.trim();
  const items: Item[] = [];
  // "Search for …" shows from the first letter, and the last suggestions stay
  // on screen while the next ones load, so the list follows the typing
  // instead of blinking out on every key (slow phone networks especially).
  // The empty-box list (popular searches) is never shown against typed text.
  const fresh = data !== null && data.q === term;
  const shown = data && (fresh || (data.q !== '' && q !== '')) ? data : null;
  if (q) items.push({ kind: 'search', label: `Search for “${q}”`, q });
  if (shown) {
    for (const s of shown.stores) items.push({ kind: 'store', label: s.name, sub: s.location, slug: s.slug });
    for (const p of shown.products) items.push({ kind: 'product', label: p.name, sub: `${p.storeName} · ${money(p.priceCents)}`, slug: p.slug, image: p.image });
    for (const c of shown.categories) items.push({ kind: 'category', label: c.name, slug: c.slug });
    if (!q && fresh) for (const t of shown.popular) items.push({ kind: 'popular', label: t, q: t });
  }
  const show = open && items.length > 0;

  const choose = (item: Item) => {
    setOpen(false);
    setActive(-1);
    if (item.kind === 'search' || item.kind === 'popular') {
      onValueChange(item.q);
      onPick({ name: 'store', q: item.q });
    } else if (item.kind === 'store') onPick({ name: 'store-page', slug: item.slug });
    else if (item.kind === 'product') onPick({ name: 'product', slug: item.slug });
    else onPick({ name: 'store', slug: item.slug });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      if (items.length) setActive((a) => (a + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
    } else if (e.key === 'Enter') {
      if (show && active >= 0 && active < items.length) {
        e.preventDefault();
        choose(items[active]);
      } else {
        setOpen(false); // the form submits the full search
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  };

  const heading = (text: string, icon: React.ReactNode) => (
    <li role="presentation" className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{icon}{text}</li>
  );
  let lastKind = '';

  return (
    <div className="relative w-full">
      <Input
        value={value}
        onChange={(e) => { onValueChange(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => { if (blurTimer.current) clearTimeout(blurTimer.current); setOpen(true); }}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
        onKeyDown={onKeyDown}
        placeholder="Search products, brands and stores…"
        className="h-10 pr-10"
        aria-label="Search products"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={show}
        aria-controls={listId}
        aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        enterKeyHint="search"
      />
      <Button type="submit" variant="ghost" size="icon" className="absolute right-0 top-0 h-10 w-10" aria-label="Search">
        <Search className="h-4 w-4" />
      </Button>
      {show && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-lg"
          data-testid="search-suggestions"
          // Keep focus in the box while a suggestion is tapped/clicked.
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((item, i) => {
            const group = item.kind === 'search' ? '' : item.kind;
            const head = group && group !== lastKind
              ? heading(
                  group === 'store' ? 'Stores' : group === 'product' ? 'Products' : group === 'category' ? 'Categories' : 'Popular searches',
                  group === 'store' ? <StoreIcon className="h-3 w-3" aria-hidden /> : group === 'category' ? <LayoutGrid className="h-3 w-3" aria-hidden /> : group === 'popular' ? <TrendingUp className="h-3 w-3" aria-hidden /> : null,
                )
              : null;
            lastKind = group || lastKind;
            return (
              <li key={`${item.kind}-${i}`} role="presentation">
                {head && <ul role="presentation">{head}</ul>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-kind={item.kind}
                  className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm ${i === active ? 'bg-accent text-accent-foreground' : i === hover ? 'bg-accent/60' : ''}`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover((h) => (h === i ? -1 : h))}
                  onClick={() => choose(item)}
                >
                  {item.kind === 'product' && (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded border bg-white">
                      {item.image ? <img src={item.image} alt="" className="h-full w-full object-contain" loading="lazy" /> : null}
                    </span>
                  )}
                  {item.kind === 'search' && <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${item.kind === 'search' ? 'font-medium' : ''}`}>{item.label}</span>
                    {'sub' in item && item.sub ? <span className="block truncate text-xs text-muted-foreground">{item.sub}</span> : null}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
