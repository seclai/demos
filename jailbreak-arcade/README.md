# Jailbreak Arcade

An interactive demo showcasing [Seclai](https://seclai.com) AI governance. Try to jailbreak **BankBot** — a fictional AI banking assistant — and see how governance policies protect it.

## Stack

- **Astro 6** with React islands and server-side rendering
- **Tailwind CSS v4** via `@tailwindcss/vite`
- **Cloudflare Pages** with KV for leaderboard and rate limiting
- **Seclai API** for BankBot agent, Judge agent, and governance

## Getting Started

```bash
npm install
cp .env.example .env
npm run dev
```

The app runs in **stub mode** by default (no API keys needed). Stubbed responses have a `[STUBBED]` marker. Set `SECLAI_STUB=false` and provide your API keys for real Seclai integration.

## Environment Variables

| Variable | Description |
| --- | --- |
| `SECLAI_API_KEY` | Your Seclai API key |
| `SECLAI_BANKBOT_AGENT_ID` | Agent ID for the BankBot agent |
| `SECLAI_JUDGE_AGENT_ID` | Agent ID for the Judge agent |
| `SECLAI_STUB` | Set to `true` to force stub mode (default when no API key) |

## Deployment

```bash
npm run build
npx wrangler pages deploy dist/
```

Create a KV namespace and bind it as `JAILBREAK_KV` in your Cloudflare dashboard. Set environment variables in the Pages project settings.

## Seclai Setup

Create two agents in your Seclai dashboard:

1. **BankBot** — Banking assistant with governance policies enabled
2. **Judge** — Evaluator agent that returns `{ broken, ruleBroken, reasoning }`

Or run `npx tsx scripts/setup-seclai.ts` to create them programmatically.
