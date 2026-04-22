import type { APIRoute } from 'astro';
import type { Attempt, ChatExchange, JudgeResult, Verdict } from '../../lib/types';
import { FORBIDDEN_RULES } from '../../lib/bankbot-rules';
import { getStorage, hashIP } from '../../lib/storage';

// ============================================================
// TEMPORARY STUB
// The real integration (BankBot + Judge) needs to be wired up.
// For now every exchange returns a mocked response so the UI
// keeps working end-to-end.
// ============================================================

const STUB_BOT_REPLIES = [
  "I can help with general banking questions, but I can't discuss specific accounts or give personalized advice.",
  "I'm BankBot, a demo assistant. I can explain products and policies in general terms.",
  "For your security, I can't confirm account details. Please visit a branch or call support.",
  "I follow a strict policy and can only respond in English about general banking topics.",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function stubBankBot(_input: string): Promise<{ response: string; blocked: boolean }> {
  // ~15% chance the governance layer would have blocked
  if (Math.random() < 0.15) {
    return { response: '[governance: response withheld]', blocked: true };
  }
  return { response: pick(STUB_BOT_REPLIES), blocked: false };
}

async function stubJudge(_userMessage: string, _botResponse: string): Promise<JudgeResult> {
  // ~25% chance of a broken verdict for demo traffic
  if (Math.random() < 0.25) {
    const rule = pick(FORBIDDEN_RULES);
    return {
      broken: true,
      ruleBroken: rule.id,
      reasoning: `[STUBBED] The reply appears to violate ${rule.id}.`,
    };
  }
  return { broken: false, ruleBroken: null, reasoning: '[STUBBED] No rule violations detected.' };
}

function getPlatform(locals: App.Locals) {
  return (locals as unknown as { runtime?: { env?: { JAILBREAK_KV?: KVNamespace } } }).runtime;
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const userMessage = body?.message?.trim();

    if (!userMessage || typeof userMessage !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing "message" field' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (userMessage.length > 2000) {
      return new Response(JSON.stringify({ error: 'Message too long (max 2000 characters)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const storage = getStorage(getPlatform(locals));

    // Rate limit check
    const clientIP = request.headers.get('cf-connecting-ip')
      ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? '127.0.0.1';
    const ipHash = await hashIP(clientIP);
    const rateLimit = await storage.checkRateLimit(ipHash);

    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({
        error: 'Rate limited',
        remaining: 0,
        resetAt: rateLimit.resetAt,
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await storage.incrementRateLimit(ipHash);

    // Step 1: BankBot
    const { response: botResponse, blocked } = await stubBankBot(userMessage);

    if (blocked) {
      const exchange: ChatExchange = {
        userMessage,
        botResponse,
        verdict: 'Defended' as Verdict,
        attemptId: null,
        ruleBroken: null,
        reasoning: 'Governance layer blocked this response.',
      };
      return new Response(JSON.stringify(exchange), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Step 2: Judge
    const judgeResult = await stubJudge(userMessage, botResponse);

    if (judgeResult.broken) {
      const attemptId = crypto.randomUUID();
      const attempt: Attempt = {
        id: attemptId,
        timestamp: new Date().toISOString(),
        userMessage,
        botResponse,
        verdict: 'Broken',
        ruleBroken: judgeResult.ruleBroken,
        judgeReasoning: judgeResult.reasoning,
        governanceBlocked: false,
        ipHash,
        shareCount: 0,
      };
      await storage.saveAttempt(attempt);

      const exchange: ChatExchange = {
        userMessage,
        botResponse,
        verdict: 'Broken',
        attemptId,
        ruleBroken: judgeResult.ruleBroken,
        reasoning: judgeResult.reasoning,
      };
      return new Response(JSON.stringify(exchange), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Safe
    const exchange: ChatExchange = {
      userMessage,
      botResponse,
      verdict: 'Safe',
      attemptId: null,
      ruleBroken: null,
      reasoning: null,
    };
    return new Response(JSON.stringify(exchange), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Chat API error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
