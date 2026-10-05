'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Camera, ImageIcon, Plus, Store, Trash2, TriangleAlert, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, type ProductSummary } from '@/lib/types';
import { navigate, type Category } from './header';

interface VariantDraft {
  id: number;
  size: string;
  colour: string;
  sku: string;
  stock: number;
  price: string;
}

export function SellView() {
  const { data: session, status } = useSession();

  const mine = useQuery<{ store: { id: string; slug: string; name: string; location: string } | null }>({
    queryKey: ['my-store'],
    queryFn: async () => (await fetch('/api/sellers?mine=1')).json(),
    enabled: Boolean(session),
  });

  if (status === 'loading') return <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12"><Skeleton className="h-64 w-full" /></main>;

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-4 px-4 py-20 text-center">
        <Store className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Sign in to start selling</p>
        <p className="text-xs text-muted-foreground">Create your store, list real products and get a full analytics dashboard.</p>
        <Button onClick={() => navigate({ name: 'signin' })}>Sign in / Register</Button>
      </main>
    );
  }

  if (mine.isLoading) return <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12"><Skeleton className="h-64 w-full" /></main>;

  return mine.data?.store
    ? <ProductManager />
    : <StoreOnboarding onCreated={() => { mine.refetch(); }} />;
}

// ---------------------------------------------------------------------------
// Store onboarding
// ---------------------------------------------------------------------------

function StoreOnboarding({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [phone, setPhone] = useState('');
  const [logo, setLogo] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.set('name', name);
      form.set('description', description);
      form.set('location', location);
      form.set('phone', phone);
      if (logo) form.set('images', logo);
      const res = await fetch('/api/sellers', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not create the store');
      return data;
    },
    onSuccess: () => {
      toast({ title: 'Your store is live!', description: 'List your first product below — photos get a white studio background automatically.' });
      onCreated();
    },
    onError: (e: Error) => toast({ title: 'Store', description: e.message, variant: 'destructive' }),
  });

  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold">Sell on Green Gate</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Open your store in one step. Every product photo you upload is checked for AI generation and given a clean white background automatically.
      </p>
      <form
        className="mt-6 space-y-4 rounded-lg border bg-card p-6"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div>
          <Label htmlFor="store-name">Store name</Label>
          <Input id="store-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} placeholder="e.g. Cape Thread Co." />
        </div>
        <div>
          <Label htmlFor="store-desc">Store description (optional)</Label>
          <Textarea id="store-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What do you sell?" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="store-location">Location</Label>
            <Input id="store-location" value={location} onChange={(e) => setLocation(e.target.value)} required placeholder="City, suburb" />
          </div>
          <div>
            <Label htmlFor="store-phone">Contact number</Label>
            <Input id="store-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </div>
        </div>
        <div>
          <Label htmlFor="store-logo">Store logo (optional — real photos only)</Label>
          <Input
            id="store-logo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="mt-1"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setLogo(f);
              setPreview(f ? URL.createObjectURL(f) : null);
            }}
          />
          {preview && (
             
            <img src={preview} alt="Logo preview" className="mt-2 h-16 w-16 rounded-md border object-cover" />
          )}
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={create.isPending}>
          {create.isPending ? 'Creating store…' : 'Create my store'}
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">
          AI-generated logos are rejected — use a real photo of your brand or products.
        </p>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Product manager
// ---------------------------------------------------------------------------

function ProductManager() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Product manager</h1>
          <p className="text-sm text-muted-foreground">List real products with real photos. Variants get their own SKUs and stock.</p>
        </div>
        <Button variant="outline" onClick={() => navigate({ name: 'dashboard' })}>
          Go to dashboard
        </Button>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        <NewProductForm />
        <MyProducts />
      </div>
    </main>
  );
}

function NewProductForm() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [price, setPrice] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [stock, setStock] = useState('1');
  const [weight, setWeight] = useState('1000');
  const [tags, setTags] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [hasVariants, setHasVariants] = useState(false);
  const [variants, setVariants] = useState<VariantDraft[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: cats } = useQuery<{ categories: Category[] }>({
    queryKey: ['categories'],
    queryFn: async () => (await fetch('/api/categories')).json(),
    staleTime: 5 * 60_000,
  });

  const childCats = (cats?.categories ?? []).find((c) => c.slug === category)?.children ?? [];

  const pickImages = (files: FileList | null) => {
    if (!files) return;
    const arr = [...files].slice(0, 6);
    setImages(arr);
    setPreviews(arr.map((f) => URL.createObjectURL(f)));
  };

  const submit = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.set('name', name);
      form.set('description', description);
      form.set('category', category);
      if (brand) form.set('brand', brand);
      if (salePrice) form.set('salePrice', salePrice);
      form.set('price', price);
      form.set('stock', stock);
      form.set('weightGrams', weight);
      if (tags) form.set('tags', tags);
      if (hasVariants) {
        form.set('variants', JSON.stringify(variants.map((v) => ({
          attributes: Object.fromEntries([
            v.size ? ['size', v.size] : null as never,
            v.colour ? ['colour', v.colour] : null as never,
          ].filter(Boolean) as [string, string][]),
          sku: v.sku,
          stock: Number(v.stock),
          price: v.price ? Number(v.price) : undefined,
        }))));
      }
      for (const img of images) form.append('images', img);
      const res = await fetch('/api/products', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not create the product');
      return data;
    },
    onSuccess: () => {
      toast({ title: 'Product listed', description: 'Photos processed onto a white background and indexed for search.' });
      setName(''); setDescription(''); setPrice(''); setSalePrice(''); setStock('1'); setTags(''); setBrand('');
      setImages([]); setPreviews([]); setVariants([]); setHasVariants(false);
      if (fileRef.current) fileRef.current.value = '';
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['my-products'] });
    },
    onError: (e: Error) => toast({ title: 'Listing failed', description: e.message, variant: 'destructive' }),
  });

  return (
    <form
      className="h-fit space-y-4 rounded-lg border bg-card p-6"
      onSubmit={(e) => {
        e.preventDefault();
        setUploading(true);
        submit.mutate(undefined, { onSettled: () => setUploading(false) });
      }}
    >
      <h2 className="flex items-center gap-2 text-lg font-bold"><Plus className="h-5 w-5 text-primary" /> List a product</h2>

      <div>
        <Label htmlFor="p-name">Product name</Label>
        <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={3} maxLength={140} placeholder="e.g. Linen summer dress" />
      </div>
      <div>
        <Label htmlFor="p-desc">Description</Label>
        <Textarea id="p-desc" value={description} onChange={(e) => setDescription(e.target.value)} required minLength={20} placeholder="Material, fit, care, what is included…" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="p-cat">Category</Label>
          <select
            id="p-cat"
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
          >
            <option value="">Choose…</option>
            {(cats?.categories ?? []).map((c) => (
              <option key={c.slug} value={c.slug}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="p-brand">Brand (optional)</Label>
          <Input id="p-brand" value={brand} onChange={(e) => setBrand(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="p-price">Price (R)</Label>
          <Input id="p-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} required placeholder="499.99" />
        </div>
        <div>
          <Label htmlFor="p-sale">Sale price (R, optional)</Label>
          <Input id="p-sale" inputMode="decimal" value={salePrice} onChange={(e) => setSalePrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="399.99" />
        </div>
        {!hasVariants && (
          <div>
            <Label htmlFor="p-stock">Stock</Label>
            <Input id="p-stock" inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value.replace(/\D/g, ''))} required />
          </div>
        )}
        <div>
          <Label htmlFor="p-weight">Weight (grams)</Label>
          <Input id="p-weight" inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value.replace(/\D/g, ''))} required />
        </div>
      </div>
      <div>
        <Label htmlFor="p-tags">Tags (comma separated, optional)</Label>
        <Input id="p-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="summer, cotton, green" />
      </div>

      {/* Variants */}
      <div className="rounded-md border p-3">
        <div className="flex items-center gap-2">
          <Switch id="has-variants" checked={hasVariants} onCheckedChange={setHasVariants} />
          <Label htmlFor="has-variants">This product has size/colour variants</Label>
        </div>
        {hasVariants && (
          <div className="mt-3 space-y-2">
            {variants.map((v) => (
              <div key={v.id} className="grid grid-cols-[1fr_1fr_1.2fr_70px_70px_36px] items-center gap-1.5">
                <Input className="h-8" placeholder="Size" value={v.size} onChange={(e) => setVariants((vs) => vs.map((x) => (x.id === v.id ? { ...x, size: e.target.value } : x)))} aria-label="Variant size" />
                <Input className="h-8" placeholder="Colour" value={v.colour} onChange={(e) => setVariants((vs) => vs.map((x) => (x.id === v.id ? { ...x, colour: e.target.value } : x)))} aria-label="Variant colour" />
                <Input className="h-8" placeholder="SKU (auto)" value={v.sku} onChange={(e) => setVariants((vs) => vs.map((x) => (x.id === v.id ? { ...x, sku: e.target.value } : x)))} aria-label="Variant SKU" />
                <Input className="h-8" placeholder="Stock" inputMode="numeric" value={String(v.stock)} onChange={(e) => setVariants((vs) => vs.map((x) => (x.id === v.id ? { ...x, stock: Number(e.target.value.replace(/\D/g, '') || 0) } : x)))} aria-label="Variant stock" />
                <Input className="h-8" placeholder="Price" inputMode="decimal" value={v.price} onChange={(e) => setVariants((vs) => vs.map((x) => (x.id === v.id ? { ...x, price: e.target.value.replace(/[^0-9.]/g, '') } : x)))} aria-label="Variant price override" />
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Remove variant" onClick={() => setVariants((vs) => vs.filter((x) => x.id !== v.id))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setVariants((vs) => [...vs, { id: Date.now(), size: '', colour: '', sku: '', stock: 1, price: '' }])}>
              <Plus className="h-3.5 w-3.5" /> Add variant
            </Button>
          </div>
        )}
      </div>

      {/* Images */}
      <div>
        <Label htmlFor="p-images" className="flex items-center gap-2">
          <Camera className="h-4 w-4" /> Product photos (1–6, real photos only)
        </Label>
        <Input id="p-images" ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="mt-1" onChange={(e) => pickImages(e.target.files)} />
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-secondary p-2 text-[11px] leading-relaxed text-muted-foreground">
          <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          Every photo is scanned for AI generation — synthetic images are rejected. Accepted photos are automatically placed on a clean white studio background.
        </p>
        {previews.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {previews.map((src, i) => (
               
              <img key={i} src={src} alt={`Upload preview ${i + 1}`} className="h-16 w-16 rounded-md border object-cover" />
            ))}
          </div>
        )}
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={submit.isPending || uploading || images.length === 0}>
        {submit.isPending || uploading ? 'Processing photos…' : 'List product'}
      </Button>
    </form>
  );
}

function MyProducts() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const mine = useQuery<{ products: ProductSummary[] }>({
    queryKey: ['my-products-own'],
    queryFn: async () => {
      const res = await fetch('/api/seller/products');
      if (!res.ok) return { products: [] };
      return res.json();
    },
  });

  const products = mine.data?.products ?? [];
  const isLoading = mine.isLoading;

  const toggle = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const res = await fetch(`/api/products/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? 'Could not update');
      return out;
    },
    onSuccess: () => {
      toast({ title: 'Product updated' });
      queryClient.invalidateQueries({ queryKey: ['my-products-own'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (e: Error) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? 'Could not remove');
      return out;
    },
    onSuccess: () => {
      toast({ title: 'Product removed' });
      queryClient.invalidateQueries({ queryKey: ['my-products-own'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (e: Error) => toast({ title: 'Remove failed', description: e.message, variant: 'destructive' }),
  });

  return (
    <section aria-label="Your products" className="h-fit rounded-lg border bg-card p-6">
      <h2 className="flex items-center gap-2 text-lg font-bold"><ImageIcon className="h-5 w-5 text-primary" /> Your listings</h2>
      {isLoading || mine.isLoading ? (
        <div className="mt-4 space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : products.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed p-8 text-center">
          <TriangleAlert className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium">No products yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Use the form to list your first product. It goes live immediately.</p>
        </div>
      ) : (
        <ul className="mt-4 max-h-[560px] space-y-2 overflow-y-auto pr-1">
          {products.map((p) => (
            <li key={p.id} className="flex items-center gap-3 rounded-md border p-2">
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border bg-white dark:bg-muted">
                {p.image && (
                   
                  <img src={p.image} alt={p.name} className="h-full w-full object-cover" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatMoney(p.salePriceCents ?? p.priceCents)} · {p.stock} in stock
                </p>
              </div>
              <Badge variant={p.status === 'approved' ? 'secondary' : 'outline'} className="text-[10px]">{p.status}</Badge>
              <div className="flex flex-col gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => toggle.mutate({ id: p.id, status: p.status === 'approved' ? 'disabled' : 'approved' })}
                >
                  {p.status === 'approved' ? 'Disable' : 'Enable'}
                </Button>
                <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" onClick={() => remove.mutate(p.id)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
