// Session-scoped uploads: keep our own copy (to show in the chat) and hand the
// file to Seclai through the handlers' `upload`.

import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import type { SeclaiHandlers } from "@seclai/handlers";

import { createLogger, short, since } from "./log.server";
import type { Store } from "./store.server";
import type { UploadKind } from "./types";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

function jsonError(status: number, error: string): Response {
  return Response.json({ error, status }, { status });
}

export function createUploadRoute({
  store,
  seclai,
  dataDir,
}: {
  store: Store;
  seclai: SeclaiHandlers;
  dataDir: string;
}) {
  const dir = path.join(dataDir, "uploads");
  const log = createLogger("upload");

  async function upload(request: Request, ownerId: string, sessionId: string): Promise<Response> {
    if (request.method !== "POST") return jsonError(405, "Method not allowed.");
    if (!store.getSession(ownerId, sessionId)) return jsonError(404, "Session not found.");

    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_UPLOAD_BYTES + 64 * 1024) return jsonError(413, "Images must be 10 MB or smaller.");

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonError(400, "The request body must be multipart form data.");
    }
    const file = form.get("file");
    const kind = form.get("kind");
    if (!(file instanceof File)) return jsonError(400, "The form must include a `file`.");
    if (kind !== "headshot" && kind !== "style") return jsonError(400, "`kind` must be `headshot` or `style`.");
    const ext = ACCEPTED_TYPES[file.type];
    if (!ext) return jsonError(415, "Use a JPEG, PNG or WebP image.");
    if (file.size > MAX_UPLOAD_BYTES) return jsonError(413, "Images must be 10 MB or smaller.");

    const start = performance.now();
    const fields = { session: short(sessionId), kind, file: file.name, type: file.type, kb: Math.round(file.size / 1024) };
    log.info("received", fields);

    const forward = new FormData();
    forward.set("file", file, file.name);
    const upstream = await seclai.upload(
      new Request(request.url, { method: "POST", body: forward, signal: request.signal }),
    );
    if (!upstream.ok) {
      const body = (await upstream.clone().json().catch(() => ({}))) as { error?: string };
      log.error("Seclai rejected the upload", { ...fields, status: upstream.status, error: body.error, t: since(start) });
      return upstream;
    }
    const { id, status } = (await upstream.json()) as { id: string; status?: string };
    log.info("uploaded to Seclai", { ...fields, upload: short(id), status, t: since(start) });

    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${crypto.randomUUID()}${ext}`);
    await writeFile(filePath, Buffer.from(await file.arrayBuffer()));

    const info = store.addUpload({
      id,
      sessionId,
      filename: file.name || `image${ext}`,
      mime: file.type,
      kind: kind as UploadKind,
      path: filePath,
    });
    return Response.json(info);
  }

  async function serve(ownerId: string, uploadId: string): Promise<Response> {
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

  return { upload, serve, removeFiles };
}
