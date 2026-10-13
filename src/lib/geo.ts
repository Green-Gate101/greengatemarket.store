/**
 * Real-time location capture for delivery addresses.
 *
 * captureGpsFix()  — browser Geolocation API (needs the user's one-tap consent).
 * reverseGeocode() — BigDataCloud's free client-side endpoint (no API key,
 *                    CORS-enabled). If it fails we degrade gracefully: the
 *                    caller keeps the raw coordinates and the user types the
 *                    address manually — nothing blocks saving a location.
 */

export interface GpsFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
}

export interface GeoParts {
  street: string;
  city: string;
  province: string;
  postalCode: string;
}

/**
 * Captures the most ACCURATE fix obtainable in a short window.
 *
 * The first `getCurrentPosition` fix is often a coarse cell-tower/Wi-Fi fix
 * (±1–5 km). So after the initial fix we keep listening via watchPosition and
 * hand back the best (smallest accuracy radius) fix seen, stopping early once
 * we hold a good GPS lock (≤ GOOD_ACCURACY_M) or when fixes stop improving.
 * Worst case never exceeds timeoutMs + refineMs (~20 s); a first fix usually
 * arrives in 1–3 s so the UI stays responsive.
 */
export function captureGpsFix(timeoutMs = 12_000, refineMs = 7_000): Promise<GpsFix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Your browser does not support location detection.'));
      return;
    }
    let settled = false;
    let watchId: number | null = null;
    let best: GpsFix | null = null;
    let lastImprovementAt = 0;

    const finish = (fix: GpsFix) => {
      if (settled) return;
      settled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      clearTimeout(timeoutTimer);
      resolve(fix);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      clearTimeout(timeoutTimer);
      reject(new Error(message));
    };

    const consider = (pos: GeolocationPosition) => {
      const accuracy = Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null;
      const fix: GpsFix = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracyMeters: accuracy,
      };
      if (!best || (accuracy !== null && (best.accuracyMeters === null || accuracy < best.accuracyMeters))) {
        best = fix;
        lastImprovementAt = Date.now();
        if (accuracy !== null && accuracy <= GOOD_ACCURACY_M) finish(fix); // good GPS lock — stop early
      }
    };

    const timeoutTimer = setTimeout(() => {
      if (best) finish(best); // refine window ended: best fix so far
      else fail('Location detection timed out. Enter the address manually.');
    }, timeoutMs);

    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          consider(pos);
          // Refinement window: keep watching for a tighter fix, but give up
          // early when fixes have stopped improving for 3 s.
          const stopRefining = () => {
            if (best && Date.now() - lastImprovementAt >= 3_000) finish(best);
          };
          const refineTimer = setInterval(stopRefining, 500);
          setTimeout(() => { clearInterval(refineTimer); if (best) finish(best); }, refineMs);
          watchId = navigator.geolocation.watchPosition(consider, () => undefined, {
            enableHighAccuracy: true,
            timeout: refineMs,
            maximumAge: 0,
          });
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) fail('Location permission was denied. Enter the address manually or allow location access.');
          else if (err.code === err.POSITION_UNAVAILABLE) fail('Your location is currently unavailable. Enter the address manually.');
          else fail('Location detection timed out. Enter the address manually.');
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
      );
    } catch {
      fail('Your browser does not support location detection.');
    }
  });
}

/** A GPS lock this tight is deliverable — couriers find the door with it. */
export const GOOD_ACCURACY_M = 35;

/** Human-readable accuracy verdict, e.g. "±12 m — accurate" for UI feedback. */
export function accuracyLabel(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '';
  if (m <= GOOD_ACCURACY_M) return `±${m} m — accurate`;
  if (m <= 150) return `±${m} m — good`;
  if (m <= 1000) return `±${m} m — approximate`;
  return `±${Math.round(m / 100) / 10} km — coarse, check the pin`;
}

interface BigDataCloudResponse {
  status?: string | number;
  city?: string;
  locality?: string;
  principalSubdivision?: string;
  postcode?: string;
  street?: string;
  localityInfo?: { administrative?: { name?: string; adminLevel?: number }[] };
}

export async function reverseGeocode(fix: GpsFix): Promise<GeoParts | null> {
  // Primary: BigDataCloud's free client-side endpoint (no key, CORS-enabled,
  // purpose-built for browsers). It refuses datacenter IPs, so a secondary
  // OpenStreetMap Nominatim call covers VPNs and corporate networks.
  const fromBdc = await reverseGeocodeBigDataCloud(fix);
  return fromBdc ?? reverseGeocodeOsm(fix);
}

async function reverseGeocodeBigDataCloud(fix: GpsFix): Promise<GeoParts | null> {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${fix.latitude}&longitude=${fix.longitude}&localityLanguage=en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as BigDataCloudResponse;
    if (j.status && Number(j.status) >= 400) return null;
    const admins = j.localityInfo?.administrative ?? [];
    // Prefer a meaningful province: the most specific admin area that is not the city itself.
    const province =
      j.principalSubdivision ||
      [...admins].sort((a, b) => (a.adminLevel ?? 99) - (b.adminLevel ?? 99)).find((a) => a.name && a.name !== j.locality && a.name !== j.city)?.name ||
      '';
    const parts: GeoParts = {
      street: j.street || '',
      city: j.city || j.locality || '',
      province,
      postalCode: j.postcode || '',
    };
    // A result with at least a city counts as useful; street may legitimately be empty.
    return parts.city || parts.province ? parts : null;
  } catch {
    return null;
  }
}

interface NominatimResponse {
  address?: {
    house_number?: string;
    road?: string;
    pedestrian?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    postcode?: string;
  };
}

async function reverseGeocodeOsm(fix: GpsFix): Promise<GeoParts | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${fix.latitude}&lon=${fix.longitude}&zoom=18&addressdetails=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = (await res.json()) as NominatimResponse;
    const a = j.address ?? {};
    const street = [a.house_number, a.road ?? a.pedestrian].filter(Boolean).join(' ');
    const parts: GeoParts = {
      street,
      city: a.city || a.town || a.village || a.suburb || '',
      province: a.state || '',
      postalCode: a.postcode || '',
    };
    return parts.city || parts.province ? parts : null;
  } catch {
    return null;
  }
}

/** Human-readable one-line address used for the order's address snapshot. */
export function formatAddressLine(p: GeoParts): string {
  return [p.street, p.city, p.province, p.postalCode].filter(Boolean).join(', ');
}

/**
 * Best-effort split of a comma-separated address line into its parts, tuned
 * for the South African checkout placeholder: "street, suburb, city,
 * province, postal code". Missing pieces come back as '' and the caller
 * decides whether that is good enough to save.
 */
export function parseAddressLine(line: string): GeoParts {
  const raw = line.split(',').map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return { street: '', city: '', province: '', postalCode: '' };
  let postalCode = '';
  let province = '';
  let end = raw.length;
  const last = raw[end - 1];
  if (/^\d{4}$/.test(last)) {
    postalCode = last;
    end -= 1;
  }
  if (end >= 2) {
    province = raw[end - 1];
    end -= 1;
  }
  const middle = raw.slice(1, end);
  // If only one middle segment exists it is usually the city; with two
  // (suburb + city) the last one is the city, which is what couriers need.
  const city = middle.length > 0 ? middle[middle.length - 1] : '';
  const streetParts = middle.length > 1 ? [raw[0], ...middle.slice(0, -1)] : [raw[0]];
  return { street: streetParts.join(', '), city, province, postalCode };
}
