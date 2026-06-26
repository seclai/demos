# Listing Moderator

A small Astro + React app that moderates marketplace listing photos through a
[Seclai](https://seclai.com) agent. Drop in a JPG/PNG (and optional caption),
and the agent returns a strict JSON verdict — approve, review, or reject —
with violations, advisory flags, a quality score, and confidence.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/seclai/demos/tree/main/listing-moderator)

> One-click deploy clones this app into your own GitHub account, provisions the
> Worker (and the `SESSION` KV namespace), and builds it. You still add your
> Seclai credentials as secrets afterward — see
> [One-click deploy](#option-a--one-click-deploy-to-cloudflare) for the two
> post-deploy steps.

## Stack

- **Astro 6** with `output: 'server'` (Cloudflare adapter) — keeps the Seclai
  API key off the browser via on-demand server endpoints, and deploys as a
  single Cloudflare Worker.
- **React 19** island for the interactive form/result UI.
- **`@seclai/sdk`** for the upload → run → poll flow.

## How it works

1. Browser POSTs `image` + optional `caption` to [src/pages/api/moderate.ts](src/pages/api/moderate.ts).
2. The route calls `moderateListing()` in [src/lib/moderation.ts](src/lib/moderation.ts),
   which hands the image (and the caption, if any) to the Seclai agent via the
   thin SDK wrapper in [src/lib/seclai.ts](src/lib/seclai.ts). The moderator
   prompt lives on the **agent** (its `system_template`), not in the runtime
   input — sending it as `input` trips Seclai's always-on prompt-injection
   scanner.
3. The agent (vision-enabled, Claude Sonnet, temperature 0) returns a JSON
   blob; we parse it tolerantly and **compute the verdict in code** from the
   violations rather than trusting whatever the model writes.
4. The React component in [src/components/ListingModerator.tsx](src/components/ListingModerator.tsx)
   renders the result as a card or raw JSON.

## Prerequisites

- Node 20+ (22 recommended).
- A [Seclai](https://seclai.com) account (any plan with agent creation).
- A [Cloudflare](https://cloudflare.com) account — only needed to deploy. Local
  dev works without it.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the Seclai agent (import the JSON)

Two ready-to-import agent definitions live in [agents/](agents/):

| File | Use for |
|---|---|
| [`agents/marketplace-listing-moderator.development.json`](agents/marketplace-listing-moderator.development.json) | Local dev. `temperature: 0`, no model auto-upgrade. |
| [`agents/marketplace-listing-moderator.production.json`](agents/marketplace-listing-moderator.production.json) | Production. Same workflow + `cautious_adopter` model upgrades + auto-rollback on eval/run failures. |

In the Seclai dashboard:

1. Go to **Agents** → click **Import** in the top-right.
2. Pick one of the JSON files above (start with the development one).
3. Confirm the name and click **Import as new agent**.
4. Open the new agent and copy its **ID** from the URL or the agent header —
   you'll paste it into `.env.local` in step 4.

The JSON imports clean: the moderator system prompt is already in the
`prompt_call` step's `system_template`, the `dynamic_input` trigger accepts
image uploads, and the `extract_content` → `display_result` chain returns
strict JSON to the app.

### 3. Get a Seclai API key

In the Seclai dashboard: **Account Settings → API Keys → Create**. Copy the
key — it's shown only once. This is the *runtime* key the deployed app uses.

> If you're managing Seclai resources from your editor via the MCP server (see
> [.mcp.json](.mcp.json)), use a **separate** key for that — don't reuse the
> runtime key.

### 4. Configure `.env.local`

```bash
cp .env.example .env.local
```

Then fill in:

```
SECLAI_API_KEY=sk_...
SECLAI_AGENT_ID=<paste the agent id from step 2>
SECLAI_BASE_URL=https://api.seclai.com
```

`.env.local` is gitignored. The Cloudflare adapter's `platformProxy` picks it
up automatically in `dev`.

### 5. Run it

```bash
npm run dev
```

Open the URL the dev server prints (typically `http://localhost:4321`),
drop in a listing photo, and click **Run moderation**.

## Deploy to Cloudflare

The app is wired for [Cloudflare Workers](https://workers.cloudflare.com) via
[`@astrojs/cloudflare`](https://docs.astro.build/en/guides/integrations-guide/cloudflare/).
The whole SSR app ships as one Worker.

### Option A — one-click "Deploy to Cloudflare"

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/seclai/demos/tree/main/listing-moderator)

Click the button. Cloudflare clones this subdirectory into a new repo under your
own GitHub account, runs `npm run build`, provisions the Worker, and creates the
`SESSION` KV namespace automatically.

It can't bake in secrets, so after the first deploy finishes:

1. **Add your Seclai credentials.** In the Cloudflare dashboard, open the new
   Worker → **Settings → Variables and Secrets**, and add `SECLAI_API_KEY` and
   `SECLAI_AGENT_ID` (use your **production** agent id). `SECLAI_BASE_URL` is
   optional — only set it for a custom Seclai host. Or from the cloned repo:
   ```bash
   wrangler secret put SECLAI_API_KEY
   wrangler secret put SECLAI_AGENT_ID
   ```
2. **Redeploy** so the Worker picks up the secrets (dashboard **Deployments →
   Retry**, or `wrangler deploy`).

> Need the production agent first? Import
> [agents/marketplace-listing-moderator.production.json](agents/marketplace-listing-moderator.production.json)
> into Seclai (see [step 2](#2-create-the-seclai-agent-import-the-json)) and use
> its id for `SECLAI_AGENT_ID`.

### Option B — Wrangler CLI

### 1. Install Wrangler and log in

```bash
npm install -g wrangler
wrangler login
```

### 2. Add your Seclai credentials as Worker secrets

Secrets stay out of the repo and out of [wrangler.toml](wrangler.toml):

```bash
wrangler secret put SECLAI_API_KEY      # paste the key when prompted
wrangler secret put SECLAI_AGENT_ID     # paste the production agent id
# SECLAI_BASE_URL is optional — only set it if you point at a custom Seclai host
```

For production, import the **production** agent JSON ([agents/marketplace-listing-moderator.production.json](agents/marketplace-listing-moderator.production.json))
into Seclai and use its id here.

### 3. Build and deploy

```bash
npm run build      # writes dist/ via @astrojs/cloudflare
wrangler deploy    # uploads the Worker
```

Wrangler prints the live URL. The first deploy will prompt to create the
`SESSION` KV namespace that Astro sessions need — accept the prompt.

### 4. Updating later

Re-run `npm run build && wrangler deploy`. To rotate credentials, run
`wrangler secret put SECLAI_API_KEY` again — no redeploy needed.## Testing the API directly

Astro 6 enforces same-origin POSTs, so a bare `curl` will get a 403 unless you
send a matching `Origin` header:

```bash
O="http://localhost:4321"   # match the port the dev server prints
curl -s -X POST "$O/api/moderate" -H "Origin: $O" \
  -F "image=@/path/to/listing.jpg;type=image/jpeg" \
  -F "caption=Vintage leather sofa" \
  -w "\nHTTP %{http_code}\n"
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Astro dev server with HMR (via Cloudflare's miniflare proxy) |
| `npm run build` | Production build for Cloudflare Workers (writes `dist/`) |
| `npm run preview` | Run the built Worker locally with `wrangler dev` |

## Project layout

```
agents/
  marketplace-listing-moderator.development.json   # importable Seclai agent (dev)
  marketplace-listing-moderator.production.json    # importable Seclai agent (prod)
src/
  components/
    ListingModerator.tsx   # React island: dropzone, caption, result UI
  lib/
    seclai.ts                  # Generic @seclai/sdk wrapper (env, upload, run)
    moderation.ts              # App-specific: system prompt, schema, parser, decide()
  pages/
    index.astro                # Hosts the React island; global styles
    api/
      moderate.ts              # POST endpoint: validates + calls the agent
```

The split between `seclai.ts` (generic) and `moderation.ts` (app-specific) is
intentional: lift `seclai.ts` straight into another Seclai-powered app.

## Customizing the agent

The agent's workflow lives in the two JSON files in [agents/](agents/). The
important fields on the `prompt_call` step:

- **`system_template`** — the moderator prompt + JSON schema. This is the
  single source of truth for what the agent does. The same text is mirrored in
  [src/lib/moderation.ts](src/lib/moderation.ts) as `MODERATOR_SYSTEM_PROMPT`
  for reference. If you change one, update the other.
- **`prompt_template`** — `{{input}}\n{{agent.attachments}}`. `{{input}}` is
  the (optional, short) seller caption sent at runtime; `{{agent.attachments}}`
  is the listing image.
- **`model`** — set to a vision-capable model. The exports use
  `openai_gpt_5_5`; swap in Claude Sonnet, Gemini Vision, or any other
  vision-capable model in your Seclai account.

The moderator prompt **must** live on `system_template`, not in the runtime
`input` — Seclai's always-on prompt-injection scanner flags long
"You are a moderator… weapons, drugs…" text when it arrives as user input.
See the prompt-scanner troubleshooting entry below.

After editing the agent in the Seclai dashboard, re-export it (UI: agent →
**Export**) and overwrite the JSON in [agents/](agents/) so the repo stays in
sync.

## Troubleshooting

- **`SECLAI_API_KEY is not set`** — fill it into [.env.local](.env.local) and
  restart the dev server.
- **`Seclai run failed … input_scan=unsafe`** — the prompt-injection scanner
  flagged the runtime `input`. The moderator prompt must live in the agent's
  `system_template`; only the (short) seller caption should be sent as
  `input`. See [Customizing the agent](#customizing-the-agent) above.
- **`Seclai run failed` / empty output** — confirm the agent's `prompt_call`
  step is on a vision-capable model and that the image is reaching the agent
  (check the run in the Seclai dashboard).
- **`That doesn't look like a listing photo`** — the agent flagged
  `is_listing_photo: false`. Try a clearer product shot.
- **403 from `curl`** — add `-H "Origin: $O"` matching the dev URL (Astro CSRF).
