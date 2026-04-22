// ============================================================
// Storage abstraction — Cloudflare KV with in-memory fallback
//
// KV key patterns:
//   attempt:<uuid>        → Attempt JSON
//   leaderboard:recent    → JSON array of up to 50 Attempts
//   ratelimit:<ipHash>    → RateLimitRecord JSON
// ============================================================

import type { Attempt, RateLimitRecord } from './types';

const LEADERBOARD_KEY = 'leaderboard:recent';
const MAX_LEADERBOARD_SIZE = 50;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface Storage {
  getAttempt(id: string): Promise<Attempt | null>;
  saveAttempt(attempt: Attempt): Promise<void>;
  getLeaderboard(limit?: number): Promise<Attempt[]>;
  addToLeaderboard(attempt: Attempt): Promise<void>;
  checkRateLimit(ipHash: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
  incrementRateLimit(ipHash: string): Promise<void>;
}

// ============================================================
// Cloudflare KV implementation
// ============================================================

export class KVStorage implements Storage {
  constructor(private kv: KVNamespace) {}

  async getAttempt(id: string): Promise<Attempt | null> {
    const data = await this.kv.get(`attempt:${id}`, 'json');
    return data as Attempt | null;
  }

  async saveAttempt(attempt: Attempt): Promise<void> {
    await this.kv.put(`attempt:${attempt.id}`, JSON.stringify(attempt));
  }

  async getLeaderboard(limit = MAX_LEADERBOARD_SIZE): Promise<Attempt[]> {
    const data = await this.kv.get(LEADERBOARD_KEY, 'json');
    const entries = (data as Attempt[] | null) ?? [];
    return entries.slice(0, limit);
  }

  async addToLeaderboard(attempt: Attempt): Promise<void> {
    const entries = await this.getLeaderboard(MAX_LEADERBOARD_SIZE);
    entries.unshift(attempt);
    if (entries.length > MAX_LEADERBOARD_SIZE) entries.length = MAX_LEADERBOARD_SIZE;
    await this.kv.put(LEADERBOARD_KEY, JSON.stringify(entries));
  }

  async checkRateLimit(ipHash: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const key = `ratelimit:${ipHash}`;
    const data = await this.kv.get(key, 'json') as RateLimitRecord | null;
    const now = Date.now();

    if (!data || now >= data.resetAt) {
      return { allowed: true, remaining: RATE_LIMIT_MAX, resetAt: now + RATE_LIMIT_WINDOW_MS };
    }

    const remaining = Math.max(0, RATE_LIMIT_MAX - data.count);
    return { allowed: data.count < RATE_LIMIT_MAX, remaining, resetAt: data.resetAt };
  }

  async incrementRateLimit(ipHash: string): Promise<void> {
    const key = `ratelimit:${ipHash}`;
    const data = await this.kv.get(key, 'json') as RateLimitRecord | null;
    const now = Date.now();

    if (!data || now >= data.resetAt) {
      await this.kv.put(key, JSON.stringify({ count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS }));
    } else {
      await this.kv.put(key, JSON.stringify({ count: data.count + 1, resetAt: data.resetAt }));
    }
  }
}

// ============================================================
// In-memory fallback for local dev (no KV binding)
// ============================================================

export class MemoryStorage implements Storage {
  private attempts = new Map<string, Attempt>();
  private leaderboard: Attempt[] = [];
  private rateLimits = new Map<string, RateLimitRecord>();

  async getAttempt(id: string): Promise<Attempt | null> {
    return this.attempts.get(id) ?? null;
  }

  async saveAttempt(attempt: Attempt): Promise<void> {
    this.attempts.set(attempt.id, attempt);
  }

  async getLeaderboard(limit = MAX_LEADERBOARD_SIZE): Promise<Attempt[]> {
    return this.leaderboard.slice(0, limit);
  }

  async addToLeaderboard(attempt: Attempt): Promise<void> {
    this.leaderboard.unshift(attempt);
    if (this.leaderboard.length > MAX_LEADERBOARD_SIZE) this.leaderboard.length = MAX_LEADERBOARD_SIZE;
  }

  async checkRateLimit(ipHash: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const data = this.rateLimits.get(ipHash);

    if (!data || now >= data.resetAt) {
      return { allowed: true, remaining: RATE_LIMIT_MAX, resetAt: now + RATE_LIMIT_WINDOW_MS };
    }

    const remaining = Math.max(0, RATE_LIMIT_MAX - data.count);
    return { allowed: data.count < RATE_LIMIT_MAX, remaining, resetAt: data.resetAt };
  }

  async incrementRateLimit(ipHash: string): Promise<void> {
    const now = Date.now();
    const data = this.rateLimits.get(ipHash);

    if (!data || now >= data.resetAt) {
      this.rateLimits.set(ipHash, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
      this.rateLimits.set(ipHash, { count: data.count + 1, resetAt: data.resetAt });
    }
  }
}

// ============================================================
// Factory — returns KV storage if binding exists, else memory
// ============================================================

let memoryFallback: MemoryStorage | null = null;

export function getStorage(platform?: { env?: { JAILBREAK_KV?: KVNamespace } }): Storage {
  const kv = platform?.env?.JAILBREAK_KV;
  if (kv) {
    return new KVStorage(kv);
  }
  // Singleton in-memory store for local dev
  if (!memoryFallback) memoryFallback = new MemoryStorage();
  return memoryFallback;
}

// ============================================================
// Utility — hash IP address with SHA-256
// ============================================================

export async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + '_jailbreak_arcade_salt');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
