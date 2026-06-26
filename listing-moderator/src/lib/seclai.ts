// Thin wrapper over the official Seclai JavaScript SDK (@seclai/sdk).
//
// Reads config from the environment, uploads attachments, runs an agent, and
// returns the agent's text output. The SDK handles auth, the upload/run/poll
// HTTP dance, and response shapes — we only add env wiring and the
// text-plus-attachments convenience. Generic + reusable: the app-specific
// prompt and output parsing live in ./moderation.ts.
//
// SDK reference: https://github.com/seclai/seclai-javascript

import { Seclai } from '@seclai/sdk';

type Platform = { env?: Record<string, unknown> } | undefined;

function readEnv(key: string, platform?: Platform): string | undefined {
  // On Cloudflare Workers, secrets/vars live on `platform.env`. In dev they
  // also come from `import.meta.env` (.env file).
  const fromPlatform = (platform?.env as Record<string, string | undefined> | undefined)?.[key];
  if (fromPlatform) return fromPlatform;
  const fromMeta = (import.meta.env as Record<string, string | undefined>)[key];
  return fromMeta || undefined;
}

export interface SeclaiConfig {
  client: Seclai;
  agentId: string;
}

export function getConfig(platform?: Platform): SeclaiConfig {
  const apiKey = readEnv('SECLAI_API_KEY', platform);
  const agentId = readEnv('SECLAI_AGENT_ID', platform);
  const baseUrl = readEnv('SECLAI_BASE_URL', platform);
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error('SECLAI_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
  if (!agentId || agentId === 'your_agent_id_here') {
    throw new Error('SECLAI_AGENT_ID is not set. Create the agent in Seclai and add its id to .env.');
  }
  // baseUrl defaults to https://api.seclai.com inside the SDK; only pass it when set.
  // `fetch` must be bound to globalThis so the SDK can call it as a method
  // without tripping Workers' "Illegal invocation" check on detached `this`.
  const boundFetch: typeof fetch = (...args) => globalThis.fetch(...args);
  const client = new Seclai({
    apiKey,
    fetch: boundFetch,
    ...(baseUrl ? { baseUrl } : {}),
  });
  return { client, agentId };
}

/** Pull the model the agent's prompt_call step uses. Cached per agent id with a
 *  short TTL: the lookup is a separate API call, but the model can change (the
 *  agent has auto-upgrade), so we re-check rather than cache forever. */
const MODEL_TTL_MS = 60_000;
const modelCache = new Map<string, { value: string | null; expires: number }>();
export async function getAgentModel(cfg: SeclaiConfig): Promise<string | null> {
  const hit = modelCache.get(cfg.agentId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const walk = (node: unknown): string | null => {
    const n = node as { step_type?: string; model?: string; child_steps?: unknown[] } | null;
    if (n?.step_type === 'prompt_call' && n.model) return n.model;
    for (const c of n?.child_steps ?? []) { const m = walk(c); if (m) return m; }
    return null;
  };
  try {
    const def = await cfg.client.getAgentDefinition(cfg.agentId);
    const model = walk(def.definition);
    modelCache.set(cfg.agentId, { value: model, expires: Date.now() + MODEL_TTL_MS });
    return model;
  } catch {
    return hit?.value ?? null; // non-fatal — fall back to last known / decorative
  }
}

/** Upload one file and wait until the SDK reports it `ready` for a run. */
async function uploadReady(
  cfg: SeclaiConfig, bytes: Uint8Array, fileName: string, mimeType: string,
  { timeoutMs = 60_000, intervalMs = 1_000 } = {},
): Promise<string> {
  const up = await cfg.client.uploadAgentInput(cfg.agentId, { file: bytes, fileName, mimeType });
  let status = up.status;
  const deadline = Date.now() + timeoutMs;
  while (status === 'processing' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const s = await cfg.client.getAgentInputUploadStatus(cfg.agentId, up.id);
    status = s.status;
    if (s.error) throw new Error(`Seclai upload failed: ${s.error}`);
  }
  if (status === 'failed') throw new Error(`Seclai upload "${fileName}" failed to process.`);
  return up.id;
}

const METADATA = { source: 'listing-moderator' };
const RUN_OPTS = { timeoutMs: 120_000 } as const;

/** Run the agent with text and/or file attachments; return its text output. */
export async function runAgent(
  cfg: SeclaiConfig,
  input: string,
  files: { bytes: Uint8Array; fileName: string; contentType: string }[] = [],
): Promise<string> {
  const run = files.length === 0
    ? await cfg.client.runAgentAndPoll(cfg.agentId, { input, metadata: METADATA, priority: false }, RUN_OPTS)
    : await runWithFiles(cfg, input, files);

  if (run.status !== 'completed') throw new Error(runFailureMessage(run));
  const out = run.output;
  if (typeof out !== 'string' || !out.trim()) {
    throw new Error('Seclai run completed but produced no text output.');
  }
  return out;
}

async function runWithFiles(
  cfg: SeclaiConfig,
  input: string,
  files: { bytes: Uint8Array; fileName: string; contentType: string }[],
) {
  const ids: string[] = [];
  if (input.trim()) {
    ids.push(await uploadReady(cfg, new TextEncoder().encode(input), 'input.txt', 'text/plain'));
  }
  for (const f of files) ids.push(await uploadReady(cfg, f.bytes, f.fileName, f.contentType));
  return cfg.client.runAgentAndPoll(
    cfg.agentId,
    { input_upload_ids: ids, metadata: METADATA, priority: false },
    RUN_OPTS,
  );
}

/** Build a human-readable error from a non-completed run payload. */
function runFailureMessage(run: {
  status?: string; error_count?: number;
  attempts?: { error?: string | null }[];
  governance_input_status?: string | null; input_scan_status?: string | null;
  blocked_policies?: { name?: string | null; id?: string }[];
}): string {
  const attemptErr = run.attempts?.find((a) => a.error)?.error;
  const gov = run.governance_input_status && run.governance_input_status !== 'safe'
    ? ` governance_input=${run.governance_input_status}` : '';
  const scan = run.input_scan_status && run.input_scan_status !== 'safe'
    ? ` input_scan=${run.input_scan_status}` : '';
  const blocked = run.blocked_policies?.length
    ? ` blocked_by=${run.blocked_policies.map((p) => p.name ?? p.id).join(',')}` : '';
  const detail = attemptErr ? `: ${attemptErr}` : '';
  return `Seclai run ${run.status} (${run.error_count} error(s))${gov}${scan}${blocked}${detail}`;
}

/** A normalized streaming event from a run. `token` arrives only when the agent
 *  has a streaming_result step; otherwise expect `progress` then `done`. */
export type AgentStreamEvent =
  | { type: 'token'; token: string }
  | { type: 'progress'; step: string; message: string }
  | { type: 'done'; output: string }
  | { type: 'error'; message: string };

/** Run the agent in streaming mode, yielding normalized events as they arrive. */
export async function* streamAgent(
  cfg: SeclaiConfig,
  input: string,
  files: { bytes: Uint8Array; fileName: string; contentType: string }[] = [],
): AsyncGenerator<AgentStreamEvent> {
  const ids: string[] = [];
  if (input.trim()) ids.push(await uploadReady(cfg, new TextEncoder().encode(input), 'input.txt', 'text/plain'));
  for (const f of files) ids.push(await uploadReady(cfg, f.bytes, f.fileName, f.contentType));
  const body = ids.length
    ? { input_upload_ids: ids, metadata: METADATA, priority: false }
    : { input, metadata: METADATA, priority: false };

  for await (const ev of cfg.client.runStreamingAgent(cfg.agentId, body, RUN_OPTS)) {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.event === 'stream_token' && typeof d.token === 'string') {
      yield { type: 'token', token: d.token };
    } else if (ev.event === 'step_progress') {
      yield { type: 'progress', step: String(d.step_name ?? ''), message: String(d.message ?? '') };
    } else if (ev.event === 'done') {
      if (d.status && d.status !== 'completed') { yield { type: 'error', message: runFailureMessage(d) }; return; }
      yield { type: 'done', output: typeof d.output === 'string' ? d.output : '' };
    } else if (ev.event === 'error' || ev.event === 'timeout') {
      yield { type: 'error', message: String(d.message ?? `run ${ev.event}`) };
      return;
    }
  }
}
