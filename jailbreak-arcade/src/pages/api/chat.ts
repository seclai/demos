import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { Attempt, ChatExchange, Verdict } from '../../lib/types';
import { getStorage, hashIP } from '../../lib/storage';
import { callBankBot, callJudge } from '../../lib/seclai';

function getPlatform() {
  return { env: env as unknown as Record<string, unknown> };
}

interface HistoryItem {
  user: string;
  bot: string;
}

function sanitizeHistory(raw: unknown): HistoryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const user = typeof r.user === 'string' ? r.user : '';
    const bot = typeof r.bot === 'string' ? r.bot : '';
    if (!user && !bot) continue;
    out.push({ user: user.slice(0, 4000), bot: bot.slice(0, 4000) });
  }
  // Cap to last 12 — callBankBot further trims to last 6.
  return out.slice(-12);
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const userMessage = typeof body?.message === 'string' ? body.message.trim() : '';
    const history = sanitizeHistory(body?.history);

    if (!userMessage) {
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

    const platform = getPlatform();
    const storage = getStorage(platform);

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
    const { response: botResponse, blocked } = await callBankBot(userMessage, history, platform);

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
    const judgeResult = await callJudge(userMessage, botResponse, platform);

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
