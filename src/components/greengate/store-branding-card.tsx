'use client';

import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImageIcon, Store as StoreIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { navigate } from './header';

/**
 * Store profile — the seller adds, changes or removes their store LOGO and
 * banner at any time (POST /api/sellers/branding). Before, a logo could only
 * be added once, on the store application, and never changed afterwards.
 */
export function StoreBrandingCard({ store }: { store: { name: string; slug: string | null; logoData: string | null; bannerData: string | null } }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const logoInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);

  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const res = await fetch('/api/sellers/branding', { method: 'POST', body: form });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(out.error ?? 'Could not save your store images. Please try again.');
      return out;
    },
    onSuccess: (_out, form) => {
      const what = form.has('logo') ? 'Logo saved' : form.has('banner') ? 'Banner saved' : 'Image removed';
      toast({ title: what, description: 'Buyers see it on your store page straight away.' });
      queryClient.invalidateQueries({ queryKey: ['my-store'] });
      queryClient.invalidateQueries({ queryKey: ['store'] });
    },
    onError: (e: Error) => toast({ title: 'Store images', description: e.message, variant: 'destructive' }),
  });

  const send = (field: 'logo' | 'banner' | 'removeLogo' | 'removeBanner', file?: File) => {
    const form = new FormData();
    if (file) form.set(field, file);
    else form.set(field, '1');
    save.mutate(form);
  };
  const pick = (field: 'logo' | 'banner') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same file can be picked again later
    if (file) send(field, file);
  };
  const initials = store.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');

  return (
    <section className="mt-6 rounded-lg border bg-card p-4 sm:p-6" aria-labelledby="store-profile-heading" data-testid="store-profile">
      <h2 id="store-profile-heading" className="flex items-center gap-2 text-lg font-bold">
        <StoreIcon className="h-5 w-5 text-primary" aria-hidden /> Store profile
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Your logo and banner appear on your store page. Use your real logo or a real photo — JPEG, PNG or WebP up to 8 MB.
        Transparent areas become white, like product photos. AI-generated images are refused.
      </p>

      <div className="mt-4 grid gap-5 sm:grid-cols-[auto_1fr] [&>*]:min-w-0">
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Logo</p>
          <div className="mt-1.5 flex h-24 w-24 items-center justify-center overflow-hidden rounded-md border bg-white">
            {store.logoData ? (
              <img src={store.logoData} alt={`${store.name} logo`} className="h-full w-full object-contain" data-testid="store-logo-preview" />
            ) : (
              <span className="text-xl font-bold text-muted-foreground" aria-label="No logo yet">{initials || '—'}</span>
            )}
          </div>
          <input ref={logoInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={pick('logo')} aria-label="Choose a logo image" data-testid="logo-file" />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => logoInput.current?.click()} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : store.logoData ? 'Change logo' : 'Add logo'}
            </Button>
            {store.logoData && (
              <Button size="sm" variant="ghost" className="text-destructive" disabled={save.isPending}
                onClick={() => { if (window.confirm('Remove your store logo?')) send('removeLogo'); }}>
                Remove
              </Button>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-muted-foreground">Banner (optional)</p>
          <div className="mt-1.5 flex h-24 w-full items-center justify-center overflow-hidden rounded-md border bg-secondary/50 sm:h-28">
            {store.bannerData ? (
              <img src={store.bannerData} alt={`${store.name} banner`} className="h-full w-full object-cover" />
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><ImageIcon className="h-4 w-4" aria-hidden /> No banner yet</span>
            )}
          </div>
          <input ref={bannerInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={pick('banner')} aria-label="Choose a banner image" />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => bannerInput.current?.click()} disabled={save.isPending}>
              {store.bannerData ? 'Change banner' : 'Add banner'}
            </Button>
            {store.bannerData && (
              <Button size="sm" variant="ghost" className="text-destructive" disabled={save.isPending}
                onClick={() => { if (window.confirm('Remove your store banner?')) send('removeBanner'); }}>
                Remove
              </Button>
            )}
            {store.slug && (
              <Button size="sm" variant="link" className="px-0" onClick={() => navigate({ name: 'store-page', slug: store.slug ?? undefined })}>
                View my store page
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
