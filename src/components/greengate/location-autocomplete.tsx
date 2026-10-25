'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import { cn, readJson } from '@/lib/utils';
import { Input } from '@/components/ui/input';

/**
 * Google-Maps-style address autocomplete.
 *
 * The user types where they usually would (the street input in Account →
 * Addresses, the delivery-address box at checkout) and suggestion chips
 * appear under the field as they type. Picking one fills the whole address
 * in one tap and hands the exact coordinates to the caller, so the courier
 * pin is set from the suggestion — no extra steps.
 *
 * Upstream: /api/geocode/search (OSM Nominatim, ZA-only) — debounced 350 ms,
 * previous request aborted, graceful empty state when nothing matches.
 */

export interface AddressSuggestion {
  id: string;
  line: string;
  main: string;
  secondary: string;
  street: string;
  city: string;
  province: string;
  postalCode: string;
  latitude: number;
  longitude: number;
}

const MIN_CHARS = 3;
const DEBOUNCE_MS = 350;

interface LocationAutocompleteProps {
  /** The controlled value the parent renders into the field. */
  value: string;
  /** Fired on every keystroke (the parent keeps owning the value). */
  onValueChange: (v: string) => void;
  /** Fired when a suggestion is chosen — parent fills the address fields. */
  onPick: (s: AddressSuggestion) => void;
  /** Render an <input> (single-line) or <textarea> (checkout-style) anchor. */
  as?: 'input' | 'textarea';
  id?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  rows?: number;
  className?: string;
  ariaLabel?: string;
}

export function LocationAutocomplete({
  value,
  onValueChange,
  onPick,
  as = 'input',
  id,
  placeholder,
  required,
  minLength,
  rows,
  className,
  ariaLabel,
}: LocationAutocompleteProps) {
  const autoId = useId();
  const listId = `${autoId}-listbox`;
  const [items, setItems] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  // Tracks whether the latest value change came from typing HERE. Prefills
  // and picks set the value programmatically — those must never re-open the
  // dropdown (Google-Maps behaviour: suggestions only follow real typing).
  const selfEditRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced suggestion fetch while typing.
  useEffect(() => {
    if (!selfEditRef.current) return; // programmatic set — stay closed
    const q = value.trim();
    if (q.length < MIN_CHARS) {
      setItems([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/geocode/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('search failed');
        const data = (await readJson(res)) as { suggestions: AddressSuggestion[] };
        setItems(data.suggestions ?? []);
        setHighlight(-1);
        // Stay open even when empty so the "no matches" hint shows.
        setOpen(true);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setItems([]);
          setOpen(false);
        }
      } finally {
        if (abortRef.current === controller) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
  }, []);

  function handleOnChange(next: string) {
    selfEditRef.current = true;
    onValueChange(next);
  }

  function pick(s: AddressSuggestion) {
    selfEditRef.current = false;
    setOpen(false);
    setItems([]);
    setHighlight(-1);
    setLoading(false);
    onPick(s);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (!open || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? items.length - 1 : h - 1));
    } else if (e.key === 'Enter') {
      if (highlight >= 0 && highlight < items.length) {
        e.preventDefault();
        pick(items[highlight]);
      }
      // No highlight: input lets the form submit, textarea inserts a newline.
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      selfEditRef.current = false;
    }
  }

  function handleBlur() {
    // Give click handlers on the options a beat before closing.
    blurTimerRef.current = setTimeout(() => {
      setOpen(false);
      selfEditRef.current = false;
    }, 120);
  }

  function handleFocusOrMouseDown() {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }

  const showDropdown = open && (loading || items.length > 0 || value.trim().length >= MIN_CHARS);
  const activeDescendant = highlight >= 0 ? `${listId}-opt-${highlight}` : undefined;

  const commonProps = {
    id,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => handleOnChange(e.target.value),
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
    onFocus: handleFocusOrMouseDown,
    onMouseDown: handleFocusOrMouseDown,
    placeholder,
    required,
    minLength,
    'aria-label': ariaLabel,
    role: 'combobox' as const,
    'aria-expanded': showDropdown,
    'aria-controls': listId,
    'aria-autocomplete': 'list' as const,
    'aria-activedescendant': activeDescendant,
    autoComplete: 'off',
  };

  return (
    <div className="relative">
      {as === 'input' ? (
        <Input {...commonProps} className={className} />
      ) : (
        <textarea
          {...commonProps}
          rows={rows}
          className={cn(
            'flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            className,
          )}
        />
      )}

      {showDropdown && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Address suggestions"
          className="absolute left-0 right-0 top-full z-50 mt-1.5 max-h-72 w-full overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          {items.map((s, i) => (
            <li key={s.id} role="option" id={`${listId}-opt-${i}`} aria-selected={i === highlight}>
              <button
                type="button"
                tabIndex={-1}
                className={cn(
                  'flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-sm transition-colors',
                  i === highlight ? 'bg-accent' : 'hover:bg-accent/60',
                )}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus in the field
                  pick(s);
                }}
              >
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{s.main}</span>
                  {s.secondary && <span className="block truncate text-xs text-muted-foreground">{s.secondary}</span>}
                </span>
              </button>
            </li>
          ))}
          {loading && (
            <li className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Searching addresses…
            </li>
          )}
          {!loading && items.length === 0 && (
            <li className="border-t px-3 py-2 text-xs text-muted-foreground">
              No matches in South Africa yet — keep typing or fill the fields below.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
