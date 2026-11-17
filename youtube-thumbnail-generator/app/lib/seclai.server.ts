// The Seclai handlers, configured for this app. `@seclai/handlers` does the
// work (streaming runs, proxying uploads and downloads, keeping the API key on
// the server); this module supplies what only the app knows:
//
// - Access control: a browser may only run its own sessions with its own
//   uploads, and only download images from its own runs (`authorize*`).
// - The headshot / style roles: the agent has one attachment slot, so the run's
//   input is rewritten to say which upload is which (`authorizeRun`).
// - Saving: the user's turn is stored before the run starts, and the reply in
//   `onRunEnd`, which the handlers call before the browser sees `done`. With
//   `keepReadingAfterDisconnect`, a run whose browser left (another session,
//   "Continue in background", a closed tab) is still read to the end and saved.
// - Local copies of uploads, to show them in the chat (`onUpload`).

import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { createSeclaiHandlers, deny, type SeclaiLogger } from "@seclai/handlers";

import { short } from "./log.server";
import type { Store } from "./store.server";
import type { UploadInfo, UploadKind } from "./types";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Types we can show back in the chat, and the extension to store them under. */
export const DISPLAYABLE_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const RUN_TIMEOUT_MS = 11 * 60 * 1000;
const ACTIONS = new Set(["run", "upload", "download", "attachment-references"]);

/** The app's context for the handlers' hooks, one per request. */
interface RouteCtx {
  ownerId: string;
  /** Set once the user's turn is stored, so an up-front rejection can be stored too. */
  storedTurn?: { sessionId: string };
}

/** The agent has one attachment slot, so the roles go in the text. */
export function describeUploads(uploads: UploadInfo[]): string {
  if (uploads.length === 0) return "";
  const parts = uploads.map((u) =>
    u.kind === "headshot" ? `"${u.filename}" is my photo (the person to feature)` : `"${u.filename}" is a style reference`,
  );
  return `[Attached: ${parts.join("; ")}.]`;
}

export function buildAgentInput(input: string, uploads: UploadInfo[]): string {
  return [describeUploads(uploads), input.trim()].filter(Boolean).join("\n\n");
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : `status ${response.status}`;
  } catch {
    return `status ${response.status}`;
  }
}

/** The upload's session and role, from the upload URL's query string. */
function uploadParams(req: Request): { sessionId: string; kind: UploadKind } | null {
  const params = new URL(req.url).searchParams;
  const sessionId = params.get("sessionId") ?? "";
  const kind = params.get("kind");
  if (!sessionId || (kind !== "headshot" && kind !== "style")) return null;
  return { sessionId, kind };
}

export function createAppSeclai({
  store,
  apiKey,
  agentId,
  dataDir,
  logger,
}: {
  store: Store;
  apiKey: string;
  agentId: string;
  dataDir: string;
  logger?: SeclaiLogger;
}) {
  const uploadsDir = path.join(dataDir, "uploads");

  const seclai = createSeclaiHandlers<RouteCtx>({
    apiKey,
    agentId,
    runTimeoutMs: RUN_TIMEOUT_MS,
    logger,
    keepReadingAfterDisconnect: true,
    upload: {
      maxBytes: MAX_UPLOAD_BYTES,
      checkContentType: true,
      // Keep a copy to show in the chat, and record which session and role it
      // belongs to. `authorizeUpload` has already checked both.
      async onUpload(file, result, req) {
        const params = uploadParams(req)!;
        const ext = DISPLAYABLE_TYPES[file.type]!;
        await mkdir(uploadsDir, { recursive: true });
        const filePath = path.join(uploadsDir, `${crypto.randomUUID()}${ext}`);
        await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
        const info = store.addUpload({
          id: result.id,
          sessionId: params.sessionId,
          filename: file.name || `image${ext}`,
          mime: file.type,
          kind: params.kind,
          path: filePath,
        });
        return Response.json(info);
      },
    },

    authorizeUpload(req, file, { ownerId }) {
      const params = uploadParams(req);
      if (!params) return deny(400, "Say which session the image is for, and whether it's a headshot or a style.");
      if (!store.getSession(ownerId, params.sessionId)) return deny(404, "Session not found.");
      // Only types we can show back in the chat.
      if (!DISPLAYABLE_TYPES[file.type]) return deny(415, "Use a JPEG, PNG or WebP image.");
    },

    authorizeRun(req, body, ctx) {
      const { sessionId, input = "", uploadIds = [] } = body;
      if (!sessionId || !store.getSession(ctx.ownerId, sessionId)) {
        logger?.warn("refused a run: session not found for this browser", { owner: short(ctx.ownerId) });
        return deny(404, "Session not found.");
      }
      const uploads = store.sessionUploads(sessionId, uploadIds);
      if (uploads.length !== uploadIds.length) {
        logger?.warn("refused a run: upload not in session", { session_id: sessionId });
        return deny(404, "Upload not found.");
      }
      // Stored before the run starts, so the turn is there even if the browser
      // leaves while the run is still connecting.
      store.addUserMessage(sessionId, input.trim(), uploadIds);
      ctx.storedTurn = { sessionId };
      return { ...body, input: buildAgentInput(input, uploads) };
    },

    authorizeDownload(req, { runId }, { ownerId }) {
      return store.ownsRun(ownerId, runId);
    },

    // Called once per run, before the browser sees `done`, so the reply is
    // stored by the time the page reloads the session.
    onRunEnd(outcome, { body }) {
      try {
        store.addAssistantMessage(body.sessionId!, {
          runId: outcome.runId,
          status: outcome.status,
          content: outcome.output,
          attachments: outcome.attachments,
          error: outcome.error,
        });
      } catch (err) {
        // For example, the session was deleted while the run was going.
        logger?.warn("couldn't save the reply", {
          session_id: body.sessionId,
          run_id: outcome.runId ?? undefined,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  async function handle(request: Request, ownerId: string, action: string): Promise<Response> {
    if (!ACTIONS.has(action)) return deny(404, "Not found.");
    const ctx: RouteCtx = { ownerId };
    const response = await seclai.withContext(ctx).handle(request);

    // The API refused the run up front (no credits, a file it doesn't take):
    // there's no stream, so `onRunEnd` isn't called. Store the error as the
    // reply, so the turn doesn't sit waiting for one.
    const streaming = response.headers.get("content-type")?.startsWith("text/event-stream");
    if (ctx.storedTurn && !streaming) {
      try {
        store.addAssistantMessage(ctx.storedTurn.sessionId, {
          runId: null,
          status: "failed",
          content: "",
          attachments: [],
          error: await errorText(response),
        });
      } catch {
        /* the session was deleted meanwhile */
      }
    }
    return response;
  }

  /** The agent's accepted attachments. No hook applies, so any owner will do. */
  function attachmentReferences(): Promise<Response> {
    return seclai
      .withContext({ ownerId: "" })
      .attachmentReferences(new Request("http://local/api/seclai/attachment-references"));
  }

  async function serveUpload(ownerId: string, uploadId: string): Promise<Response> {
    const found = store.getOwnedUpload(ownerId, uploadId);
    if (!found) return new Response("Not found", { status: 404 });
    try {
      const { size } = await stat(found.path);
      const body = Readable.toWeb(createReadStream(found.path)) as ReadableStream<Uint8Array>;
      return new Response(body, {
        headers: {
          "content-type": found.mime,
          "content-length": String(size),
          "cache-control": "private, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  async function removeFiles(paths: string[]) {
    await Promise.all(paths.map((p) => rm(p, { force: true })));
  }

  return { handle, attachmentReferences, serveUpload, removeFiles };
}

export type AppSeclai = ReturnType<typeof createAppSeclai>;
