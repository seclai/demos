// Shapes shared by the server and the browser.

export type UploadKind = "headshot" | "style";

export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UploadInfo {
  id: string;
  filename: string;
  mime: string;
  kind: UploadKind;
  /** Our own copy of the file, served to the owner only. */
  url: string;
}

export interface StoredAttachment {
  id: string;
  name: string | null;
  mime: string;
}

export type MessageStatus = "completed" | "failed" | "cancelled";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  uploads: UploadInfo[];
  runId: string | null;
  status: MessageStatus | null;
  attachments: StoredAttachment[];
  error: string | null;
  createdAt: number;
}

export const API_BASE = "/api/seclai";

/** Same URL `@seclai/react` builds for a run attachment. */
export function attachmentUrl(runId: string, attachment: StoredAttachment): string {
  const params = new URLSearchParams({ runId, attachmentId: attachment.id });
  if (attachment.name) params.set("name", attachment.name);
  return `${API_BASE}/download?${params}`;
}

export function uploadUrl(id: string): string {
  return `/files/uploads/${encodeURIComponent(id)}`;
}
