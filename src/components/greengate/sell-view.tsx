'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { Camera, ImageIcon, Lock, Plus, Store, Trash2, TriangleAlert, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, type ProductSummary } from '@/lib/types';
import { navigate, type Category } from './header';
import { readJson } from '@/lib/utils';
import { PlanSummary } from './plan-summary';

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
    // A failed load must NOT read as "no store": that showed existing
    // sellers the create-a-store screen whenever one request failed.
    queryFn: async () => {
      const res = await fetch('/api/sellers?mine=1');
      if (!res.ok) throw new Error('Could not load your store');
      return res.json();
    },
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

  if (mine.isError) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-4 px-4 py-20 text-center">
        <p className="text-sm font-medium">We could not load your store right now</p>
        <p className="text-xs text-muted-foreground">Check your connection — your store and listings are safe.</p>
        <Button onClick={() => void mine.refetch()} disabled={mine.isFetching}>{mine.isFetching ? 'Trying again…' : 'Try again'}</Button>
      </main>
    );
  }

  // A lapsed subscription pauses the store: listing tools stay locked until
  // the seller renews in the dashboard (the API refuses with 402 as well).
  if ((mine.data?.store as { access?: { state?: string } } | null | undefined)?.access?.state === 'expired') {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center gap-4 px-4 py-20 text-center" data-testid="store-paused">
        <Lock className="h-8 w-8 text-destructive" aria-hidden />
        <p className="text-sm font-medium">Your store is paused</p>
        <p className="text-xs text-muted-foreground">
          Your Green Gate subscription has ended, so your store and products are hidden from buyers and your listing tools are locked.
          Renew in your seller dashboard — everything comes back instantly.
        </p>
        <Button onClick={() => navigate({ name: 'dashboard' })}>Renew in my dashboard</Button>
      </main>
    );
  }

  return mine.data?.store
    ? <ProductManager />
    : <StoreOnboarding onCreated={() => { mine.refetch(); }} />;
}

// ---------------------------------------------------------------------------
// Store onboarding — a thorough seller application (6 steps, ~30 questions)
// ---------------------------------------------------------------------------

const SA_PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
  'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape', 'Other',
];

const BANKS = [
  'Absa', 'Capitec Bank', 'Discovery Bank', 'FNB', 'Investec', 'Nedbank',
  'Standard Bank', 'TymeBank', 'Other bank',
];

const APPLICATION_STEPS = ['Store identity', 'Business details', 'Collection address', 'Banking & payouts', 'Products & fulfilment', 'Declarations'] as const;

interface ApplicationDraft {
  name: string;
  description: string;
  location: string;
  phone: string;
  businessType: string;
  businessName: string;
  registrationNumber: string;
  ownsBrand: boolean;
  streetAddress: string;
  city: string;
  province: string;
  postalCode: string;
  websiteOrSocial: string;
  bankName: string;
  bankAccountType: string;
  bankAccountNumber: string;
  bankBranchCode: string;
  bankAccountHolder: string;
  productCategories: string[];
  sourcing: string;
  monthlyVolume: string;
  dispatchDays: string;
  returnsDays: string;
  confirmAge: boolean;
  confirmAccuracy: boolean;
  confirmTerms: boolean;
  signature: string;
}

const EMPTY_DRAFT: ApplicationDraft = {
  name: '', description: '', location: '', phone: '',
  businessType: '', businessName: '', registrationNumber: '', ownsBrand: false,
  streetAddress: '', city: '', province: '', postalCode: '', websiteOrSocial: '',
  bankName: '', bankAccountType: '', bankAccountNumber: '', bankBranchCode: '', bankAccountHolder: '',
  productCategories: [], sourcing: '', monthlyVolume: '', dispatchDays: '2', returnsDays: '7',
  confirmAge: false, confirmAccuracy: false, confirmTerms: false, signature: '',
};

const DRAFT_KEY = 'greengate-seller-application';

function loadDraft(): { draft: ApplicationDraft; hadDraft: boolean } {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return { draft: EMPTY_DRAFT, hadDraft: false };
    return {
      draft: { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Partial<ApplicationDraft>) },
      hadDraft: true,
    };
  } catch {
    return { draft: EMPTY_DRAFT, hadDraft: false };
  }
}

function StoreOnboarding({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  // Restored once at mount — no state-in-effect cascades.
  const [restored] = useState(() => (typeof window === 'undefined' ? { draft: EMPTY_DRAFT, hadDraft: false } : loadDraft()));
  const [data, setData] = useState<ApplicationDraft>(restored.draft);
  const hadDraft = restored.hadDraft;
  const [logo, setLogo] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [stepErrors, setStepErrors] = useState<string[]>([]);

  // Draft persistence: a seller who steps away never loses their application.
  useEffect(() => {
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    } catch {
      // storage unavailable — application still works, just not saved
    }
  }, [data]);

  const set = <K extends keyof ApplicationDraft>(key: K, value: ApplicationDraft[K]) =>
    setData((d) => ({ ...d, [key]: value }));

  const { data: cats } = useQuery<{ categories: Category[] }>({
    queryKey: ['categories'],
    // A failed load must throw (so it retries) — a cached error body left
    // sellers with no categories to pick for minutes.
    queryFn: async () => {
      const res = await fetch('/api/categories');
      if (!res.ok) throw new Error('Could not load categories');
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const toggleCategory = (slug: string) =>
    setData((d) => ({
      ...d,
      productCategories: d.productCategories.includes(slug)
        ? d.productCategories.filter((s) => s !== slug)
        : [...d.productCategories, slug],
    }));

  const validateStep = (s: number): string[] => {
    const e: string[] = [];
    if (s === 0) {
      if (data.name.trim().length < 2 || data.name.trim().length > 60) e.push('Store name must be 2–60 characters');
      if (data.location.trim().length < 2) e.push('Enter your trading location (city, suburb)');
      if (data.phone.replace(/\D/g, '').length < 9) e.push('Enter a valid contact number');
    }
    if (s === 1) {
      if (!data.businessType) e.push('Select your business type');
      // Registration / tax / ID are never required — Green Gate keeps the
      // application light; the team verifies businesses after approval.
    }
    if (s === 2) {
      if (data.streetAddress.trim().length < 4) e.push('Enter the street address for courier collections and returns');
      if (data.city.trim().length < 2) e.push('Enter your city');
      if (!data.province) e.push('Select your province');
      if (!/^\d{4}$/.test(data.postalCode.trim())) e.push('Postal code must be 4 digits');
    }
    if (s === 3) {
      if (!data.bankName) e.push('Select your bank');
      if (!data.bankAccountType) e.push('Select your account type');
      if (!/^\d{4,17}$/.test(data.bankAccountNumber.trim())) e.push('Account number must be 4–17 digits');
      if (!/^\d{4,6}$/.test(data.bankBranchCode.trim())) e.push('Branch code must be 4–6 digits');
      if (data.bankAccountHolder.trim().length < 2) e.push('Enter the account holder name exactly as your bank has it');
    }
    if (s === 4) {
      if (data.productCategories.length === 0) e.push('Select at least one category you will sell in');
      // Sourcing and expected volume are optional context, not gates.
      const dd = Number(data.dispatchDays);
      if (!Number.isFinite(dd) || dd < 1 || dd > 30) e.push('Dispatch time must be 1–30 days');
      const rd = Number(data.returnsDays);
      if (!Number.isFinite(rd) || rd < 0 || rd > 90) e.push('Return window must be 0–90 days');
    }
    if (s === 5) {
      if (!data.confirmAge) e.push('Confirm that you are 18 or older');
      if (!data.confirmAccuracy) e.push('Confirm that your information is accurate');
      if (!data.confirmTerms) e.push('Accept the seller terms and privacy policy');
      if (data.signature.trim().length < 2) e.push('Type your full name as an electronic signature');
    }
    return e;
  };

  const goNext = () => {
    const errors = validateStep(step);
    setStepErrors(errors);
    if (errors.length === 0) setStep((s) => Math.min(s + 1, APPLICATION_STEPS.length - 1));
  };

  const create = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      const F = (key: string, value: string | number | boolean) => form.set(key, String(value));
      F('name', data.name);
      F('description', data.description);
      F('location', data.location);
      F('phone', data.phone);
      F('businessType', data.businessType);
      F('businessName', data.businessName);
      F('registrationNumber', data.registrationNumber);
      F('ownsBrand', data.ownsBrand ? '1' : '0');
      F('streetAddress', data.streetAddress);
      F('city', data.city);
      F('province', data.province);
      F('postalCode', data.postalCode);
      F('websiteOrSocial', data.websiteOrSocial);
      F('bankName', data.bankName);
      F('bankAccountType', data.bankAccountType);
      F('bankAccountNumber', data.bankAccountNumber);
      F('bankBranchCode', data.bankBranchCode);
      F('bankAccountHolder', data.bankAccountHolder);
      F('productCategories', data.productCategories.join(','));
      F('sourcing', data.sourcing);
      F('monthlyVolume', data.monthlyVolume);
      F('dispatchDays', data.dispatchDays);
      F('returnsDays', data.returnsDays);
      F('confirmAge', data.confirmAge ? '1' : '0');
      F('confirmAccuracy', data.confirmAccuracy ? '1' : '0');
      F('confirmTerms', data.confirmTerms ? '1' : '0');
      if (logo) form.set('images', logo);
      const res = await fetch('/api/sellers', { method: 'POST', body: form });
      const out = await readJson(res);
      if (!res.ok) throw new Error(out.error ?? 'Could not submit the application');
      return out;
    },
    onSuccess: () => {
      try {
        window.localStorage.removeItem(DRAFT_KEY);
      } catch {
        // ignore
      }
      toast({ title: 'Application submitted — under review', description: 'The Green Gate team reviews every application. You will be notified here and by email as soon as a decision is made.' });
      onCreated();
    },
    onError: (e: Error) => toast({ title: 'Application', description: e.message, variant: 'destructive' }),
  });

  const submitFinal = () => {
    // Validate every step before sending — nothing left behind.
    for (let s = 0; s < APPLICATION_STEPS.length; s++) {
      const errors = validateStep(s);
      if (errors.length > 0) {
        setStep(s);
        setStepErrors(errors);
        return;
      }
    }
    setStepErrors([]);
    create.mutate();
  };

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold">Seller application</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        A short application — your store, a collection address for the courier and your payout details.
        No tax or ID numbers needed. Your progress is saved automatically — you can leave and finish later.
      </p>
      {step === 0 && <PlanSummary />}
      {hadDraft && step === 0 && (
        <p className="mt-3 rounded-md border bg-secondary px-3 py-2 text-xs text-secondary-foreground">
          We restored your saved draft. Re-attach a logo if you had picked one.
        </p>
      )}

      {/* Progress */}
      <ol className="mt-6 grid grid-cols-6 gap-1.5" aria-label="Application progress">
        {APPLICATION_STEPS.map((label, i) => (
          <li key={label} className="space-y-1.5">
            <div className={`h-1 rounded-sm ${i <= step ? 'bg-primary' : 'bg-border'}`} />
            <p className={`hidden text-[10px] leading-tight sm:block ${i === step ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
              {i + 1}. {label}
            </p>
          </li>
        ))}
      </ol>

      <div className="mt-5 rounded-lg border bg-card p-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Step {step + 1} of {APPLICATION_STEPS.length}</p>
        <h2 className="mt-1 text-lg font-bold">{APPLICATION_STEPS[step]}</h2>

        {stepErrors.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive" role="alert">
            {stepErrors.map((err) => <li key={err}>• {err}</li>)}
          </ul>
        )}

        <div className="mt-4 space-y-4">
          {step === 0 && (
            <>
              <div>
                <Label htmlFor="store-name">Store name *</Label>
                <Input id="store-name" value={data.name} onChange={(e) => set('name', e.target.value)} maxLength={60} placeholder="e.g. Cape Thread Co." />
              </div>
              <div>
                <Label htmlFor="store-desc">What will you sell? (optional for now)</Label>
                <Textarea id="store-desc" value={data.description} onChange={(e) => set('description', e.target.value)} placeholder="A short description buyers will see on your store page." />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="store-location">Trading location *</Label>
                  <Input id="store-location" value={data.location} onChange={(e) => set('location', e.target.value)} placeholder="City, suburb" />
                </div>
                <div>
                  <Label htmlFor="store-phone">Contact number *</Label>
                  <Input id="store-phone" type="tel" value={data.phone} onChange={(e) => set('phone', e.target.value)} />
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
                {preview && <img src={preview} alt="Logo preview" className="mt-2 h-16 w-16 rounded-md border object-cover" />}
                <p className="mt-1 text-[11px] text-muted-foreground">AI-generated logos are rejected — use a real photo of your brand or products.</p>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div>
                <Label htmlFor="biz-type">Business type *</Label>
                <Select value={data.businessType} onValueChange={(v) => set('businessType', v)}>
                  <SelectTrigger id="biz-type"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="individual">Individual / sole trader (no registered entity)</SelectItem>
                    <SelectItem value="sole_proprietor">Sole proprietorship</SelectItem>
                    <SelectItem value="partnership">Partnership</SelectItem>
                    <SelectItem value="pty">Private company (Pty) Ltd</SelectItem>
                    <SelectItem value="cc">Close corporation</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="biz-name">Registered business name (if registered)</Label>
                <Input id="biz-name" value={data.businessName} onChange={(e) => set('businessName', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="biz-reg">Company / CC registration number (optional)</Label>
                <Input id="biz-reg" value={data.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} />
                <p className="mt-1 text-[11px] text-muted-foreground">Only if you have one — never required to start selling.</p>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="owns-brand" checked={data.ownsBrand} onCheckedChange={(v) => set('ownsBrand', v === true)} />
                <Label htmlFor="owns-brand" className="text-sm font-normal">I make or own the brand(s) I will sell</Label>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <Label htmlFor="addr-street">Street address (courier collections & returns) *</Label>
                <Input id="addr-street" value={data.streetAddress} onChange={(e) => set('streetAddress', e.target.value)} placeholder="Unit, complex, street" />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <Label htmlFor="addr-city">City / town *</Label>
                  <Input id="addr-city" value={data.city} onChange={(e) => set('city', e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="addr-postal">Postal code *</Label>
                  <Input id="addr-postal" inputMode="numeric" value={data.postalCode} onChange={(e) => set('postalCode', e.target.value.replace(/\D/g, '').slice(0, 4))} />
                </div>
              </div>
              <div>
                <Label htmlFor="addr-province">Province *</Label>
                <Select value={data.province} onValueChange={(v) => set('province', v)}>
                  <SelectTrigger id="addr-province"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {SA_PROVINCES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="addr-web">Website or social handle (optional)</Label>
                <Input id="addr-web" value={data.websiteOrSocial} onChange={(e) => set('websiteOrSocial', e.target.value)} placeholder="e.g. @capethread" />
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <Label htmlFor="bank-name">Bank *</Label>
                <Select value={data.bankName} onValueChange={(v) => set('bankName', v)}>
                  <SelectTrigger id="bank-name"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {BANKS.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="bank-type">Account type *</Label>
                  <Select value={data.bankAccountType} onValueChange={(v) => set('bankAccountType', v)}>
                    <SelectTrigger id="bank-type"><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cheque">Cheque / current</SelectItem>
                      <SelectItem value="savings">Savings</SelectItem>
                      <SelectItem value="transmission">Transmission</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="bank-branch">Branch / universal code *</Label>
                  <Input id="bank-branch" inputMode="numeric" value={data.bankBranchCode} onChange={(e) => set('bankBranchCode', e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="e.g. 051001" />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="bank-acc">Account number *</Label>
                  <Input id="bank-acc" inputMode="numeric" value={data.bankAccountNumber} onChange={(e) => set('bankAccountNumber', e.target.value.replace(/\D/g, '').slice(0, 17))} />
                </div>
                <div>
                  <Label htmlFor="bank-holder">Account holder *</Label>
                  <Input id="bank-holder" value={data.bankAccountHolder} onChange={(e) => set('bankAccountHolder', e.target.value)} />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Payouts for confirmed sales are transferred to this account. Details are encrypted at rest and never shared with buyers.
              </p>
            </>
          )}

          {step === 4 && (
            <>
              <fieldset>
                <legend className="text-sm font-medium">Which categories will you sell in? *</legend>
                <div className="mt-2 grid grid-cols-2 gap-2 rounded-md border p-3 sm:grid-cols-3">
                  {(cats?.categories ?? []).map((c) => (
                    <label key={c.slug} className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={data.productCategories.includes(c.slug)}
                        onCheckedChange={() => toggleCategory(c.slug)}
                        aria-label={c.name}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="sourcing">Where do your products come from? (optional)</Label>
                  <Select value={data.sourcing} onValueChange={(v) => set('sourcing', v)}>
                    <SelectTrigger id="sourcing"><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="own_make">I make them myself</SelectItem>
                      <SelectItem value="wholesale">Wholesale suppliers</SelectItem>
                      <SelectItem value="vintage">Vintage / second-hand sourcing</SelectItem>
                      <SelectItem value="mixed">A mix of the above</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="volume">Expected orders per month (optional)</Label>
                  <Select value={data.monthlyVolume} onValueChange={(v) => set('monthlyVolume', v)}>
                    <SelectTrigger id="volume"><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1-20">1–20</SelectItem>
                      <SelectItem value="21-50">21–50</SelectItem>
                      <SelectItem value="51-200">51–200</SelectItem>
                      <SelectItem value="201-500">201–500</SelectItem>
                      <SelectItem value="500+">More than 500</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="dispatch">Dispatch time after an order (days) *</Label>
                  <Input id="dispatch" inputMode="numeric" value={data.dispatchDays} onChange={(e) => set('dispatchDays', e.target.value.replace(/\D/g, '').slice(0, 2))} />
                </div>
                <div>
                  <Label htmlFor="returns">Your return window (days) *</Label>
                  <Input id="returns" inputMode="numeric" value={data.returnsDays} onChange={(e) => set('returnsDays', e.target.value.replace(/\D/g, '').slice(0, 2))} />
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    Green Gate sales are final — no refunds for change of mind. Buyers keep their legal rights: faulty, wrong or undelivered items, and the 7-day cooling-off for online orders.
                  </p>
                </div>
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <div className="space-y-2.5">
                <div className="flex items-start gap-2">
                  <Checkbox id="c-age" checked={data.confirmAge} onCheckedChange={(v) => set('confirmAge', v === true)} className="mt-0.5" />
                  <Label htmlFor="c-age" className="text-sm font-normal leading-relaxed">I am 18 years or older and legally allowed to trade. *</Label>
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox id="c-accurate" checked={data.confirmAccuracy} onCheckedChange={(v) => set('confirmAccuracy', v === true)} className="mt-0.5" />
                  <Label htmlFor="c-accurate" className="text-sm font-normal leading-relaxed">The information in this application is true and accurate, and I am authorised to sell these products. *</Label>
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox id="c-terms" checked={data.confirmTerms} onCheckedChange={(v) => set('confirmTerms', v === true)} className="mt-0.5" />
                  <Label htmlFor="c-terms" className="block text-sm font-normal leading-relaxed">
                    <span>
                      I accept the{' '}
                      <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => navigate({ name: 'terms' })}>seller terms</button>
                      {' '}and{' '}
                      <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => navigate({ name: 'privacy' })}>privacy policy</button>
                      , including the real-photos-only policy (AI-generated imagery is rejected automatically). *
                    </span>
                  </Label>
                </div>
              </div>
              <div>
                <Label htmlFor="signature">Electronic signature — type your full name *</Label>
                <Input id="signature" value={data.signature} onChange={(e) => set('signature', e.target.value)} placeholder="Your full name" autoComplete="off" />
              </div>
            </>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={step === 0 || create.isPending}
            onClick={() => { setStepErrors([]); setStep((s) => s - 1); }}
          >
            Back
          </Button>
          {step < APPLICATION_STEPS.length - 1 ? (
            <Button type="button" onClick={goNext}>Continue</Button>
          ) : (
            <Button type="button" disabled={create.isPending} onClick={submitFinal}>
              {create.isPending ? 'Submitting application…' : 'Submit application'}
            </Button>
          )}
        </div>
      </div>
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
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.1fr] [&>*]:min-w-0">
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
  // Parcel size the seller will box the item in — The Courier Guy charges on
  // the greater of actual vs volumetric weight, so these keep quotes honest.
  const [lengthCm, setLengthCm] = useState('30');
  const [widthCm, setWidthCm] = useState('25');
  const [heightCm, setHeightCm] = useState('15');
  const [tags, setTags] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [hasVariants, setHasVariants] = useState(false);
  const [variants, setVariants] = useState<VariantDraft[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: cats } = useQuery<{ categories: Category[] }>({
    queryKey: ['categories'],
    // A failed load must throw (so it retries) — a cached error body left
    // sellers with no categories to pick for minutes.
    queryFn: async () => {
      const res = await fetch('/api/categories');
      if (!res.ok) throw new Error('Could not load categories');
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const childCats = (cats?.categories ?? []).find((c) => c.slug === category)?.children ?? [];

  const pickImages = (files: FileList | null) => {
    if (!files) return;
    // Same rules the server enforces (JPEG/PNG/WebP, ≤8MB each, max 8) —
    // catching problems here gives instant feedback instead of a failed
    // upload after minutes of waiting.
    const rejected: string[] = [];
    const accepted: File[] = [];
    for (const f of [...files]) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { rejected.push(`${f.name} — not a JPEG, PNG or WebP`); continue; }
      if (f.size > 8 * 1024 * 1024) { rejected.push(`${f.name} — over 8MB`); continue; }
      accepted.push(f);
    }
    const capped = accepted.slice(0, 8);
    if (accepted.length > 8) rejected.push(`${accepted.length - 8} extra photo${accepted.length - 8 > 1 ? 's' : ''} — 8 maximum`);
    if (rejected.length > 0) {
      toast({ title: 'Some photos were skipped', description: rejected.slice(0, 3).join(', ') + (rejected.length > 3 ? ` and ${rejected.length - 3} more` : ''), variant: 'destructive' });
    }
    if (capped.length === 0) return;
    setImages(capped);
    setPreviews(capped.map((f) => URL.createObjectURL(f)));
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
      form.set('lengthCm', lengthCm);
      form.set('widthCm', widthCm);
      form.set('heightCm', heightCm);
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
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? 'Could not create the product');
      return data;
    },
    onSuccess: () => {
      toast({ title: 'Product listed', description: 'Photos processed onto a white background and indexed for search.' });
      setName(''); setDescription(''); setPrice(''); setSalePrice(''); setStock('1'); setTags(''); setBrand(''); setWeight('1000'); setLengthCm('30'); setWidthCm('25'); setHeightCm('15');
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
        <Label htmlFor="p-length">Parcel size (cm) — what you will box it in</Label>
        <div className="grid grid-cols-3 gap-2">
          <Input id="p-length" aria-label="Parcel length in centimetres" inputMode="numeric" value={lengthCm} onChange={(e) => setLengthCm(e.target.value.replace(/\D/g, ''))} placeholder="Length" required />
          <Input id="p-width" aria-label="Parcel width in centimetres" inputMode="numeric" value={widthCm} onChange={(e) => setWidthCm(e.target.value.replace(/\D/g, ''))} placeholder="Width" required />
          <Input id="p-height" aria-label="Parcel height in centimetres" inputMode="numeric" value={heightCm} onChange={(e) => setHeightCm(e.target.value.replace(/\D/g, ''))} placeholder="Height" required />
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          The courier charges on weight OR box size (whichever is greater) — accurate sizes mean the buyer is quoted the true delivery price.
        </p>
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
          <Camera className="h-4 w-4" /> Product photos (1–8, real photos only)
        </Label>
        <Input id="p-images" ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="mt-1" onChange={(e) => pickImages(e.target.files)} />
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-secondary p-2 text-[11px] leading-relaxed text-muted-foreground">
          <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          Every photo is scanned for AI generation — synthetic images are rejected. Accepted photos are automatically placed on a clean white studio background, and any photo that cannot be cut cleanly keeps its original, undamaged look.
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

  // Real pagination: the first 500 listings load with the page; "Load more"
  // pages through older listings via ?offset=.
  const mine = useInfiniteQuery<{ products: OwnListing[]; total: number; hasMore: boolean }>({
    queryKey: ['my-products-own'],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const res = await fetch(`/api/seller/products?offset=${pageParam}`);
      // A failed load must not read as "No products yet".
      if (!res.ok) throw new Error('Could not load your listings');
      return res.json();
    },
    getNextPageParam: (last, all) => (last.hasMore ? all.reduce((n, p) => n + p.products.length, 0) : undefined),
  });

  const products = mine.data?.pages.flatMap((p) => p.products) ?? [];
  const isLoading = mine.isLoading;
  const [editingId, setEditingId] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const res = await fetch(`/api/products/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const out = await readJson(res);
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
      const out = await readJson(res);
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
    <section aria-label="Your products" className="h-fit rounded-lg border bg-card p-4 sm:p-6">
      <h2 className="flex items-center gap-2 text-lg font-bold"><ImageIcon className="h-5 w-5 text-primary" /> Your listings</h2>
      {isLoading || mine.isLoading ? (
        <div className="mt-4 space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : mine.isError && products.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed p-6 text-center">
          <p className="text-sm font-medium">We could not load your listings right now</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => void mine.refetch()} disabled={mine.isFetching}>{mine.isFetching ? 'Trying again…' : 'Try again'}</Button>
        </div>
      ) : products.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed p-8 text-center">
          <TriangleAlert className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium">No products yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Use the form to list your first product. It goes live immediately.</p>
        </div>
      ) : (
        <ul className="mt-4 max-h-[560px] space-y-2 overflow-y-auto pr-1">
          {products.map((p) => (
            <li key={p.id} className="rounded-md border p-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border bg-white dark:bg-muted">
                {p.image && (
                   
                  <img src={p.image} alt={p.name} className="h-full w-full object-cover" />
                )}
              </div>
              <div className="min-w-[8rem] flex-1">
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatMoney(p.salePriceCents ?? p.priceCents)} · {p.hasVariants ? `${p.variantStock ?? 0} in stock across ${p.variants?.length ?? 0} size${p.variants?.length === 1 ? '' : 's'}` : `${p.stock} in stock`}
                </p>
              </div>
              {/* Status + actions: beside the listing on wide screens, on their
                  own row under it on small phones so names stay readable. */}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                <Badge variant={p.status === 'approved' ? 'secondary' : 'outline'} className="text-[10px]">{p.status}</Badge>
                {['approved', 'disabled'].includes(p.status) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => toggle.mutate({ id: p.id, status: p.status === 'approved' ? 'disabled' : 'approved' })}
                  >
                    {p.status === 'approved' ? 'Disable' : 'Enable'}
                  </Button>
                ) : (
                  // Archived/rejected listings were removed by marketplace
                  // administration — sellers cannot re-list them themselves.
                  <span className="px-1 text-[10px] leading-tight text-muted-foreground">Removed by admin</span>
                )}
                {!['archived', 'rejected'].includes(p.status) && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" aria-expanded={editingId === p.id} onClick={() => setEditingId((id) => (id === p.id ? null : p.id))}>
                    {editingId === p.id ? 'Close' : 'Edit'}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-destructive"
                  onClick={() => {
                    // Removing is permanent for listings that never sold — ask first.
                    if (window.confirm(`Remove "${p.name}" from your store? Buyers will no longer see it.`)) remove.mutate(p.id);
                  }}
                >
                  Remove
                </Button>
              </div>
              </div>
              {editingId === p.id && <EditListing product={p} onDone={() => setEditingId(null)} />}
            </li>
          ))}
        </ul>
      )}
      {mine.hasNextPage && (
        <Button
          variant="outline"
          className="mt-3 w-full"
          disabled={mine.isFetchingNextPage}
          onClick={() => void mine.fetchNextPage()}
        >
          {mine.isFetchingNextPage ? 'Loading…' : `Load more listings${mine.data?.pages[0]?.total ? ` (${mine.data.pages[0].total} total)` : ''}`}
        </Button>
      )}
    </section>
  );
}

/** A seller's own listing as /api/seller/products returns it. */
type OwnListing = ProductSummary & { variants?: { id: string; sku: string; stock: number; label: string }[] };

/**
 * Inline editor for a live listing: price, sale price and stock — per size for
 * products with sizes. Sellers could only enable/disable or remove a listing
 * before, so a sold-out product could never be restocked or repriced.
 */
function EditListing({ product, onDone }: { product: OwnListing; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const sizes = product.variants ?? [];
  const [price, setPrice] = useState((product.priceCents / 100).toFixed(2));
  const [salePrice, setSalePrice] = useState(product.salePriceCents !== null ? (product.salePriceCents / 100).toFixed(2) : '');
  const [stock, setStock] = useState(String(product.stock));
  const [sizeStock, setSizeStock] = useState<Record<string, string>>(() => Object.fromEntries(sizes.map((v) => [v.id, String(v.stock)])));

  const save = useMutation({
    mutationFn: async () => {
      const p = Number(price.replace(',', '.'));
      if (!Number.isFinite(p) || p <= 0) throw new Error('Enter a price above R0.');
      const saleText = salePrice.trim().replace(',', '.');
      const sale = saleText ? Number(saleText) : null;
      if (sale !== null && (!Number.isFinite(sale) || sale <= 0 || sale >= p)) throw new Error('The sale price must be below the normal price (leave it empty for no sale).');
      const body: Record<string, unknown> = { price: p, salePrice: sale };
      if (sizes.length > 0) {
        body.variants = sizes.map((v) => ({ id: v.id, stock: Number(sizeStock[v.id] || 0) }));
      } else {
        body.stock = Number(stock || 0);
      }
      const res = await fetch(`/api/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(out.error ?? 'Could not save the listing.');
      return out;
    },
    onSuccess: () => {
      toast({ title: 'Listing updated', description: product.name });
      queryClient.invalidateQueries({ queryKey: ['my-products-own'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      onDone();
    },
    onError: (e: Error) => toast({ title: 'Could not save', description: e.message, variant: 'destructive' }),
  });

  const digits = (v: string) => v.replace(/\D/g, '');
  return (
    <form
      className="mt-2 grid gap-3 border-t pt-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      aria-label={`Edit ${product.name}`}
    >
      <div>
        <Label htmlFor={`ed-price-${product.id}`} className="text-xs">Price (R)</Label>
        <Input id={`ed-price-${product.id}`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor={`ed-sale-${product.id}`} className="text-xs">Sale price (R) — empty for no sale</Label>
        <Input id={`ed-sale-${product.id}`} inputMode="decimal" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
      </div>
      {sizes.length > 0 ? (
        <div className="sm:col-span-2">
          <p className="text-xs font-medium">Stock per size</p>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            {sizes.map((v) => (
              <label key={v.id} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">{v.label}</span>
                <Input className="h-8 w-24" inputMode="numeric" value={sizeStock[v.id] ?? ''} onChange={(e) => setSizeStock((s) => ({ ...s, [v.id]: digits(e.target.value) }))} aria-label={`Stock for ${v.label}`} />
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <Label htmlFor={`ed-stock-${product.id}`} className="text-xs">Stock</Label>
          <Input id={`ed-stock-${product.id}`} inputMode="numeric" value={stock} onChange={(e) => setStock(digits(e.target.value))} required />
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
