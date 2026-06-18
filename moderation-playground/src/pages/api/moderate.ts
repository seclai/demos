import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { moderateListingStream } from '../../lib/moderation';

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
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileArg = { bytes, fileName: file.name || 'listing', contentType };

  // Stream the run to the browser as Server-Sent Events: `token` chunks as the
  // model writes, then a final `result` with the parsed verdict.
  const encoder = new TextEncoder();
  const sse = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const startedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of moderateListingStream(fileArg, caption, platform)) {
          if (ev.type === 'result') {
            controller.enqueue(sse('result', { result: ev.result, model: ev.model, latencyMs: Date.now() - startedAt }));
          } else if (ev.type === 'error') {
            controller.enqueue(sse('error', { error: ev.message }));
          } else {
            controller.enqueue(sse(ev.type, ev));
          }
        }
      } catch (err) {
        console.error('[api/moderate]', err);
        controller.enqueue(sse('error', { error: err instanceof Error ? err.message : 'Moderation failed.' }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
};
