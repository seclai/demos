import { describe, expect, it } from "vitest";

import { createRunRecorder, createSseParser, type RunOutcome, tapEventStream } from "../app/lib/sse-tap.server";

const enc = new TextEncoder();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function streamOf(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  let out = "";
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

describe("createSseParser", () => {
  it("parses events split across chunks and skips comments", () => {
    const p = createSseParser();
    const text = `: keepalive\n\n${frame("init", { run_id: "r1" })}${frame("stream_token", { token: "Hi" })}`;
    const a = p.feed(text.slice(0, 25));
    const b = p.feed(text.slice(25));
    expect([...a, ...b]).toEqual([
      { event: "init", data: { run_id: "r1" } },
      { event: "stream_token", data: { token: "Hi" } },
    ]);
  });

  it("handles CRLF line endings", () => {
    const p = createSseParser();
    expect(p.feed('event: done\r\ndata: {"a":1}\r\n\r\n')).toEqual([{ event: "done", data: { a: 1 } }]);
  });
});

describe("tapEventStream + createRunRecorder", () => {
  it("stores the reply before passing `done` on, and relays bytes unchanged", async () => {
    const saved: RunOutcome[] = [];
    const recorder = createRunRecorder((o) => {
      saved.push(o);
    });
    const body =
      frame("init", { run_id: "11111111-1111-4111-8111-111111111111" }) +
      frame("stream_token", { token: "1. Bold " }) +
      frame("stream_token", { token: "red" }) +
      frame("done", {
        run_id: "11111111-1111-4111-8111-111111111111",
        status: "completed",
        output: "1. Bold red",
        attachments: [{ id: "att1", name: "one.png", mime: "image/png", bytes: 10 }, { nope: true }],
      });
    // Split mid-frame to exercise buffering.
    const out = await drain(tapEventStream(streamOf([body.slice(0, 40), body.slice(40)]), recorder));
    expect(out).toBe(body);
    expect(saved).toEqual([
      {
        runId: "11111111-1111-4111-8111-111111111111",
        status: "completed",
        content: "1. Bold red",
        attachments: [{ id: "att1", name: "one.png", mime: "image/png" }],
        error: null,
      },
    ]);
  });

  it("stores a failed run with the last attempt's error", async () => {
    const saved: RunOutcome[] = [];
    const recorder = createRunRecorder((o) => void saved.push(o));
    await drain(
      tapEventStream(
        streamOf([
          frame("init", { run_id: "r" }),
          frame("done", { status: "failed", output: "bad", attempts: [{ error: "first" }, { error: "Blocked by policy" }] }),
        ]),
        recorder,
      ),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ runId: "r", status: "failed", error: "Blocked by policy", content: "" });
  });

  it("stores an error event once, even when the stream then ends", async () => {
    const saved: RunOutcome[] = [];
    const recorder = createRunRecorder((o) => void saved.push(o));
    await drain(
      tapEventStream(
        streamOf([frame("init", { run_id: "r" }), frame("stream_token", { token: "partial" }), frame("error", { error: "lost" })]),
        recorder,
      ),
    );
    expect(saved).toEqual([{ runId: "r", status: "failed", content: "partial", attachments: [], error: "lost" }]);
  });

  it("stores a failure when the stream ends without a result", async () => {
    const saved: RunOutcome[] = [];
    await drain(tapEventStream(streamOf([frame("init", { run_id: "r" })]), createRunRecorder((o) => void saved.push(o))));
    expect(saved[0]).toMatchObject({ status: "failed", error: "The stream ended without a result." });
  });

  it("stores `cancelled` when the browser cancels", async () => {
    const saved: RunOutcome[] = [];
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(frame("init", { run_id: "r" })));
      },
      cancel() {
        cancelled = true;
      },
    });
    const tapped = tapEventStream(source, createRunRecorder((o) => void saved.push(o)));
    const reader = tapped.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
    expect(saved).toEqual([{ runId: "r", status: "cancelled", content: "", attachments: [], error: null }]);
  });
});
