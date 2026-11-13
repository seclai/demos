// Which images the agent accepts per message (its `images` slot), cached so a
// page load doesn't always call the API.

import { createLogger } from "./log.server";
import { getSeclai } from "./services.server";

const log = createLogger("agent");

export interface AcceptedSlot {
  max: number;
  contentTypes: string[];
}

const FALLBACK: AcceptedSlot = { max: 3, contentTypes: ["image/jpeg", "image/png", "image/webp"] };
const TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;

let cached: { until: number; slot: AcceptedSlot } | null = null;

function remember(slot: AcceptedSlot, ttl: number): AcceptedSlot {
  cached = { until: Date.now() + ttl, slot };
  return slot;
}

export async function getAcceptedSlot(): Promise<AcceptedSlot> {
  if (cached && Date.now() < cached.until) return cached.slot;
  try {
    const res = await getSeclai().attachmentReferences(
      new Request("http://local/api/seclai/attachment-references"),
    );
    if (!res.ok) {
      log.warn("couldn't read the agent's accepted attachments; assuming 3 images", { status: res.status });
      return remember(FALLBACK, FAILURE_TTL_MS);
    }
    const refs = (await res.json()) as {
      accepted_attachments?: Array<{ max?: number | null; content_types?: string[] }>;
    };
    const first = refs.accepted_attachments?.[0];
    const slot: AcceptedSlot = {
      max: first?.max ?? FALLBACK.max,
      contentTypes: first?.content_types?.length ? first.content_types : FALLBACK.contentTypes,
    };
    if (!cached || cached.slot.max !== slot.max) log.info("accepts images", { max: slot.max, types: slot.contentTypes.join(",") });
    return remember(slot, TTL_MS);
  } catch (err) {
    log.warn("couldn't reach the Seclai API for accepted attachments", { error: err instanceof Error ? err.message : String(err) });
    return remember(FALLBACK, FAILURE_TTL_MS);
  }
}
