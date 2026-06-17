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
  const client = new Seclai(baseUrl ? { apiKey, baseUrl } : { apiKey });
  return { client, agentId };
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

const METADATA = { source: 'moderation-playground' };
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

  if (run.status !== 'completed') {
    throw new Error(`Seclai run ${run.status} (${run.error_count} error(s)).`);
  }
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
