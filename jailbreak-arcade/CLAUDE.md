# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Jailbreak Arcade is an interactive demo for [Seclai](https://seclai.com) AI governance. Users try to jailbreak **BankBot** (a fictional AI banking assistant) and a Judge agent evaluates whether the bot broke its rules. Successful jailbreaks appear on a public leaderboard.

## Commands

```bash
npm run dev          # Start local dev server (stub mode by default, no API keys needed)
npm run build        # Production build
npm run setup:seclai # Create BankBot + Judge agents in Seclai dashboard
```

Deploy: `npx wrangler pages deploy dist/`

## Architecture

**Stack:** Astro 6 (SSR) + React islands + Tailwind CSS v4 + Cloudflare Pages + KV

### Request Flow (POST /api/chat)

1. User sends message → rate limit check (IP-hashed, 10/hour)
2. `callBankBot()` sends message to Seclai BankBot agent (with last 6 exchanges as context)
3. If Seclai governance blocks the response → verdict is **Defended**
4. Otherwise, `callJudge()` sends `{userMessage, botResponse}` to the Judge agent
5. Judge returns `{broken, ruleBroken, reasoning}` → verdict is **Broken** or **Safe**
6. Broken attempts are saved to KV and added to the leaderboard

### Key Modules

- `src/lib/seclai.ts` — Seclai API client (start run → poll until complete), governance detection, judge output parsing, and stub mode for local dev
- `src/lib/storage.ts` — Storage abstraction with `KVStorage` (Cloudflare KV) and `MemoryStorage` (in-memory fallback for local dev). KV keys: `attempt:<uuid>`, `leaderboard:recent`, `ratelimit:<ipHash>`
- `src/lib/bankbot-rules.ts` — BankBot's allowed/forbidden rules (8 forbidden rules like no-financial-advice, english-only, no-human-claim)
- `src/lib/types.ts` — Shared types (`Attempt`, `ChatExchange`, `JudgeResult`, `Verdict`, Seclai API types)

### API Routes

- `POST /api/chat` — Main chat endpoint, orchestrates BankBot → governance check → Judge
- `GET /api/leaderboard?limit=N` — Returns recent successful jailbreaks (max 50)
- `GET /api/attempt/[id]` — Single attempt details by UUID

### React Components (islands)

- `ChatUI.tsx` — Main chat interface with message history, stats bar, and suggestion chips
- `ChatMessage.tsx` — Individual message bubble with verdict badge
- `VerdictBadge.tsx` — Colored badge (Broken/Defended/Safe)
- `LeaderboardTable.tsx` — Leaderboard display

### Stub Mode

When `SECLAI_API_KEY` is missing or `SECLAI_STUB=true`, all Seclai calls return mocked responses marked with `[STUBBED]`. BankBot returns random canned responses, governance blocks ~20% of the time, and the judge reports ~30% as broken.

## Environment

Env vars are accessed via Cloudflare runtime locals in production, falling back to `import.meta.env` in dev. Types are declared in `env.d.ts`. The Cloudflare adapter uses `platformProxy: { enabled: true }` for local KV emulation.

Required for real mode: `SECLAI_API_KEY`, `SECLAI_BANKBOT_AGENT_ID`, `SECLAI_JUDGE_AGENT_ID`. KV binding: `JAILBREAK_KV`.
