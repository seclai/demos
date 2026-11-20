// SQLite storage through Node's built-in `node:sqlite` (no native addon).
//
// Three tables: design sessions, the photos uploaded into them, and the chat
// turns. Generated images aren't stored here, only their run and attachment
// ids: the bytes stay with the run on Seclai and are fetched through the
// download handler.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getConfig } from "./config.server";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  title      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('headshot', 'style')),
  path       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_session ON uploads(session_id);

CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL DEFAULT '',
  upload_ids_json  TEXT NOT NULL DEFAULT '[]',
  run_id           TEXT,
  status           TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  error            TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id);
`;

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

let instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (instance) return instance;
  const { dataDir } = getConfig();
  mkdirSync(dataDir, { recursive: true });
  instance = openDatabase(path.join(dataDir, "thumbnails.sqlite"));
  return instance;
}
