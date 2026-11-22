// Which images the agent accepts per message (its `images` slot). The handlers
// cache the lookup and share it with the upload check, so a page load doesn't
// always call the API.

import { createLogger } from "./log.server";
import { getSeclai } from "./services.server";

const log = createLogger("agent");

export interface AcceptedSlot {
  max: number;
  contentTypes: string[];
}

const FALLBACK: AcceptedSlot = { max: 3, contentTypes: ["image/jpeg", "image/png", "image/webp"] };

export async function getAcceptedSlot(): Promise<AcceptedSlot> {
  try {
    const first = (await getSeclai().attachmentReferences()).accepted_attachments?.[0];
    return {
      max: first?.max ?? FALLBACK.max,
      contentTypes: first?.content_types?.length ? first.content_types : FALLBACK.contentTypes,
    };
  } catch (err) {
    log.warn("couldn't read the agent's accepted attachments; assuming 3 images", {
      error: err instanceof Error ? err.message : String(err),
    });
    return FALLBACK;
  }
}
