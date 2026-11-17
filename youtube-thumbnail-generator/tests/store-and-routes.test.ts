import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentRunEvent } from "@seclai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../app/lib/db.server";
import { buildAgentInput, createAppSeclai } from "../app/lib/seclai.server";
import { createStore, makeTitle, type Store } from "../app/lib/store.server";

// The Seclai API, as the handlers' SDK client sees it.
const api = vi.hoisted(() => ({
  runStreamingAgent: vi.fn(),
  uploadAgentInput: vi.fn(),
  downloadAgentRunAttachment: vi.fn(),
  getAgentAttachmentReferences: vi.fn(),
}));

vi.mock("@seclai/sdk", async (importActual) => {
  const actual = await importActual<typeof import("@seclai/sdk")>();
  class Seclai {
    runStreamingAgent = api.runStreamingAgent;
    uploadAgentInput = api.uploadAgentInput;
    downloadAgentRunAttachment = api.downloadAgentRunAttachment;
    getAgentAttachmentReferences = api.getAgentAttachmentReferences;
  }
  return { ...actual, Seclai };
});

const { SeclaiAPIStatusError } = await vi.importActual<typeof import("@seclai/sdk")>("@seclai/sdk");

const RUN_ID = "22222222-2222-4222-8222-222222222222";
const BASE = "http://x/api/seclai";

async function* eventsOf(...events: AgentRunEvent[]) {
  for (const e of events) yield e;
}

const DONE = {
  event: "done",
  data: { run_id: RUN_ID, status: "completed", output: "1. Neon", attachments: [{ id: "a1", name: "n.png", mime: "image/png" }] },
};

const post = (body: unknown, init: RequestInit = {}) =>
  new Request(`${BASE}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

function uploadRequest(query: Record<string, string>, file: File) {
  const form = new FormData();
  form.set("file", file);
  return new Request(`${BASE}/upload?${new URLSearchParams(query)}`, { method: "POST", body: form });
}

describe("store", () => {
  let store: Store;
  beforeEach(() => {
    store = createStore(openDatabase(":memory:"));
  });

  it("scopes sessions to their owner", () => {
    const s = store.createSession("alice");
    expect(store.getSession("alice", s.id)?.id).toBe(s.id);
    expect(store.getSession("bob", s.id)).toBeNull();
    expect(store.listSessions("bob")).toEqual([]);
    expect(store.renameSession("bob", s.id, "x")).toBe(false);
    expect(store.deleteSession("bob", s.id)).toBeNull();
  });

  it("titles a session from its first message only", () => {
    const s = store.createSession("alice");
    store.addUserMessage(s.id, "Make a thumbnail for my cooking video", []);
    store.addUserMessage(s.id, "Now make it red", []);
    expect(store.getSession("alice", s.id)?.title).toBe("Make a thumbnail for my cooking video");
  });

  it("deletes a session with its uploads and messages", () => {
    const s = store.createSession("alice");
    store.addUpload({ id: "u1", sessionId: s.id, filename: "me.jpg", mime: "image/jpeg", kind: "headshot", path: "/tmp/x.jpg" });
    store.addUserMessage(s.id, "hi", ["u1"]);
    expect(store.deleteSession("alice", s.id)).toEqual(["/tmp/x.jpg"]);
    expect(store.listMessages(s.id)).toEqual([]);
    expect(store.getOwnedUpload("alice", "u1")).toBeNull();
  });

  it("makes short titles", () => {
    expect(makeTitle("  a\n b ")).toBe("a b");
    expect(makeTitle("x".repeat(100))).toHaveLength(60);
    expect(makeTitle("   ")).toBeNull();
  });
});

describe("seclai routes", () => {
  let store: Store;
  let dataDir: string;
  let app: ReturnType<typeof createAppSeclai>;
  let sessionId: string;

  beforeEach(() => {
    vi.resetAllMocks();
    store = createStore(openDatabase(":memory:"));
    dataDir = mkdtempSync(path.join(tmpdir(), "thumbs-test-"));
    app = createAppSeclai({ store, apiKey: "k", agentId: "agent-1", dataDir });
    sessionId = store.createSession("alice").id;
    store.addUpload({ id: "u1", sessionId, filename: "me.jpg", mime: "image/jpeg", kind: "headshot", path: "/p" });
    store.addUpload({ id: "u2", sessionId, filename: "style.png", mime: "image/png", kind: "style", path: "/p2" });
    api.runStreamingAgent.mockImplementation(() => eventsOf({ event: "init", data: { run_id: RUN_ID } }, DONE));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("runs the owner's session, labels the uploads, and stores both turns", async () => {
    const res = await app.handle(post({ input: "Title: 30 days", uploadIds: ["u1", "u2"], sessionId }), "alice", "run");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("event: done");

    const [, body] = api.runStreamingAgent.mock.calls[0]!;
    expect(body.input).toBe(buildAgentInput("Title: 30 days", store.sessionUploads(sessionId, ["u1", "u2"])));
    expect(body.input).toContain('"me.jpg" is my photo');
    expect(body.input_upload_ids).toEqual(["u1", "u2"]);
    expect(body.metadata).toEqual({ session_id: sessionId });

    const msgs = store.listMessages(sessionId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0]).toMatchObject({ content: "Title: 30 days" });
    expect(msgs[1]).toMatchObject({ runId: RUN_ID, status: "completed", content: "1. Neon" });
    expect(msgs[1]!.attachments).toEqual([{ id: "a1", name: "n.png", mime: "image/png" }]);
  });

  it("refuses another owner's session, without calling the API or storing anything", async () => {
    const res = await app.handle(post({ input: "hi", sessionId }), "bob", "run");
    expect(res.status).toBe(404);
    expect(api.runStreamingAgent).not.toHaveBeenCalled();
    expect(store.listMessages(sessionId)).toEqual([]);
  });

  it("refuses uploads from another session", async () => {
    const other = store.createSession("alice").id;
    const res = await app.handle(post({ input: "hi", uploadIds: ["u1"], sessionId: other }), "alice", "run");
    expect(res.status).toBe(404);
    expect(api.runStreamingAgent).not.toHaveBeenCalled();
  });

  it("stores the turn and the error when the API refuses the run up front", async () => {
    api.runStreamingAgent.mockImplementation(async function* () {
      throw new SeclaiAPIStatusError({
        message: "Request failed",
        statusCode: 402,
        method: "POST",
        url: "https://api.seclai.com/x",
        responseText: JSON.stringify({ detail: "No credits" }),
      });
    });
    const res = await app.handle(post({ input: "hi", sessionId }), "alice", "run");
    expect(res.status).toBe(402);
    expect(store.listMessages(sessionId).map((m) => [m.role, m.status, m.error])).toEqual([
      ["user", null, null],
      ["assistant", "failed", "No credits"],
    ]);
  });

  it("stores the user's turn before the run connects", async () => {
    let seen = -1;
    api.runStreamingAgent.mockImplementation(() => {
      seen = store.listMessages(sessionId).length;
      return eventsOf(DONE);
    });
    await (await app.handle(post({ input: "hi", sessionId }), "alice", "run")).text();
    expect(seen).toBe(1);
  });

  it("still saves the reply when the browser left before the response was read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    api.runStreamingAgent.mockImplementation(async function* () {
      yield { event: "init", data: { run_id: RUN_ID } };
      await gate;
      yield { event: "stream_token", data: { token: "1. Late" } };
      yield { ...DONE, data: { ...DONE.data, output: "1. Late" } };
    });
    const browser = new AbortController();
    // The framework drops the response unread, as React Router does after an abort.
    await app.handle(post({ input: "hi", sessionId }, { signal: browser.signal }), "alice", "run");
    browser.abort();
    release();

    await vi.waitFor(() => expect(store.listMessages(sessionId)).toHaveLength(2));
    expect(store.listMessages(sessionId)[1]).toMatchObject({ status: "completed", content: "1. Late", runId: RUN_ID });
  });

  it("keeps the stream going when the reply can't be saved", async () => {
    const res = await app.handle(post({ input: "hi", sessionId }), "alice", "run");
    store.deleteSession("alice", sessionId);
    expect(await res.text()).toContain("event: done");
  });

  it("only downloads images from the owner's runs", async () => {
    await (await app.handle(post({ input: "hi", sessionId }), "alice", "run")).text();
    api.downloadAgentRunAttachment.mockImplementation(async () => new Response("png", { headers: { "content-type": "image/png" } }));
    const url = `${BASE}/download?runId=${RUN_ID}&attachmentId=a1`;
    expect((await app.handle(new Request(url), "alice", "download")).status).toBe(200);
    expect((await app.handle(new Request(url), "bob", "download")).status).toBe(404);
    expect(api.downloadAgentRunAttachment).toHaveBeenCalledTimes(1);
  });

  it("uploads into the owner's session, keeps a copy, and records the role", async () => {
    api.getAgentAttachmentReferences.mockResolvedValue({
      requires_uploads: false,
      accepted_attachments: [{ name: "images", content_types: ["image/jpeg", "image/png", "image/webp"], max: 3 }],
    });
    api.uploadAgentInput.mockResolvedValue({ id: "up-9", status: "ready", filename: "me.png", content_type: "image/png", file_size: 3 });

    const res = await app.handle(
      uploadRequest({ sessionId, kind: "headshot" }, new File(["png"], "me.png", { type: "image/png" })),
      "alice",
      "upload",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "up-9", filename: "me.png", mime: "image/png", kind: "headshot", url: "/files/uploads/up-9" });
    const stored = store.getOwnedUpload("alice", "up-9")!;
    expect(stored.kind).toBe("headshot");
    expect(readFileSync(stored.path, "utf8")).toBe("png");
  });

  it.each([
    ["another owner's session", "bob", { kind: "headshot" }, 404],
    ["a missing role", "alice", { kind: "" }, 400],
    ["an image we can't show back", "alice", { kind: "style", type: "image/heic" }, 415],
  ])("refuses an upload into %s, without uploading", async (_label, owner, opts, status) => {
    api.getAgentAttachmentReferences.mockResolvedValue({ requires_uploads: false, accepted_attachments: [{ name: "images" }] });
    const file = new File(["x"], "f.img", { type: (opts as { type?: string }).type ?? "image/png" });
    const res = await app.handle(uploadRequest({ sessionId, kind: opts.kind }, file), owner, "upload");
    expect(res.status).toBe(status);
    expect(api.uploadAgentInput).not.toHaveBeenCalled();
  });

  it("answers 404 for actions it doesn't serve", async () => {
    expect((await app.handle(new Request(`${BASE}/nope`), "alice", "nope")).status).toBe(404);
  });
});
