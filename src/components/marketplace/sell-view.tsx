'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ProductImage } from './product-image';
import { formatZAR } from '@/lib/format';
import { CATEGORIES, type ProductDto, type SellerDto } from '@/lib/types';
import {
  ArrowRight,
  ImagePlus,
  Loader2,
  Sparkles,
  Store,
  Trash2,
  UploadCloud,
  Wand2,
} from 'lucide-react';

export function SellView({
  seller,
  sellers,
  onSellerCreated,
  onSelectSeller,
  onGoToDashboard,
}: {
  seller: SellerDto | null;
  sellers: SellerDto[];
  onSellerCreated: (s: SellerDto) => void;
  onSelectSeller: (s: SellerDto) => void;
  onGoToDashboard: () => void;
}) {
  if (!seller) {
    return (
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 sm:px-6">
        <div className="mx-auto mt-10 grid max-w-4xl gap-8 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Sell on Soko Market</h1>
            <p className="mt-3 leading-relaxed text-muted-foreground">
              Open a store in under two minutes. Upload a product photo from your phone — we
              automatically remove the background and place your product on a clean white studio
              background, exactly like the big retailers.
            </p>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                'Automatic white-background product photos',
                'Revenue, orders and units-sold analytics in your dashboard',
                'Email receipts sent to every customer automatically',
                'Nationwide courier shipping with live rates at checkout',
              ].map((t) => (
                <li key={t} className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Sparkles className="h-3 w-3" aria-hidden />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
            {sellers.length > 0 && (
              <div className="mt-8 rounded-lg border bg-muted/40 p-4">
                <p className="text-sm font-medium">Already have a store?</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {sellers.map((s) => (
                    <Button key={s.id} variant="outline" size="sm" className="gap-1.5" onClick={() => onSelectSeller(s)}>
                      <Store className="h-3.5 w-3.5" aria-hidden />
                      {s.storeName}
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <SellerOnboardingForm onCreated={onSellerCreated} />
        </div>
      </main>
    );
  }
  return (
    <ProductManager
      seller={seller}
      onGoToDashboard={onGoToDashboard}
    />
  );
}

function SellerOnboardingForm({ onCreated }: { onCreated: (s: SellerDto) => void }) {
  const [form, setForm] = useState({ storeName: '', ownerName: '', email: '', phone: '', location: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/sellers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not create your store');
      onCreated(data.seller);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your store');
    } finally {
      setSubmitting(false);
    }
  };

  const field = (
    id: keyof typeof form,
    label: string,
    placeholder: string,
    type = 'text',
  ) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`seller-${id}`}>{label}</Label>
      <Input
        id={`seller-${id}`}
        type={type}
        value={form[id]}
        onChange={(e) => setForm((f) => ({ ...f, [id]: e.target.value }))}
        placeholder={placeholder}
        required
      />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Store className="h-5 w-5 text-primary" aria-hidden /> Create your seller account
        </CardTitle>
        <CardDescription>Your store appears on the marketplace immediately.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4" noValidate={false}>
          {field('storeName', 'Store name', 'Kasi Krafts')}
          {field('ownerName', 'Owner name', 'Thabo Mokoena')}
          {field('email', 'Email', 'you@yourstore.co.za', 'email')}
          {field('phone', 'Phone', '+27 82 000 0000', 'tel')}
          {field('location', 'Location', 'Soweto, Johannesburg')}
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Creating store…
              </>
            ) : (
              'Open my store'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ProductManager({ seller, onGoToDashboard }: { seller: SellerDto; onGoToDashboard: () => void }) {
  const [lastUpload, setLastUpload] = useState<{ original: string; processed: ProductDto } | null>(null);
  const { data: products, isLoading, refetch } = useQuery({
    queryKey: ['seller-products', seller.id],
    queryFn: async () => {
      const res = await fetch(`/api/products?sellerId=${seller.id}`);
      if (!res.ok) throw new Error('Failed to load products');
      const data = await res.json();
      return (data.products ?? []) as ProductDto[];
    },
  });

  const loadProducts = () => refetch();

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 sm:px-6">
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{seller.storeName}</h1>
          <p className="text-sm text-muted-foreground">
            {seller.location} · {products?.length ?? '…'} product{products?.length === 1 ? '' : 's'} listed
          </p>
        </div>
        <Button variant="outline" onClick={onGoToDashboard} className="gap-2">
          View sales dashboard <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <UploadForm
          seller={seller}
          onUploaded={(original, product) => {
            setLastUpload({ original, processed: product });
            loadProducts();
          }}
        />
        <UploadResult upload={lastUpload} />
      </div>

      <section className="mt-10" aria-label="Your products">
        <h2 className="text-lg font-semibold tracking-tight">Your listings</h2>
        {isLoading || products === undefined ? (
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-lg" />)}
          </div>
        ) : products.length === 0 ? (
          <div className="mt-4 flex flex-col items-center rounded-lg border border-dashed py-12 text-center">
            <ImagePlus className="h-8 w-8 text-muted-foreground/50" aria-hidden />
            <p className="mt-2 text-sm font-medium">No products yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Upload your first product using the form above.</p>
          </div>
        ) : (
          <div className="mt-4 grid max-h-[32rem] grid-cols-2 gap-4 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-5">
            {products.map((p) => (
              <ProductRow key={p.id} product={p} onDeleted={loadProducts} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function ProductRow({ product, onDeleted }: { product: ProductDto; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    setDeleting(true);
    try {
      await fetch(`/api/products/${product.id}`, { method: 'DELETE' });
      onDeleted();
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Card className="group overflow-hidden">
      <div className="bg-white p-2">
        <ProductImage src={product.imageData} alt={product.name} className="aspect-square w-full rounded-md object-contain" />
      </div>
      <CardContent className="px-3 pb-3 pt-2">
        <p className="truncate text-xs font-medium">{product.name}</p>
        <div className="mt-1 flex items-center justify-between">
          <p className="text-xs font-semibold tabular-nums">{formatZAR(product.price)}</p>
          <Badge variant={product.stock > 0 ? 'outline' : 'secondary'} className="text-[10px]">
            {product.stock > 0 ? `${product.stock} left` : 'sold out'}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 w-full gap-1 text-xs text-muted-foreground hover:text-destructive"
          onClick={remove}
          disabled={deleting}
        >
          {deleting ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Trash2 className="h-3 w-3" aria-hidden />}
          Remove
        </Button>
      </CardContent>
    </Card>
  );
}

function UploadForm({ seller, onUploaded }: { seller: SellerDto; onUploaded: (original: string, product: ProductDto) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', category: '', price: '', stock: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pickFile = (f: File | null) => {
    if (!f) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
      setError('Photo must be a JPEG, PNG or WebP file');
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      setError('Photo must be smaller than 10MB');
      return;
    }
    setError(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Choose a product photo first');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set('sellerId', seller.id);
      fd.set('name', form.name);
      fd.set('description', form.description);
      fd.set('category', form.category);
      fd.set('price', form.price);
      fd.set('stock', form.stock || '0');
      fd.set('image', file);
      const res = await fetch('/api/products', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      onUploaded(preview ?? '', data.product);
      setFile(null);
      setPreview(null);
      setForm({ name: '', description: '', category: '', price: '', stock: '' });
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UploadCloud className="h-5 w-5 text-primary" aria-hidden /> List a new product
        </CardTitle>
        <CardDescription>
          Drop in any product photo — the background is removed and replaced with white automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <div
            className="relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors hover:border-primary/50 hover:bg-primary/[0.03]"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
            role="button"
            tabIndex={0}
            aria-label="Choose a product photo"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0] ?? null); }}
          >
            {preview ? (
              <ProductImage src={preview} alt="Selected product photo preview" className="max-h-40 rounded-md object-contain" />
            ) : (
              <>
                <ImagePlus className="h-8 w-8 text-muted-foreground/60" aria-hidden />
                <p className="text-sm font-medium">Click or drop a photo here</p>
                <p className="text-xs text-muted-foreground">JPEG, PNG or WebP · up to 10MB</p>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              aria-label="Product photo file input"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="product-name">Product name</Label>
            <Input id="product-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Hand-beaded bracelet" required minLength={3} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="product-description">Description</Label>
            <Textarea id="product-description" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Materials, dimensions, what makes it special…" rows={3} required minLength={10} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5 sm:col-span-3">
              <Label>Category</Label>
              <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))} required>
                <SelectTrigger aria-label="Product category">
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="product-price">Price (ZAR)</Label>
              <Input id="product-price" type="number" min="0.01" step="0.01" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} placeholder="249.99" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="product-stock">Stock</Label>
              <Input id="product-stock" type="number" min="0" step="1" value={form.stock} onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))} placeholder="20" required />
            </div>
          </div>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" className="gap-2" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Removing background…
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4" aria-hidden /> Upload with white background
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function UploadResult({ upload }: { upload: { original: string; processed: ProductDto } | null }) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" aria-hidden /> Background studio
        </CardTitle>
        <CardDescription>Your original photo next to the auto-processed listing photo.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 items-center justify-center">
        {upload === null ? (
          <div className="flex flex-col items-center py-10 text-center text-sm text-muted-foreground">
            <Wand2 className="h-8 w-8 text-muted-foreground/40" aria-hidden />
            <p className="mt-2 max-w-[260px]">
              Upload a product to see the automatic white-background conversion here.
            </p>
          </div>
        ) : (
          <div className="grid w-full grid-cols-2 gap-4">
            <figure>
              <div className="rounded-lg border bg-muted/30 p-3">
                <ProductImage src={upload.original} alt="Original product photo as uploaded" className="aspect-square w-full rounded-md object-contain" />
              </div>
              <figcaption className="mt-2 text-center text-xs text-muted-foreground">Original upload</figcaption>
            </figure>
            <figure>
              <div className="rounded-lg border-2 border-primary/40 bg-white p-3">
                <ProductImage src={upload.processed.imageData} alt={`Processed ${upload.processed.name} on white background`} className="aspect-square w-full rounded-md object-contain" />
              </div>
              <figcaption className="mt-2 flex items-center justify-center gap-1 text-center text-xs">
                <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                  <Sparkles className="h-3 w-3" aria-hidden /> White background applied
                </Badge>
              </figcaption>
            </figure>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
