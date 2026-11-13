// Logs a run's progress as its events stream through the server.
//
// info:  stream opened, run id, each step, the first token, a progress line
//        every few seconds while tokens arrive, and how the run ended.
// debug: also every chunk, token and keepalive.

import { type Logger, preview, short, since } from "./log.server";
import type { CloseReason, SseEvent } from "./sse-tap.server";

const PROGRESS_EVERY_MS = 5_000;

export function createRunLog(log: Logger, sessionId: string, start: number) {
  let runId: string | null = null;
  let tokens = 0;
  let chars = 0;
  let firstTokenAt: number | null = null;
  let lastProgress = 0;
  let lastStep = "";
  let bytes = 0;
  let ended = false;

  const ctx = () => ({ session: short(sessionId), run: short(runId), t: since(start) });

  return {
    onChunk(byteLength: number, text: string) {
      bytes += byteLength;
      if (!log.debugEnabled) return;
      if (text.startsWith(": keepalive")) log.debug("keepalive", ctx());
      else log.debug("chunk", { ...ctx(), bytes: byteLength });
    },

    onEvent({ event, data }: SseEvent) {
      const payload = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
      switch (event) {
        case "init":
          if (typeof payload.run_id === "string") runId = payload.run_id;
          log.info("run started", { ...ctx(), run_id: runId ?? undefined });
          return;

        case "step_progress": {
          const name = typeof payload.step_name === "string" ? payload.step_name : String(payload.step_id ?? "?");
          const message = typeof payload.message === "string" ? payload.message : "";
          const key = `${name}|${message}`;
          if (key === lastStep) return;
          lastStep = key;
          log.info("step", { ...ctx(), step: name, message: message || undefined });
          return;
        }

        case "stream_token": {
          const token = typeof payload.token === "string" ? payload.token : "";
          tokens += 1;
          chars += token.length;
          const now = performance.now();
          if (firstTokenAt === null) {
            firstTokenAt = now;
            lastProgress = now;
            log.info("first token", { ...ctx(), token: preview(token, 40) });
          } else if (now - lastProgress >= PROGRESS_EVERY_MS) {
            lastProgress = now;
            log.info("streaming", { ...ctx(), tokens, chars });
          }
          log.debug("token", { ...ctx(), n: tokens, token: preview(token, 40) });
          return;
        }

        case "done": {
          ended = true;
          const attachments = Array.isArray(payload.attachments) ? payload.attachments.length : 0;
          const output = typeof payload.output === "string" ? payload.output : "";
          const fields = {
            ...ctx(),
            status: payload.status,
            images: attachments,
            tokens,
            output_chars: output.length,
            bytes,
          };
          if (payload.status === "failed") log.warn("run failed", fields);
          else log.info("run done", fields);
          if (tokens === 0 && payload.status !== "failed") {
            log.warn("no tokens streamed: is the agent's reply step `streaming_result`? Run `npm run setup`.", ctx());
          }
          if (attachments === 0 && payload.status !== "failed") {
            log.warn("the run finished without images", ctx());
          }
          return;
        }

        case "error":
          ended = true;
          log.error("stream error", { ...ctx(), error: payload.error ?? data });
          return;

        case "timeout":
          ended = true;
          log.error("run timed out", ctx());
          return;

        default:
          log.debug("event", { ...ctx(), event });
      }
    },

    onClose(reason: CloseReason) {
      if (reason === "cancel") log.info("browser disconnected; the run continues on Seclai", { ...ctx(), tokens });
      else if (!ended) log.warn("stream ended without a result", { ...ctx(), tokens, bytes });
      else log.debug("stream closed", ctx());
    },
  };
}
