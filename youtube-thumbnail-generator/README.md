<div align="center">
  <h1>Thumbnail Studio</h1>
  <p>Design YouTube thumbnails from your photo by chatting with an agent. Powered by Seclai.</p>
</div>

Start a design session and upload a headshot. You can also add one or two thumbnails whose style you like. Then describe the video. A [Seclai](https://seclai.com) agent streams back a numbered list of 16:9 thumbnail variants with the images attached. Refine them in the same chat ("I like 3, but use the layout of 1 and make the title yellow"), and download any image at full size or as a YouTube-ready 1280×720 JPG.

The app keeps every session. Go back to an earlier one from the sidebar and pick up where you left off.

## Tech stack

- **React Router 8** (framework mode, SSR). It is the React successor of Remix. Remix 3 dropped React, and `@seclai/react` needs React.
- **`@seclai/handlers`** is mounted at `/api/seclai/:action`. It is the server side of the agent: it streams runs over SSE, proxies uploads and downloads, and keeps the API key on the server. Its hooks carry the app's access control, saving and logging.
- **`@seclai/react`**: `useAgentRun` drives the live, streaming reply, and `uploadFile` / `createEndpoints` talk to the handlers.
- **`@seclai/sdk`** is used by `npm run setup` to create and check the agent.
- **SQLite** through Node's built-in `node:sqlite`, with no native addon. It holds sessions, uploads and chat turns.
- **Tailwind CSS 4**.

## How it works

1. **Sessions.** Each browser gets an anonymous, signed `httpOnly` cookie, set in [app/lib/owner.server.ts](app/lib/owner.server.ts). Sessions, uploads and messages are stored against it in [app/lib/store.server.ts](app/lib/store.server.ts). A session's random id is also the agent's `metadata.session_id`. The agent keys its conversation memory on that id, so each session is its own design conversation.
2. **The server side is `@seclai/handlers`**, mounted at `/api/seclai/:action` and configured in [app/lib/seclai.server.ts](app/lib/seclai.server.ts). The app adds only what it alone knows, through the package's hooks, passing the browser's owner id with `withContext({ ownerId })`:
   - **`authorizeRun`** checks that the session and uploads belong to this browser, stores the user's turn, and adds a line telling the agent which file is the headshot and which is a style reference.
   - **`authorizeUpload`** checks the session and the role (both in the upload URL's query string), and **`onUpload`** keeps a local copy to show in the chat. `maxBytes` and `checkContentType` cap uploads at 10 MB and the agent's image types.
   - **`authorizeDownload`** serves images only from this browser's runs.
3. **Runs.** `useAgentRun().start({ input, uploadIds, sessionId })` posts to `/api/seclai/run`, and the browser renders the stream: steps, tokens, then the images, which replace 16:9 skeleton cards.
   - **Saving the reply.** **`onRunEnd`** stores the reply, with its text and image ids. The handlers call it before passing `done` on to the browser, so the reply is in place when the page reloads the session.
   - **When the browser leaves.** With **`keepReadingAfterDisconnect`**, a run whose browser left (another session, **Continue in background**, a closed tab) is still read to the end and its reply saved. The chat shows "still generating" until it arrives.
   - **Up-front refusals.** If the API refuses a run up front (no credits, for example), the error is stored as the reply.
4. **Images** stay with the run on Seclai. The app stores only their ids, and shows them through the handlers' `download` (`createEndpoints().download` from `@seclai/react`).

## Prerequisites

- **Node 22.22+**, which React Router 8 requires. `node:sqlite` is built in.
- A **[Seclai](https://seclai.com) account** with credits. Image generation is billed per image; see [What it costs](#what-it-costs).
- A Seclai **API key**: **Settings → API Keys → Create**. It is shown once.

## Running it

```sh
npm install
cp .env.example .env            # add SECLAI_API_KEY and a SESSION_SECRET (openssl rand -hex 32)
npm run setup -- --create       # creates the agent from the gallery and makes it stream
                                # → paste the printed SECLAI_AGENT_ID into .env
npm run setup                   # checks the agent; should report it's ready
npm run dev                     # http://localhost:5173
```

**Already have the agent** (from the Seclai app: **Agents → New → gallery → "YouTube thumbnail"**)? Put its id in `.env` and run `npm run setup -- --apply` instead of `--create`.

Production build: `npm run build && npm start`.

### What `npm run setup` checks

| Check | Why | `--apply` fixes it |
|---|---|---|
| The trigger accepts images | The photo and style references are uploaded with a message | No: use the gallery agent |
| `session_id` is a declared metadata key | The API refuses runs with undeclared custom keys, and the chat steps key the conversation on it | Yes |
| The reply step is `streaming_result` | The gallery agent ships with `display_result`, which returns the reply only at the end | Yes |

Without a flag, the script changes nothing. It prints what it would change.

## Customizing the agent

[agents/youtube-thumbnail-chat.json](agents/youtube-thumbnail-chat.json) is the gallery agent with the one change this app makes. Under the `prompt_call` step,

```diff
- { "step_type": "display_result", "id": "show_images", "name": "Show the images", "html_format": false }
+ { "step_type": "streaming_result", "id": "stream_reply", "name": "Stream the reply" }
```

You can make the same edit by hand in the Seclai app. The `memory_bank_id` in the export is a placeholder. When you import the file, bind it to a **conversation** memory bank.

Other knobs on the `design` step:
- **Variants per reply.** The instructions default to 4. Raise `max_generation_calls_per_run` and `max_generation_credits_per_run` along with it. `DEFAULT_VARIANTS` in [app/lib/expected-images.ts](app/lib/expected-images.ts) is the first-turn placeholder count. Later turns follow the streamed numbered list, a count the user asked for, or the previous reply's count. A plain "undo that" shows none, because the agent replies to it without making an image.
- **Channel style.** Add your colours, typeface style or a fixed title position to the system instructions.
- **Public figures.** The "Public figures and other brands" policy only records. Switch it to enforce to block such requests.

## What it costs

Each reply is capped by the agent at **6 image generations and 3,000 credits**. Text and uploads are a small part of that. Check a run's cost in the Seclai dashboard.

## Limitations

- **The cookie is `Secure` only over HTTPS**, so the app also works on a plain-http LAN address. Behind a proxy that terminates TLS, set `COOKIE_SECURE=true`.
- **The only auth is a per-browser cookie.** Anyone who can reach the app can run the agent on your credits. Put real auth or rate limiting in front of a public deployment.
- **Runs can't be stopped.** Leaving a session while it's generating, closing the tab, or clicking **Continue in background** only stops watching. The run finishes on Seclai and uses its credits, and the server keeps reading it and saves the reply, which appears when you come back. A server restart during a run loses that reply.
- **Long sessions forget.** The agent remembers your last few requests. After many rounds, upload your photo again.
- **Uploads pass through the server.** They are capped at 10 MB each and 3 per message, the agent's limit. JPEG, PNG and WebP only.
- **Local storage.** The SQLite database and uploaded photos live in `DATA_DIR` (default `./data`). This is a demo store for a single server.

## Server logs

The handlers log each stage of a run, plus uploads, downloads and refused requests, through their `logger` option, using the app's own formatter. The lines go to the terminal running `npm run dev` or `npm start`:

```
INFO  [seclai] run starting session_id=f06fdb00-… uploads=2 input_chars=48
INFO  [seclai] stream open session_id=f06fdb00-… ms=412
INFO  [seclai] run started run_id=8b1d07aa-… session_id=f06fdb00-…
INFO  [seclai] step run_id=8b1d07aa-… step="Design the images" message="Prompt call started"
INFO  [seclai] first token run_id=8b1d07aa-… ms=21300
INFO  [seclai] run done run_id=8b1d07aa-… status=completed attachments=4 tokens=201 ms=74900
```

A run that finishes with no streamed tokens logs a warning, because it usually means the agent still uses `display_result`. Set `LOG_LEVEL=debug` to also see every event, token and keepalive.

## Troubleshooting

- **`SECLAI_API_KEY` / `SECLAI_AGENT_ID` / `SESSION_SECRET is not set`.** Fill them in `.env` and restart.
- **"The Seclai API rejected the server's credentials".** The API key is wrong or revoked.
- **The run is refused with a 400 about metadata.** `session_id` isn't declared on the trigger. Run `npm run setup -- --apply`.
- **The reply appears all at once instead of streaming.** The agent still ends in `display_result`. Run `npm run setup` to check.
- **The run ends as failed right away.** A governance policy may have blocked the message, for example an attempt to change the designer's rules. The error shows in the chat. The run's details are in the Seclai dashboard.

## License

MIT
