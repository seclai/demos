import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { moderateListing } from '../../lib/moderation';
import { getConfig, getAgentModel } from '../../lib/seclai';

export const prerender = false; // run on-demand so the Seclai key stays server-side

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const ACCEPTED = new Set(['image/jpeg', 'image/png']);
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — listing photos are small

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: 'Expected multipart/form-data.' }, 400);

  const file = form.get('image');
  if (!(file instanceof File)) {
    return json({ error: 'Attach a listing photo (JPG or PNG) in the "image" field.' }, 400);
  }
  const contentType = file.type || 'application/octet-stream';
  if (!ACCEPTED.has(contentType)) {
    return json({ error: 'Unsupported file type. Use a JPG or PNG.' }, 415);
  }
  if (file.size === 0) return json({ error: 'The uploaded file is empty.' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'File too large (max 20 MB).' }, 413);

  const caption = typeof form.get('caption') === 'string' ? (form.get('caption') as string) : '';

  const platform = { env: env as unknown as Record<string, unknown> };

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const startedAt = Date.now();
    const result = await moderateListing(
      { bytes, fileName: file.name || 'listing', contentType },
      caption,
      platform,
    );
    const latencyMs = Date.now() - startedAt;
    const model = await getAgentModel(getConfig(platform)); // cached after first call

    // "Not a listing photo" is no longer a special case — it comes back as a
    // normal result that fails (see normalizeResult in lib/moderation.ts).
    return json({ result, latencyMs, model });
  } catch (err) {
    console.error('[api/moderate]', err);
    return json({ error: err instanceof Error ? err.message : 'Moderation failed.' }, 502);
  }
};
