# Moderation Playground

A small Astro + React app that moderates marketplace listing photos through a
[Seclai](https://seclai.com) agent. Drop in a JPG/PNG (and optional caption),
and the agent returns a strict JSON verdict — approve, review, or reject —
with violations, advisory flags, a quality score, and confidence.

## Stack

- **Astro 6** with `output: 'server'` (Node adapter) — keeps the Seclai API key
  off the browser via on-demand server endpoints.
- **React 19** island for the interactive form/result UI.
- **`@seclai/sdk`** for the upload → run → poll flow.

## How it works

1. Browser POSTs `image` + optional `caption` to [src/pages/api/moderate.ts](src/pages/api/moderate.ts).
2. The route calls `moderateListing()` in [src/lib/moderation.ts](src/lib/moderation.ts),
   which builds the prompt and hands the image + text to the Seclai agent via the
   thin SDK wrapper in [src/lib/seclai.ts](src/lib/seclai.ts).
3. The agent (vision-enabled, Claude Sonnet, temperature 0) returns a JSON
   blob; we parse it tolerantly and **compute the verdict in code** from the
   violations rather than trusting whatever the model writes.
4. The React component in [src/components/ModerationPlayground.tsx](src/components/ModerationPlayground.tsx)
   renders the result as a card or raw JSON.

## Prerequisites

- Node 20+ (22 recommended).
- A Seclai account on the **Pro** plan or above (MCP access).
- The Seclai agent this app expects: **Marketplace Listing Moderator**
  (id `188395f3-e711-424a-8a88-2376e7580db8`). It's a 3-step workflow:
  `prompt_call` (vision) → `extract_content` (JSON) → `display_result`.

If you need to recreate the agent, see [Recreating the agent](#recreating-the-agent) below.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get a Seclai API key

In the Seclai dashboard: **Account Settings → API Keys → Create**. Copy the
key — it's shown only once. This is the *runtime* key the deployed app uses.

> If you're managing Seclai resources from your editor via the MCP server (see
> [.mcp.json](.mcp.json)), use a **separate** key for that — don't reuse the
> runtime key.

### 3. Configure `.env.local`

```bash
cp .env.example .env.local
```

Then fill in:

```
SECLAI_API_KEY=sk_...
SECLAI_AGENT_ID=188395f3-e711-424a-8a88-2376e7580db8
SECLAI_BASE_URL=https://api.seclai.com
```

`.env.local` is gitignored. Astro's Node adapter picks it up automatically in
both `dev` and `preview`.

### 4. Run it

```bash
npm run dev
```

Open the URL the dev server prints (typically `http://localhost:4321`),
drop in a listing photo, and click **Run moderation**.

## Testing the API directly

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
| `npm run dev` | Astro dev server with HMR |
| `npm run build` | Production build (Node standalone) |
| `npm run preview` | Run the production build locally |

## Project layout

```
src/
  components/
    ModerationPlayground.tsx   # React island: dropzone, caption, result UI
  lib/
    seclai.ts                  # Generic @seclai/sdk wrapper (env, upload, run)
    moderation.ts              # App-specific: prompt, schema, parser, decide()
  pages/
    index.astro                # Hosts the React island; global styles
    api/
      moderate.ts              # POST endpoint: validates + calls the agent
```

The split between `seclai.ts` (generic) and `moderation.ts` (app-specific) is
intentional: lift `seclai.ts` straight into another Seclai-powered app.

## Recreating the agent

If the agent has been deleted from your Seclai org, you can recreate it via
the MCP server (Pro+ plan) or from the dashboard. The agent must:

- Use `dynamic_input` trigger (accepts text + file uploads).
- Have a single `prompt_call` step on a **vision-capable** model
  (Claude Sonnet, GPT-4o, Gemini Vision) at temperature 0, with:
  - `prompt_template`: `{{input}}\n{{agent.attachments}}`
  - `system_template`: short framing telling the model to follow the
    user-provided instructions verbatim and return ONLY a single JSON object.
- Followed by an `extract_content` step (`expected_format: json`,
  `query: "$"`) and a `display_result` step (`template: "{{input}}"`).

The full prompt the app sends — defining the JSON schema and severity
guidance — lives in [src/lib/moderation.ts](src/lib/moderation.ts#L33-L60).
After creating, update `SECLAI_AGENT_ID` in [.env.local](.env.local).

## Troubleshooting

- **`SECLAI_API_KEY is not set`** — fill it into [.env.local](.env.local) and
  restart the dev server.
- **`Seclai run failed` / empty output** — confirm the agent's `prompt_call`
  step is on a vision-capable model and that the image is reaching the agent
  (check the run in the Seclai dashboard).
- **`That doesn't look like a listing photo`** — the agent flagged
  `is_listing_photo: false`. Try a clearer product shot.
- **403 from `curl`** — add `-H "Origin: $O"` matching the dev URL (Astro CSRF).
