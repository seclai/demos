// ============================================================
// Seclai API client
//
// Wraps the Seclai REST API for the Jailbreak Arcade demo:
//   - callBankBot(userMessage, history) → { response, blocked }
//   - callJudge(userMessage, botResponse) → JudgeResult
//
// Falls back to deterministic stub responses when no API key is
// configured or SECLAI_STUB=true, so local dev works offline.
// ============================================================

import type { ChatExchange, JudgeResult } from './types';
import { BANKBOT_RULES, FORBIDDEN_RULES } from './bankbot-rules';

const API_BASE = 'https://api.seclai.com';
const MAX_POLL_MS = 30_000;
const INITIAL_POLL_DELAY_MS = 400;
const MAX_POLL_DELAY_MS = 2_000;

type Platform = { env?: Record<string, unknown> } | undefined;

export interface SeclaiConfig {
  apiKey: string | null;
  bankbotAgentId: string | null;
  judgeAgentId: string | null;
  stub: boolean;
}

export function getSeclaiConfig(platform?: Platform): SeclaiConfig {
  const env = (platform?.env ?? {}) as Record<string, string | undefined>;
  const meta = (import.meta.env ?? {}) as Record<string, string | undefined>;

  const apiKey = env.SECLAI_API_KEY || meta.SECLAI_API_KEY || null;
  const bankbotAgentId = env.SECLAI_BANKBOT_AGENT_ID || meta.SECLAI_BANKBOT_AGENT_ID || null;
  const judgeAgentId = env.SECLAI_JUDGE_AGENT_ID || meta.SECLAI_JUDGE_AGENT_ID || null;
  const stubFlag = (env.SECLAI_STUB || meta.SECLAI_STUB || '').toLowerCase() === 'true';

  const stub = stubFlag || !apiKey || !bankbotAgentId || !judgeAgentId;

  return { apiKey, bankbotAgentId, judgeAgentId, stub };
}

// ============================================================
// Low-level: create a run and poll until terminal
// ============================================================

interface SeclaiRun {
  run_id: string;
  status: string; // 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | ...
  output?: unknown;
  error?: unknown;
  governance?: unknown;
  attempts?: Array<{ status?: string; error?: string }>;
}

async function runAgent(
  config: SeclaiConfig,
  agentId: string,
  input: string,
): Promise<SeclaiRun> {
  if (!config.apiKey) throw new Error('SECLAI_API_KEY not configured');

  const headers = {
    'X-API-Key': config.apiKey,
    'Content-Type': 'application/json',
  };

  // Create run (priority for user-facing latency)
  const createRes = await fetch(`${API_BASE}/agents/${agentId}/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input, priority: true }),
  });

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    throw new Error(`Seclai run create failed (${createRes.status}): ${text}`);
  }

  const initial = (await createRes.json()) as SeclaiRun;
  if (isTerminal(initial.status)) return initial;

  // Poll
  const deadline = Date.now() + MAX_POLL_MS;
  let delay = INITIAL_POLL_DELAY_MS;
  let lastRun: SeclaiRun = initial;

  while (Date.now() < deadline) {
    await sleep(delay);
    const res = await fetch(
      `${API_BASE}/agents/${agentId}/runs?run_id=${initial.run_id}`,
      { headers: { 'X-API-Key': config.apiKey } },
    );
    if (!res.ok) {
      // transient error — keep polling until deadline
      delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
      continue;
    }
    const body = (await res.json()) as { data?: SeclaiRun[] };
    const found = body.data?.[0];
    if (found) {
      lastRun = found;
      if (isTerminal(lastRun.status)) return lastRun;
    }
    delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
  }

  throw new Error(`Seclai run ${initial.run_id} timed out after ${MAX_POLL_MS}ms`);
}

function isTerminal(status: string): boolean {
  return ['completed', 'succeeded', 'failed', 'error', 'blocked', 'cancelled', 'canceled'].includes(
    (status || '').toLowerCase(),
  );
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    // Common shapes: { text }, { response }, { message }, { output }
    for (const key of ['text', 'response', 'message', 'output', 'content']) {
      const v = o[key];
      if (typeof v === 'string') return v;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  return String(output);
}

// ============================================================
// BankBot
// ============================================================

const STUB_BOT_REPLIES = [
  "[STUBBED] I can help with general banking questions, but I can't discuss specific accounts or give personalized advice.",
  "[STUBBED] I'm BankBot, a demo assistant. I can explain products and policies in general terms.",
  "[STUBBED] For your security, I can't confirm account details. Please visit a branch or call support.",
  '[STUBBED] I can only respond in English about general banking topics.',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function formatHistory(history: Array<{ user: string; bot: string }>): string {
  return history
    .slice(-6)
    .map(h => `User: ${h.user}\nBankBot: ${h.bot}`)
    .join('\n\n');
}

export async function callBankBot(
  userMessage: string,
  history: Array<{ user: string; bot: string }>,
  platform?: Platform,
): Promise<{ response: string; blocked: boolean }> {
  const config = getSeclaiConfig(platform);

  if (config.stub) {
    if (Math.random() < 0.15) {
      return { response: '[STUBBED] [governance: response withheld]', blocked: true };
    }
    return { response: pick(STUB_BOT_REPLIES), blocked: false };
  }

  const priorHistory = formatHistory(history);
  const input = priorHistory
    ? `Prior conversation:\n${priorHistory}\n\nCurrent message:\n${userMessage}`
    : userMessage;

  try {
    const run = await runAgent(config, config.bankbotAgentId!, input);
    const status = (run.status || '').toLowerCase();

    if (status === 'blocked') {
      return { response: '[governance: response withheld]', blocked: true };
    }

    // Governance can fail a run with the input/output flagged as unsafe by a
    // prompt scan. Surface that as a blocked (Defended) verdict.
    if (status === 'failed' || status === 'error') {
      const attemptErr = run.attempts?.find(a => a.error)?.error ?? '';
      const runErr = typeof run.error === 'string' ? run.error : '';
      const combined = `${attemptErr} ${runErr}`.toLowerCase();
      if (
        combined.includes('flagged as unsafe') ||
        combined.includes('governance') ||
        combined.includes('prompt scan') ||
        combined.includes('blocked')
      ) {
        return { response: '[governance: response withheld]', blocked: true };
      }
      return { response: '[BankBot unavailable]', blocked: false };
    }
    if (status === 'cancelled' || status === 'canceled') {
      return { response: '[BankBot unavailable]', blocked: false };
    }

    // Governance can also surface as metadata on a completed run.
    const gov = run.governance as { verdict?: string; blocked?: boolean } | undefined;
    if (gov?.blocked || gov?.verdict === 'blocked') {
      return { response: '[governance: response withheld]', blocked: true };
    }

    return { response: extractText(run.output), blocked: false };
  } catch (err) {
    console.error('callBankBot error:', err);
    return { response: '[BankBot unavailable]', blocked: false };
  }
}

// ============================================================
// Judge
// ============================================================

function validRuleIds(): Set<string> {
  return new Set(BANKBOT_RULES.map(r => r.id));
}

function parseJudgeOutput(raw: unknown): JudgeResult {
  const valid = validRuleIds();

  const tryObject = (obj: Record<string, unknown>): JudgeResult | null => {
    const broken = obj.broken;
    if (typeof broken !== 'boolean') return null;
    const ruleBrokenRaw = obj.ruleBroken ?? obj.rule_broken ?? null;
    const ruleBroken =
      typeof ruleBrokenRaw === 'string' && valid.has(ruleBrokenRaw) ? ruleBrokenRaw : null;
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
    return { broken, ruleBroken: broken ? ruleBroken : null, reasoning };
  };

  if (raw && typeof raw === 'object') {
    // Judge may return the object directly or nested under `output`/`text`.
    const direct = tryObject(raw as Record<string, unknown>);
    if (direct) return direct;

    const nested = (raw as Record<string, unknown>).output ?? (raw as Record<string, unknown>).text;
    if (typeof nested === 'string') {
      return parseJudgeOutput(nested);
    }
    if (nested && typeof nested === 'object') {
      const r = tryObject(nested as Record<string, unknown>);
      if (r) return r;
    }
  }

  if (typeof raw === 'string') {
    // Extract first JSON object from the string.
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]) as Record<string, unknown>;
        const r = tryObject(obj);
        if (r) return r;
      } catch {
        /* fall through */
      }
    }
  }

  return {
    broken: false,
    ruleBroken: null,
    reasoning: 'Judge output could not be parsed.',
  };
}

export async function callJudge(
  userMessage: string,
  botResponse: string,
  platform?: Platform,
): Promise<JudgeResult> {
  const config = getSeclaiConfig(platform);

  if (config.stub) {
    if (Math.random() < 0.25) {
      const rule = pick(FORBIDDEN_RULES);
      return {
        broken: true,
        ruleBroken: rule.id,
        reasoning: `[STUBBED] The reply appears to violate ${rule.id}.`,
      };
    }
    return {
      broken: false,
      ruleBroken: null,
      reasoning: '[STUBBED] No rule violations detected.',
    };
  }

  const input = JSON.stringify({
    userMessage,
    botResponse,
    forbiddenRules: FORBIDDEN_RULES.map(r => ({ id: r.id, description: r.description })),
  });

  try {
    const run = await runAgent(config, config.judgeAgentId!, input);
    return parseJudgeOutput(run.output);
  } catch (err) {
    console.error('callJudge error:', err);
    return {
      broken: false,
      ruleBroken: null,
      reasoning: 'Judge unavailable.',
    };
  }
}

// Re-export for convenience so other modules can check mode.
export function isStubMode(platform?: Platform): boolean {
  return getSeclaiConfig(platform).stub;
}

export type { ChatExchange };
