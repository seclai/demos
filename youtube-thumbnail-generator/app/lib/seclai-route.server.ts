// Ownership checks in front of @seclai/handlers, which have no auth of their own.
//
// - `run` only runs sessions and uploads that belong to the caller, adds a note
//   saying which upload is the headshot and which is a style reference, and
//   stores both sides of the turn.
// - `download` only serves images from the caller's own runs.
// - `upload` is not exposed here: uploads go through the session-scoped route,
//   which also keeps a copy to show in the chat.

import type { SeclaiHandlers } from "@seclai/handlers";

import { createLogger, type Logger, preview, short, since } from "./log.server";
import { createRunLog } from "./run-log.server";
import { createRunRecorder, type SseEvent, tapEventStream } from "./sse-tap.server";
import type { Store } from "./store.server";
import type { UploadInfo } from "./types";

function jsonError(status: number, error: string): Response {
  return Response.json({ error, status }, { status });
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

export function createSeclaiRoute({
  store,
  seclai,
  log = createLogger("seclai"),
}: {
  store: Store;
  seclai: SeclaiHandlers;
  log?: Logger;
}) {
  const runLog = log.child("run");
  const downloadLog = log.child("download");

  async function run(request: Request, ownerId: string): Promise<Response> {
    if (request.method !== "POST") return jsonError(405, "Method not allowed.");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "The request body must be JSON.");
    }
    const { input = "", uploadIds = [], sessionId } = (body ?? {}) as {
      input?: unknown;
      uploadIds?: unknown;
      sessionId?: unknown;
    };
    if (typeof input !== "string") return jsonError(400, "`input` must be a string.");
    if (!Array.isArray(uploadIds) || !uploadIds.every((id) => typeof id === "string")) {
      return jsonError(400, "`uploadIds` must be an array of strings.");
    }
    if (typeof sessionId !== "string" || !store.getSession(ownerId, sessionId)) {
      runLog.warn("refused: session not found for this browser", { owner: short(ownerId) });
      return jsonError(404, "Session not found.");
    }
    const uploads = store.sessionUploads(sessionId, uploadIds);
    if (uploads.length !== uploadIds.length) {
      runLog.warn("refused: upload not in session", { session: short(sessionId), requested: uploadIds.length, found: uploads.length });
      return jsonError(404, "Upload not found.");
    }
    if (!input.trim() && uploads.length === 0) return jsonError(400, "Write a message or attach a photo.");

    const start = performance.now();
    runLog.info("starting", {
      session: short(sessionId),
      uploads: uploads.map((u) => `${u.kind}:${u.filename}`).join(",") || undefined,
      input_chars: input.trim().length,
    });
    runLog.debug("input", { session: short(sessionId), text: preview(input, 200) });

    const forwarded = new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: buildAgentInput(input, uploads), uploadIds, sessionId }),
      signal: request.signal,
    });
    const response = await seclai.run(forwarded);
    const isStream = response.headers.get("content-type")?.startsWith("text/event-stream");
    if (!response.ok || !isStream || !response.body) {
      runLog.error("rejected by the Seclai API", {
        session: short(sessionId),
        status: response.status,
        error: await errorText(response),
        t: since(start),
      });
      return response;
    }
    runLog.info("stream open", { session: short(sessionId), t: since(start) });

    store.addUserMessage(sessionId, input.trim(), uploadIds);
    const recorder = createRunRecorder((outcome) => {
      store.addAssistantMessage(sessionId, outcome);
      runLog.info("reply saved", {
        session: short(sessionId),
        run: short(outcome.runId),
        status: outcome.status,
        images: outcome.attachments.length,
      });
    });
    const progress = createRunLog(runLog, sessionId, start);
    const hooks = {
      onChunk: progress.onChunk,
      async onEvent(event: SseEvent) {
        progress.onEvent(event);
        await recorder.onEvent(event);
      },
      async onClose(reason: "end" | "cancel") {
        progress.onClose(reason);
        await recorder.onClose(reason);
      },
    };
    return new Response(tapEventStream(response.body, hooks), {
      status: response.status,
      headers: response.headers,
    });
  }

  async function download(request: Request, ownerId: string): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const runId = params.get("runId") ?? "";
    const fields = { run: short(runId), attachment: params.get("attachmentId") ?? undefined };
    if (!store.ownsRun(ownerId, runId)) {
      downloadLog.warn("refused: run not in this browser's sessions", fields);
      return jsonError(404, "Image not found.");
    }
    const start = performance.now();
    const response = await seclai.download(request);
    if (response.ok) {
      downloadLog.debug("served", { ...fields, type: response.headers.get("content-type"), t: since(start) });
    } else {
      downloadLog.error("failed", { ...fields, status: response.status, error: await errorText(response) });
    }
    return response;
  }

  return async function handle(request: Request, ownerId: string, action: string): Promise<Response> {
    switch (action) {
      case "run":
        return run(request, ownerId);
      case "download":
        return download(request, ownerId);
      case "attachment-references":
        return seclai.attachmentReferences(request);
      default:
        return jsonError(404, "Not found.");
    }
  };
}
