// ============================================================
// Shared TypeScript types for Jailbreak Arcade
// ============================================================

/** Result parsed from the Judge agent's output */
export interface JudgeResult {
  broken: boolean;
  ruleBroken: string | null;
  reasoning: string;
}

/** Verdict assigned to each chat exchange */
export type Verdict = 'Defended' | 'Safe' | 'Broken';

/** A full attempt record stored in KV */
export interface Attempt {
  id: string;
  timestamp: string;
  userMessage: string;
  botResponse: string;
  verdict: Verdict;
  ruleBroken: string | null;
  judgeReasoning: string | null;
  governanceBlocked: boolean;
  ipHash: string;
  shareCount: number;
}

/** What the /api/chat endpoint returns to the client */
export interface ChatExchange {
  userMessage: string;
  botResponse: string;
  verdict: Verdict;
  attemptId: string | null;
  ruleBroken: string | null;
  reasoning: string | null;
}

/** Rate limit record in KV */
export interface RateLimitRecord {
  count: number;
  resetAt: number;
}
