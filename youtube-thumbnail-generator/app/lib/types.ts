// Shapes shared by the server and the browser.

import { createEndpoints } from "@seclai/react";

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

/** The `@seclai/handlers` routes, as `useAgentRun` builds them. */
export const endpoints = createEndpoints({ basePath: API_BASE });

/** A stored run attachment, through the download handler. */
export function attachmentUrl(runId: string, attachment: StoredAttachment): string {
  return endpoints.download(runId, attachment.id, attachment.name);
}

export function uploadUrl(id: string): string {
  return `/files/uploads/${encodeURIComponent(id)}`;
}
