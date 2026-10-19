/**
 * Object-storage uploads (additive — nothing existing changes).
 *
 * Product and store images have always been stored as base64 data URLs in the
 * database and that REMAINS the default: with no storage configured, every
 * upload path behaves exactly as before. When an S3-compatible bucket is
 * configured, the same data URLs are additionally uploaded to the bucket and
 * the DB stores its public https URL instead — smaller rows, faster API
 * responses, CDN-cacheable images.
 *
 * Configuration (all env, never committed):
 *   S3_REGION            e.g. af-south-1 (or the provider's region id)
 *   S3_BUCKET            bucket name
 *   S3_ACCESS_KEY_ID     access key
 *   S3_SECRET_ACCESS_KEY secret key
 *   S3_ENDPOINT          optional — for R2/MinIO/other S3-compatible stores
 *                        (e.g. https://<account>.r2.cloudflarestorage.com)
 *   S3_PUBLIC_BASE_URL   optional — the bucket's public/CDN base URL if it
 *                        differs from the API endpoint
 *
 * Fail-safe by design: ANY error in the upload path returns the original
 * data URL, so a storage outage can never break a seller's listing.
 */

import { AwsClient } from 'aws4fetch';

const REGION = process.env.S3_REGION;
const BUCKET = process.env.S3_BUCKET;
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID;
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY;
const ENDPOINT = process.env.S3_ENDPOINT; // e.g. Cloudflare R2
const PUBLIC_BASE = process.env.S3_PUBLIC_BASE_URL;

/** True when the environment has everything needed to store objects. */
export function storageConfigured(): boolean {
  return Boolean(REGION && BUCKET && ACCESS_KEY && SECRET_KEY);
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

let client: AwsClient | null = null;
function s3Client(): AwsClient {
  if (!client) {
    client = new AwsClient({
      accessKeyId: ACCESS_KEY!,
      secretAccessKey: SECRET_KEY!,
      service: 's3',
      region: REGION!,
    });
  }
  return client;
}

/**
 * Uploads a data URL to the configured bucket and returns its public URL.
 * Returns the input UNCHANGED when storage is not configured, the input is
 * not a data URL, or anything goes wrong — callers never need error handling.
 */
export async function maybeUploadDataUrl(dataUrl: string, kind: 'products' | 'stores'): Promise<string> {
  try {
    if (!storageConfigured() || !dataUrl.startsWith('data:')) return dataUrl;

    const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl);
    if (!match) return dataUrl;
    const [, mime, , payload] = match;
    if (!/^image\//.test(mime)) return dataUrl;

    const bytes = Buffer.from(payload, match[2] ? 'base64' : 'utf8');
    const ext = EXT_BY_MIME[mime] ?? 'jpg';
    const key = `${kind}/${Date.now().toString(36)}-${crypto.randomUUID()}.${ext}`;

    const base = ENDPOINT ?? `https://s3.${REGION}.amazonaws.com`;
    const url = `${base.replace(/\/$/, '')}/${BUCKET}/${key}`;
    const res = await s3Client().fetch(url, {
      method: 'PUT',
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': mime, 'x-amz-acl': 'public-read' },
    });
    if (!res.ok) throw new Error(`S3 PUT ${res.status}`);

    return PUBLIC_BASE ? `${PUBLIC_BASE.replace(/\/$/, '')}/${key}` : url;
  } catch (e) {
    console.error('object storage upload failed (falling back to data URL):', e instanceof Error ? e.message : e);
    return dataUrl;
  }
}
