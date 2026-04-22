import type { APIRoute } from 'astro';
import { getStorage } from '../../../lib/storage';

export const GET: APIRoute = async ({ params, locals }) => {
  const { id } = params;

  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    return new Response(JSON.stringify({ error: 'Invalid attempt ID' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const platform = (locals as unknown as { runtime?: { env?: { JAILBREAK_KV?: KVNamespace } } }).runtime;
  const storage = getStorage(platform);
  const attempt = await storage.getAttempt(id);

  if (!attempt) {
    return new Response(JSON.stringify({ error: 'Attempt not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Strip ipHash before sending to client
  const { ipHash, ...safeAttempt } = attempt;

  return new Response(JSON.stringify(safeAttempt), {
    headers: { 'Content-Type': 'application/json' },
  });
};
