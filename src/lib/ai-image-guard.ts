import sharp from 'sharp';

/**
 * AI-image rejection guard.
 *
 * Green Gate does not permit AI-generated product images. Two independent
 * detection layers run on every upload before anything is stored:
 *
 *  1. Metadata forensics (deterministic): scans the raw file for
 *     - C2PA / CAI content-credential manifests (OpenAI DALL-E, Adobe Firefly,
 *       Google Gemini and most major generators embed these),
 *     - XMP packets naming known generators (Midjourney, Stable Diffusion,
 *       ComfyUI, Automatic1111, Firefly, Imagen, Flux, Ideogram...),
 *     - PNG tEXt/iTXt chunks used by Stable Diffusion WebUI ("parameters",
 *       "prompt", "Negative prompt"),
 *     - JPEG COM markers and EXIF Software/Artist fields naming AI tools.
 *
 *  2. Visual analysis (ML): a vision-language model judges whether the photo
 *     is a genuine photograph of a real product or a synthetic render.
 *     Rejections require high confidence to protect legitimate sellers.
 *
 * Layer 1 rejection is absolute. Layer 2 rejection requires confidence >= 0.8.
 * If the vision service is unavailable, uploads still pass layer 1 and the
 * attempt is recorded for monitoring.
 */

const META_SIGNATURES: { pattern: RegExp; label: string }[] = [
  { pattern: /c2pa|jumbf|contentcredentials/i, label: 'C2PA content-credential manifest' },
  { pattern: /midjourney/i, label: 'Midjourney' },
  { pattern: /dall[\s·-]?e|openai/i, label: 'OpenAI DALL·E' },
  { pattern: /stable[\s-]?diffusion|stablediffusion/i, label: 'Stable Diffusion' },
  { pattern: /comfyui|automatic1111|sd webui|a1111/i, label: 'Diffusion WebUI' },
  { pattern: /firefly|generative[\s-]?(fill|expand|recolor)/i, label: 'Adobe Firefly / generative edit' },
  { pattern: /imagen|gemini|made with google ai|nano[\s-]?banana/i, label: 'Google AI image tool' },
  { pattern: /flux[\s.:_-]?(1|dev|schnell|pro)/i, label: 'Flux' },
  { pattern: /ideogram|leonardo\.ai|runwayml|pika[\s-]?labs|kling|vidu/i, label: 'AI media generator' },
  { pattern: /photoshop:DocumentAncestors/i, label: 'Photoshop generative ancestry' },
  { pattern: /bing image creator|copilot|grok(\s|image)/i, label: 'Bing/Copilot/Grok image tool' },
  { pattern: /trainedAlgorithmicMedia/i, label: 'XMP trained-algorithmic media' },
  { pattern: /digital source type:\s*["']?trainedAlgorithmicMedia/i, label: 'C2PA trained-algorithmic source' },
  { pattern: /negative\s*prompt/i, label: 'Diffusion prompt metadata' },
  { pattern: /\bprompt\s*:/i, label: 'Generation prompt metadata' },
  { pattern: /ai[\s-]?(generated|created|made)/i, label: 'Self-declared AI-generated' },
];

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  layer: 'metadata' | 'visual' | 'visual_unavailable' | 'pass';
}

/** Layer 1 — deterministic metadata forensics on the raw file bytes. */
export function scanMetadata(buffer: Buffer): GuardResult {
  const text = buffer.toString('latin1');
  // Cap the scan window for very large files: metadata lives in headers/segments.
  const head = text.slice(0, 400_000);
  const tail = text.slice(Math.max(0, text.length - 200_000));
  for (const sig of META_SIGNATURES) {
    if (sig.pattern.test(head) || sig.pattern.test(tail)) {
      return { allowed: false, reason: `Image metadata identifies an AI generator (${sig.label}).`, layer: 'metadata' };
    }
  }

  // PNG tEXt chunks written by Stable Diffusion WebUI / ComfyUI workflows.
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    const params = buffer.toString('latin1');
    if (/tEXt\s*(parameters|prompt|workflow| ComfyUI)/.test(params)) {
      return { allowed: false, reason: 'PNG metadata contains a generation prompt/workflow.', layer: 'metadata' };
    }
  }
  return { allowed: true, layer: 'pass' };
}

/** EXIF heuristics: generator tool tags are fatal (camera EXIF never matches these signatures). */
async function scanExif(buffer: Buffer): Promise<GuardResult> {
  try {
    const meta = await sharp(buffer).metadata();
    // sharp exposes raw EXIF/XMP segments as buffers; AI tools stamp "Software",
    // "Artist" or "CreatorTool" fields inside them.
    const tags = [meta.exif?.toString('latin1'), meta.xmp?.toString('latin1')].filter(Boolean).join(' ');
    if (tags) {
      for (const sig of META_SIGNATURES) {
        if (sig.pattern.test(tags)) {
          return { allowed: false, reason: `Image tool metadata identifies an AI generator (${sig.label}).`, layer: 'metadata' };
        }
      }
    }
  } catch {
    // corrupt EXIF is not a rejection reason on its own
  }
  return { allowed: true, layer: 'pass' };
}

/** Layer 2 — ML visual judgement via the vision-language model. */
async function visualAnalysis(buffer: Buffer, mimeType: string): Promise<GuardResult> {
  try {
    const { default: ZAI } = await import('z-ai-web-dev-sdk');
    const zai = await ZAI.create();
    const base64 = buffer.toString('base64');

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // The platform's vision endpoint assigns its model server-side; the SDK type
    // declares `model` as required, so the payload is cast without altering it.
    const visionBody = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                'You are a product-photo authenticity inspector for an online marketplace that bans AI-generated imagery.',
                'Decide whether this image is a genuine photograph of a real physical product, or an AI-generated / synthetic render.',
                'Signals of synthetic images include: plastic-perfect surfaces, physically impossible geometry or gibberish text on labels, dream-like lighting, watermarks from AI tools, over-smooth textures, inconsistent shadows/reflections.',
                'A clean studio product photo on a white background is NORMAL and NOT by itself evidence of AI generation.',
                'Reply with ONLY a JSON object: {"ai_generated": true|false, "confidence": 0.0-1.0, "reason": "short explanation"}',
              ].join(' '),
            },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        },
      ],
      thinking: { type: 'disabled' },
    } as unknown as Parameters<typeof zai.chat.completions.createVision>[0];
    const response = await Promise.race([
      zai.chat.completions.createVision(visionBody),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('VLM timeout')), 60_000);
      }),
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });

    const content = response.choices[0]?.message?.content ?? '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { allowed: true, layer: 'visual_unavailable' };
    const parsed = JSON.parse(match[0]) as { ai_generated?: boolean; confidence?: number; reason?: string };
    if (parsed.ai_generated === true && (parsed.confidence ?? 0) >= 0.8) {
      return {
        allowed: false,
        reason: `Visual inspection flagged this image as AI-generated (${Math.round((parsed.confidence ?? 0) * 100)}% confidence): ${parsed.reason ?? 'synthetic characteristics'}.`,
        layer: 'visual',
      };
    }
    return { allowed: true, layer: 'pass' };
  } catch (e) {
    console.error('ai-guard visual layer unavailable:', e instanceof Error ? e.message : e);
    return { allowed: true, layer: 'visual_unavailable' };
  }
}

/** Full gate. Run on every product/store image upload. */
export async function guardImage(buffer: Buffer, mimeType: string): Promise<GuardResult> {
  const meta = scanMetadata(buffer);
  if (!meta.allowed) return meta;

  const exif = await scanExif(buffer);
  if (!exif.allowed) return exif;

  return visualAnalysis(buffer, mimeType);
}
