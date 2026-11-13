// Watches the run's server-sent events on their way to the browser, so the
// server can store the reply without trusting the browser to report it.
//
// Each chunk is passed on only after `onEvent` resolves for every event that
// ends in it. So by the time the browser sees `done`, the reply is stored.

import type { MessageStatus, StoredAttachment } from "./types";

export interface SseEvent {
  event: string;
  data: unknown;
}

/** Incremental parser for the `event:` / `data:` lines of an SSE stream. */
export function createSseParser() {
  let buffer = "";

  function parseFrame(frame: string): SseEvent | null {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) return null;
    const raw = data.join("\n");
    try {
      return { event, data: JSON.parse(raw) };
    } catch {
      return { event, data: raw };
    }
  }

  return {
    /** Feed decoded text; returns the events completed by it. */
    feed(text: string): SseEvent[] {
      buffer += text;
      const events: SseEvent[] = [];
      let match: RegExpExecArray | null;
      const boundary = /\r?\n\r?\n/g;
      let start = 0;
      while ((match = boundary.exec(buffer))) {
        const parsed = parseFrame(buffer.slice(start, match.index));
        if (parsed) events.push(parsed);
        start = match.index + match[0].length;
      }
      buffer = buffer.slice(start);
      return events;
    },
  };
}

export type CloseReason = "end" | "cancel";

export function tapEventStream(
  source: ReadableStream<Uint8Array>,
  hooks: {
    onEvent(event: SseEvent): void | Promise<void>;
    onClose(reason: CloseReason): void | Promise<void>;
    /** Called with each raw chunk as it arrives, before its events. */
    onChunk?(byteLength: number, text: string): void;
  },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let closed = false;

  const close = async (reason: CloseReason) => {
    if (closed) return;
    closed = true;
    await hooks.onClose(reason);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err) {
        await close("end");
        controller.error(err);
        return;
      }
      if (result.done) {
        await close("end");
        controller.close();
        return;
      }
      const text = decoder.decode(result.value, { stream: true });
      hooks.onChunk?.(result.value.byteLength, text);
      for (const event of parser.feed(text)) {
        await hooks.onEvent(event);
      }
      controller.enqueue(result.value);
    },
    async cancel(reason) {
      await close("cancel");
      await reader.cancel(reason);
    },
  });
}

/** What to store for the assistant's turn. */
export interface RunOutcome {
  runId: string | null;
  status: MessageStatus;
  content: string;
  attachments: StoredAttachment[];
  error: string | null;
}

interface RunSnapshot {
  run_id?: string;
  status?: string;
  output?: string | null;
  attachments?: Array<{ id?: unknown; name?: unknown; mime?: unknown }> | null;
  attempts?: Array<{ error?: string | null }> | null;
}

function lastAttemptError(run: RunSnapshot): string | null {
  for (const attempt of [...(run.attempts ?? [])].reverse()) {
    if (attempt?.error) return attempt.error;
  }
  return null;
}

/**
 * Turns a run's events into exactly one {@link RunOutcome}, handed to `save`
 * once: on `done`, `error` or `timeout`, or when the stream ends or is
 * cancelled without one.
 */
export function createRunRecorder(save: (outcome: RunOutcome) => void | Promise<void>) {
  let runId: string | null = null;
  let text = "";
  let saved = false;

  const finish = async (outcome: Omit<RunOutcome, "runId"> & { runId?: string | null }) => {
    if (saved) return;
    saved = true;
    await save({ ...outcome, runId: outcome.runId ?? runId });
  };

  return {
    async onEvent({ event, data }: SseEvent) {
      const payload = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
      switch (event) {
        case "init":
          if (typeof payload.run_id === "string") runId = payload.run_id;
          return;
        case "stream_token":
          if (typeof payload.token === "string") text += payload.token;
          return;
        case "done": {
          const run = payload as RunSnapshot;
          const attachments: StoredAttachment[] = (run.attachments ?? []).flatMap((a) =>
            typeof a?.id === "string"
              ? [{
                  id: a.id,
                  name: typeof a.name === "string" ? a.name : null,
                  mime: typeof a.mime === "string" ? a.mime : "application/octet-stream",
                }]
              : [],
          );
          const failed = run.status === "failed";
          await finish({
            runId: run.run_id ?? runId,
            status: failed ? "failed" : "completed",
            // A failed run's `output` may hold text that failed validation.
            content: failed ? text : run.output || text,
            attachments,
            error: failed ? lastAttemptError(run) ?? "The run failed." : null,
          });
          return;
        }
        case "error":
          await finish({
            status: "failed",
            content: text,
            attachments: [],
            error: typeof payload.error === "string" ? payload.error : "The run failed.",
          });
          return;
        case "timeout":
          await finish({
            status: "failed",
            content: text,
            attachments: [],
            error: "The run timed out.",
          });
          return;
      }
    },
    async onClose(reason: CloseReason) {
      await finish(
        reason === "cancel"
          ? { status: "cancelled", content: text, attachments: [], error: null }
          : { status: "failed", content: text, attachments: [], error: "The stream ended without a result." },
      );
    },
  };
}
