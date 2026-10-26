'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Crosshair, Star, Trash2, Plus, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { captureGpsFix, reverseGeocode, formatAddressLine, type GeoParts, type GpsFix } from '@/lib/geo';
import { LocationAutocomplete, type AddressSuggestion } from './location-autocomplete';
import { useSession } from 'next-auth/react';
import { navigate } from './header';
import { readJson } from '@/lib/utils';

export interface AddressDto {
  id: string;
  label: string;
  recipientName: string;
  phone: string;
  street: string;
  city: string;
  province: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  locationSource: string;
  isDefault: boolean;
  createdAt: string;
}

/**
 * Saved delivery locations — the "always deliver here" system.
 * A user captures their real-time GPS position once; every future checkout
 * pre-fills it and couriers get the precise fix alongside the typed address.
 */
export function AddressesPanel() {
  const { data: session, status } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const addresses = useQuery<{ addresses: AddressDto[] }>({
    queryKey: ['addresses'],
    queryFn: async () => {
      const res = await fetch('/api/addresses');
      if (!res.ok) throw new Error('Could not load saved locations');
      return readJson(res);
    },
    enabled: Boolean(session),
  });

  const setDefault = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/addresses/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed');
    },
    onSuccess: () => {
      toast({ title: 'Default delivery location updated' });
      queryClient.invalidateQueries({ queryKey: ['addresses'] });
    },
    onError: (e: Error) => toast({ title: 'Locations', description: e.message, variant: 'destructive' }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/addresses/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed');
    },
    onSuccess: () => {
      toast({ title: 'Location removed' });
      queryClient.invalidateQueries({ queryKey: ['addresses'] });
    },
    onError: (e: Error) => toast({ title: 'Locations', description: e.message, variant: 'destructive' }),
  });

  if (status === 'loading') return <Skeleton className="h-40 w-full rounded-lg" />;

  if (!session) {
    return (
      <div className="rounded-lg border bg-card p-10 text-center">
        <MapPin className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="mt-2 text-sm font-medium">Sign in to save delivery locations</p>
        <p className="mt-1 text-xs text-muted-foreground">Save your home, work or any spot once — we deliver there every time.</p>
        <Button className="mt-4" onClick={() => navigate({ name: 'signin' })}>Sign in</Button>
      </div>
    );
  }

  const items = addresses.data?.addresses ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold">Delivery locations</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Save where you want things delivered — including your real-time GPS position — and every order is addressed correctly by default.
            </p>
          </div>
        </div>

        {addresses.isLoading ? (
          <div className="mt-4 space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-md" />)}</div>
        ) : items.length === 0 ? (
          <div className="mt-4 flex items-start gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>No saved locations yet. Add one below — tap <strong>Use my current location</strong> to capture where you are right now.</p>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {items.map((a) => (
              <li key={a.id} className="rounded-md border p-4" aria-label={`Saved location ${a.label}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold">{a.label}</p>
                      {a.isDefault && <Badge className="bg-primary text-primary-foreground">Always deliver here</Badge>}
                      {a.locationSource === 'gps' && (
                        <Badge variant="outline" className="text-primary">
                          <Crosshair className="mr-1 h-3 w-3" aria-hidden /> GPS pinned
                        </Badge>
                      )}
                      {a.locationSource === 'search' && (
                        <Badge variant="outline" className="text-primary">
                          <MapPin className="mr-1 h-3 w-3" aria-hidden /> Pinned from search
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm">{a.recipientName} · {a.phone}</p>
                    <p className="text-xs text-muted-foreground">{[a.street, a.city, a.province, a.postalCode].filter(Boolean).join(', ')}</p>
                    {a.latitude !== null && a.longitude !== null && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Pinned at {a.latitude.toFixed(5)}, {a.longitude.toFixed(5)}{a.accuracyMeters != null ? ` · ±${a.accuracyMeters} m` : ''} — sent to the courier with every order
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {!a.isDefault && (
                      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setDefault.mutate(a.id)} disabled={setDefault.isPending}>
                        <Star className="mr-1 h-3 w-3" aria-hidden /> Make default
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${a.label}`}
                      onClick={() => {
                        if (window.confirm(`Remove "${a.label}" from your delivery locations?`)) remove.mutate(a.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AddLocationForm
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['addresses'] })}
      />
    </div>
  );
}

function AddLocationForm({ onSaved }: { onSaved: () => void }) {
  const { toast } = useToast();
  const [label, setLabel] = useState('Home');
  const [recipientName, setRecipientName] = useState('');
  const [phone, setPhone] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [province, setProvince] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);

  const [gpsState, setGpsState] = useState<'idle' | 'locating' | 'geocoding' | 'done' | 'partial' | 'error'>('idle');
  const [gpsMessage, setGpsMessage] = useState<string | null>(null);
  const [fix, setFix] = useState<GpsFix | null>(null);
  // Coordinates from an address-search pick (Google-Maps-style suggestion) —
  // not a live GPS fix, but still an exact pin the courier can use.
  const [searchPin, setSearchPin] = useState<{ latitude: number; longitude: number } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label,
          recipientName,
          phone,
          street,
          city,
          province,
          postalCode,
          latitude: fix?.latitude ?? searchPin?.latitude,
          longitude: fix?.longitude ?? searchPin?.longitude,
          accuracyMeters: fix?.accuracyMeters ?? undefined,
          locationSource: fix ? 'gps' : searchPin ? 'search' : 'manual',
          isDefault: makeDefault,
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error ?? 'Could not save');
      return data;
    },
    onSuccess: () => {
      toast({ title: 'Location saved', description: makeDefault ? 'We will always deliver here by default.' : 'Pick it at checkout any time.' });
      setStreet(''); setCity(''); setProvince(''); setPostalCode('');
      setFix(null); setSearchPin(null); setGpsState('idle'); setGpsMessage(null);
      onSaved();
    },
    onError: (e: Error) => toast({ title: 'Locations', description: e.message, variant: 'destructive' }),
  });

  async function useCurrentLocation() {
    setGpsState('locating');
    setGpsMessage(null);
    try {
      const captured = await captureGpsFix();
      setFix(captured);
      setGpsState('geocoding');
      const parts = await reverseGeocode(captured);
      if (parts) {
        if (parts.street) setStreet(parts.street);
        if (parts.city) setCity(parts.city);
        if (parts.province) setProvince(parts.province);
        if (parts.postalCode) setPostalCode(parts.postalCode);
        setGpsState('done');
        setGpsMessage(`Pinned ${captured.latitude.toFixed(5)}, ${captured.longitude.toFixed(5)}${captured.accuracyMeters != null ? ` (±${captured.accuracyMeters} m)` : ''} — this exact pin is saved and sent to the courier on every order. Check the fields below and adjust if needed.`);
      } else {
        setGpsState('partial');
        setGpsMessage('Location captured, but we could not name the street automatically. Type the address — your exact GPS pin is still saved.');
      }
    } catch (e) {
      setFix(null);
      setGpsState('error');
      setGpsMessage(e instanceof Error ? e.message : 'Location detection failed.');
    }
  }

  /** Google-Maps-style pick: fill the whole address + keep the exact pin. */
  function pickSuggestion(s: AddressSuggestion) {
    setStreet(s.street || s.main);
    setCity(s.city);
    setProvince(s.province);
    setPostalCode(s.postalCode);
    setSearchPin({ latitude: s.latitude, longitude: s.longitude });
    setFix(null);
    setGpsState('idle');
    setGpsMessage(`Address found — pinned at ${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}. This exact pin is saved and sent to the courier on every order. Adjust the fields if needed.`);
  }

  const canSave = recipientName.trim().length >= 2 && phone.replace(/\D/g, '').length >= 9 && street.trim().length >= 4 && city.trim().length >= 2 && province.trim().length >= 2 && postalCode.replace(/\D/g, '').length >= 4;

  return (
    <div className="rounded-lg border bg-card p-4 sm:p-6">
      <h2 className="flex items-center gap-2 text-base font-bold"><Plus className="h-4 w-4" aria-hidden /> Add a delivery location</h2>

      <Button
        type="button"
        variant="outline"
        className="mt-4 w-full sm:w-auto"
        onClick={useCurrentLocation}
        disabled={gpsState === 'locating' || gpsState === 'geocoding'}
      >
        {gpsState === 'locating' || gpsState === 'geocoding' ? (
          <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> {gpsState === 'locating' ? 'Finding you…' : 'Naming your location…'}</>
        ) : (
          <><Crosshair className="mr-2 h-4 w-4" aria-hidden /> Use my current location</>
        )}
      </Button>

      {gpsMessage && (
        <p
          className={`mt-3 flex items-start gap-2 rounded-md border p-3 text-xs ${gpsState === 'error' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-primary/30 bg-primary/5 text-foreground'}`}
          role="status"
        >
          {gpsState === 'error' && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
          {gpsMessage}
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="addr-label">Label</Label>
          <Input id="addr-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Home, Work…" maxLength={40} />
        </div>
        <div>
          <Label htmlFor="addr-name">Recipient name</Label>
          <Input id="addr-name" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="Who receives the parcel" required minLength={2} />
        </div>
        <div>
          <Label htmlFor="addr-phone">Contact number</Label>
          <Input id="addr-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 082 123 4567" required />
        </div>
        <div>
          <Label htmlFor="addr-street">Street address{fix ? ' (GPS-assisted)' : searchPin ? ' (found from search)' : ''}</Label>
          <LocationAutocomplete
            as="input"
            id="addr-street"
            value={street}
            onValueChange={(v) => {
              setStreet(v);
              // Typing by hand releases the search pick (fields stay filled
              // for editing, but the pin is no longer claimed).
              if (searchPin) setSearchPin(null);
            }}
            onPick={pickSuggestion}
            placeholder="Start typing — e.g. 12 Main Road, Mowbray"
            required
            minLength={4}
            ariaLabel="Street address with suggestions"
          />
        </div>
        <div>
          <Label htmlFor="addr-city">City / town</Label>
          <Input id="addr-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Cape Town" required minLength={2} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="addr-province">Province</Label>
            <Input id="addr-province" value={province} onChange={(e) => setProvince(e.target.value)} placeholder="e.g. Western Cape" required minLength={2} />
          </div>
          <div>
            <Label htmlFor="addr-postal">Postal code</Label>
            <Input id="addr-postal" inputMode="numeric" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} placeholder="8001" required />
          </div>
        </div>
      </div>

      <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox checked={makeDefault} onCheckedChange={(v) => setMakeDefault(v === true)} id="addr-default" />
        <span>Always deliver here — make this my default location</span>
      </label>

      <Button className="mt-4" onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
        {save.isPending ? 'Saving…' : 'Save location'}
      </Button>
      {!canSave && <p className="mt-2 text-[11px] text-muted-foreground">Fill in the recipient, contact number and full address to save.</p>}
    </div>
  );
}

/** Convenience helper reused by checkout: a one-line printable address. */
export function addressLineOf(a: Pick<AddressDto, 'street' | 'city' | 'province' | 'postalCode'>): string {
  return formatAddressLine(a as GeoParts);
}
