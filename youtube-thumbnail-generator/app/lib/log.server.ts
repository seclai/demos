// Minimal server logger: one line per event, `key=value` fields, no deps.
//
//   2026-11-13T10:30:51.123Z INFO  [run 1a2b3c4d] first token  after=14.2s
//
// LOG_LEVEL picks the threshold: debug | info (default) | warn | error | silent.
// `debug` adds every stream event, including each token and keepalive.

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function threshold(): number {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return ORDER[env as Level] ?? ORDER.info;
}

export type Fields = Record<string, unknown>;

function format(value: unknown): string {
  if (typeof value === "string") {
    return /^[\w./:@-]*$/.test(value) && value !== "" ? value : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) return String(value);
  return JSON.stringify(value);
}

function write(level: Level, scope: string, message: string, fields?: Fields) {
  if (ORDER[level] < threshold()) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), `[${scope}]`, message];
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v !== undefined) parts.push(`${k}=${format(v)}`);
  }
  const line = parts.join(" ");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(scope: string): Logger;
  readonly debugEnabled: boolean;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => write("debug", scope, m, f),
    info: (m, f) => write("info", scope, m, f),
    warn: (m, f) => write("warn", scope, m, f),
    error: (m, f) => write("error", scope, m, f),
    child: (sub) => createLogger(`${scope} ${sub}`),
    get debugEnabled() {
      return ORDER.debug >= threshold();
    },
  };
}

/** Seconds since `start`, as `12.3s`. */
export function since(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

/** The first 8 characters of an id, enough to tell runs apart in the log. */
export function short(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "-";
}

export function preview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
