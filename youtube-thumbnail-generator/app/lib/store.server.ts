// Queries over the SQLite tables. Every read that takes an owner id scopes to
// it, so one browser can never see another's sessions, uploads or images.

import type { DatabaseSync } from "node:sqlite";

import {
  type ChatMessage,
  type MessageStatus,
  type SessionSummary,
  type StoredAttachment,
  type UploadInfo,
  type UploadKind,
  uploadUrl,
} from "./types";

type Row = Record<string, unknown>;

const TITLE_LENGTH = 60;

function toSession(row: Row): SessionSummary {
  return {
    id: String(row.id),
    title: (row.title as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toUpload(row: Row): UploadInfo {
  const id = String(row.id);
  return {
    id,
    filename: String(row.filename),
    mime: String(row.mime),
    kind: row.kind as UploadKind,
    url: uploadUrl(id),
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function makeTitle(input: string): string | null {
  const flat = input.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : flat;
}

export function createStore(db: DatabaseSync) {
  const now = () => Date.now();

  return {
    listSessions(ownerId: string): SessionSummary[] {
      return db
        .prepare("SELECT * FROM sessions WHERE owner_id = ? ORDER BY updated_at DESC")
        .all(ownerId)
        .map(toSession);
    },

    createSession(ownerId: string): SessionSummary {
      const id = crypto.randomUUID();
      const t = now();
      db.prepare(
        "INSERT INTO sessions (id, owner_id, title, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)",
      ).run(id, ownerId, t, t);
      return { id, title: null, createdAt: t, updatedAt: t };
    },

    getSession(ownerId: string, sessionId: string): SessionSummary | null {
      const row = db
        .prepare("SELECT * FROM sessions WHERE id = ? AND owner_id = ?")
        .get(sessionId, ownerId);
      return row ? toSession(row) : null;
    },

    renameSession(ownerId: string, sessionId: string, title: string): boolean {
      const clean = makeTitle(title);
      const res = db
        .prepare("UPDATE sessions SET title = ? WHERE id = ? AND owner_id = ?")
        .run(clean, sessionId, ownerId);
      return res.changes > 0;
    },

    /** Deletes the session and returns the paths of its uploaded files, for the caller to remove. */
    deleteSession(ownerId: string, sessionId: string): string[] | null {
      if (!this.getSession(ownerId, sessionId)) return null;
      const paths = db
        .prepare("SELECT path FROM uploads WHERE session_id = ?")
        .all(sessionId)
        .map((r) => String(r.path));
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      return paths;
    },

    touchSession(sessionId: string) {
      db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), sessionId);
    },

    /** Titles an untitled session after its first message. */
    titleIfEmpty(sessionId: string, input: string) {
      const title = makeTitle(input);
      if (!title) return;
      db.prepare("UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL").run(title, sessionId);
    },

    addUpload(u: {
      id: string;
      sessionId: string;
      filename: string;
      mime: string;
      kind: UploadKind;
      path: string;
    }): UploadInfo {
      db.prepare(
        "INSERT INTO uploads (id, session_id, filename, mime, kind, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(u.id, u.sessionId, u.filename, u.mime, u.kind, u.path, now());
      return toUpload({ ...u });
    },

    /** An upload with its file path, if the owner has it in one of their sessions. */
    getOwnedUpload(ownerId: string, uploadId: string): (UploadInfo & { path: string }) | null {
      const row = db
        .prepare(
          `SELECT u.* FROM uploads u JOIN sessions s ON s.id = u.session_id
           WHERE u.id = ? AND s.owner_id = ?`,
        )
        .get(uploadId, ownerId);
      return row ? { ...toUpload(row), path: String(row.path) } : null;
    },

    /** The session's uploads with these ids, in the order given. Unknown ids are dropped. */
    sessionUploads(sessionId: string, ids: string[]): UploadInfo[] {
      if (ids.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT * FROM uploads WHERE session_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(sessionId, ...ids)
        .map(toUpload);
      const byId = new Map(rows.map((u) => [u.id, u]));
      return ids.flatMap((id) => byId.get(id) ?? []);
    },

    listMessages(sessionId: string): ChatMessage[] {
      const rows = db
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
        .all(sessionId);
      const uploads = new Map(
        db
          .prepare("SELECT * FROM uploads WHERE session_id = ?")
          .all(sessionId)
          .map((r) => [String(r.id), toUpload(r)] as const),
      );
      return rows.map((row) => ({
        id: Number(row.id),
        role: row.role as ChatMessage["role"],
        content: String(row.content ?? ""),
        uploads: parseJson<string[]>(row.upload_ids_json, []).flatMap((id) => uploads.get(id) ?? []),
        runId: (row.run_id as string | null) ?? null,
        status: (row.status as MessageStatus | null) ?? null,
        attachments: parseJson<StoredAttachment[]>(row.attachments_json, []),
        error: (row.error as string | null) ?? null,
        createdAt: Number(row.created_at),
      }));
    },

    addUserMessage(sessionId: string, content: string, uploadIds: string[]) {
      db.prepare(
        "INSERT INTO messages (session_id, role, content, upload_ids_json, created_at) VALUES (?, 'user', ?, ?, ?)",
      ).run(sessionId, content, JSON.stringify(uploadIds), now());
      this.titleIfEmpty(sessionId, content);
      this.touchSession(sessionId);
    },

    addAssistantMessage(
      sessionId: string,
      m: {
        runId: string | null;
        status: MessageStatus;
        content: string;
        attachments: StoredAttachment[];
        error: string | null;
      },
    ) {
      db.prepare(
        `INSERT INTO messages (session_id, role, content, run_id, status, attachments_json, error, created_at)
         VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        m.content,
        m.runId,
        m.status,
        JSON.stringify(m.attachments),
        m.error,
        now(),
      );
      this.touchSession(sessionId);
    },

    /** Whether this run's reply is stored in one of the owner's sessions. */
    ownsRun(ownerId: string, runId: string): boolean {
      return !!db
        .prepare(
          `SELECT 1 FROM messages m JOIN sessions s ON s.id = m.session_id
           WHERE m.run_id = ? AND s.owner_id = ? LIMIT 1`,
        )
        .get(runId, ownerId);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
