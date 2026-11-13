import type { SeclaiHandlers } from "@seclai/handlers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../app/lib/db.server";
import { buildAgentInput, createSeclaiRoute } from "../app/lib/seclai-route.server";
import { createStore, makeTitle, type Store } from "../app/lib/store.server";

const RUN_ID = "22222222-2222-4222-8222-222222222222";
const sse = (s: string) =>
  new Response(s, { headers: { "content-type": "text/event-stream; charset=utf-8" } });

function fakeSeclai(overrides: Partial<SeclaiHandlers> = {}): SeclaiHandlers & { runBodies: unknown[] } {
  const runBodies: unknown[] = [];
  return {
    runBodies,
    attachmentReferences: vi.fn(async () => Response.json({ accepted_attachments: [] })),
    upload: vi.fn(async () => Response.json({ id: "up" })),
    run: vi.fn(async (req: Request) => {
      runBodies.push(await req.json());
      return sse(
        `event: init\ndata: {"run_id":"${RUN_ID}"}\n\n` +
          `event: done\ndata: {"run_id":"${RUN_ID}","status":"completed","output":"1. Neon","attachments":[{"id":"a1","name":"n.png","mime":"image/png"}]}\n\n`,
      );
    }),
    download: vi.fn(async () => new Response("png-bytes", { headers: { "content-type": "image/png" } })),
    handle: vi.fn(async () => new Response(null, { status: 404 })),
    ...overrides,
  };
}

const post = (body: unknown) =>
  new Request("http://x/api/seclai/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

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

describe("seclai route ownership", () => {
  let store: Store;
  let seclai: ReturnType<typeof fakeSeclai>;
  let handle: ReturnType<typeof createSeclaiRoute>;
  let sessionId: string;

  beforeEach(() => {
    store = createStore(openDatabase(":memory:"));
    seclai = fakeSeclai();
    handle = createSeclaiRoute({ store, seclai });
    sessionId = store.createSession("alice").id;
    store.addUpload({ id: "u1", sessionId, filename: "me.jpg", mime: "image/jpeg", kind: "headshot", path: "/p" });
    store.addUpload({ id: "u2", sessionId, filename: "style.png", mime: "image/png", kind: "style", path: "/p2" });
  });

  it("runs the owner's session, labels uploads, and stores both turns", async () => {
    const res = await handle(post({ input: "Title: 30 days", uploadIds: ["u1", "u2"], sessionId }), "alice", "run");
    expect(res.status).toBe(200);
    await res.text();
    expect(seclai.runBodies[0]).toEqual({
      input: buildAgentInput("Title: 30 days", store.sessionUploads(sessionId, ["u1", "u2"])),
      uploadIds: ["u1", "u2"],
      sessionId,
    });
    expect((seclai.runBodies[0] as { input: string }).input).toContain('"me.jpg" is my photo');
    const msgs = store.listMessages(sessionId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0]).toMatchObject({ content: "Title: 30 days" });
    expect(msgs[0].uploads.map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(msgs[1]).toMatchObject({ runId: RUN_ID, status: "completed", content: "1. Neon" });
    expect(msgs[1].attachments).toEqual([{ id: "a1", name: "n.png", mime: "image/png" }]);
  });

  it("refuses another owner's session", async () => {
    const res = await handle(post({ input: "hi", sessionId }), "bob", "run");
    expect(res.status).toBe(404);
    expect(seclai.run).not.toHaveBeenCalled();
  });

  it("refuses uploads from another session", async () => {
    const other = store.createSession("alice").id;
    const res = await handle(post({ input: "hi", uploadIds: ["u1"], sessionId: other }), "alice", "run");
    expect(res.status).toBe(404);
    expect(seclai.run).not.toHaveBeenCalled();
  });

  it("stores nothing when the API rejects the run up front", async () => {
    seclai = fakeSeclai({ run: vi.fn(async () => Response.json({ error: "No credits", status: 402 }, { status: 402 })) });
    handle = createSeclaiRoute({ store, seclai });
    const res = await handle(post({ input: "hi", sessionId }), "alice", "run");
    expect(res.status).toBe(402);
    expect(store.listMessages(sessionId)).toEqual([]);
  });

  it("only downloads images from the owner's runs", async () => {
    await (await handle(post({ input: "hi", sessionId }), "alice", "run")).text();
    const url = `http://x/api/seclai/download?runId=${RUN_ID}&attachmentId=a1`;
    expect((await handle(new Request(url), "alice", "download")).status).toBe(200);
    expect((await handle(new Request(url), "bob", "download")).status).toBe(404);
    expect(seclai.download).toHaveBeenCalledTimes(1);
  });

  it("doesn't expose the raw upload handler", async () => {
    const res = await handle(new Request("http://x/api/seclai/upload", { method: "POST" }), "alice", "upload");
    expect(res.status).toBe(404);
    expect(seclai.upload).not.toHaveBeenCalled();
  });
});
