// App-specific layer for the Listing Moderator: the shape of the
// moderation result the agent returns, tolerant parsing of its output, and the
// final verdict — which we COMPUTE in code from the violations rather than
// trusting whatever decision the model writes.
//
// The moderator system prompt lives on the agent itself (`system_template` of
// the `prompt_call` step) — NOT here. Sending it as runtime `input` trips
// Seclai's prompt-injection scanner ("You are a moderator… weapons, drugs…"
// looks like a jailbreak to the ML classifier). We only send the optional
// seller caption at runtime; the image goes via attachments.
//
// Kept separate from ./seclai.ts so the generic SDK wrapper stays reusable.

import { getConfig, runAgent, streamAgent, getAgentModel } from './seclai';

type Platform = { env?: Record<string, unknown> } | undefined;

export type Decision = 'pass' | 'fail';
export type Severity = 'high' | 'medium' | 'low';

export interface Violation {
  rule: string;
  severity: Severity;
  explanation: string;
}

export interface ModerationResult {
  is_listing_photo: boolean;        // false if the image isn't a usable product/listing photo
  not_photo_reason: string | null;  // brief reason when is_listing_photo is false; null otherwise
  decision: Decision;               // computed in code from violations (see decide())
  violations: Violation[];
  quality_score: number;            // 0–1
  confidence: number;               // 0–1
}

/**
 * The moderator system prompt. This is NOT sent at runtime — it lives on the
 * agent's `prompt_call` step as `system_template` (see
 * `agents/marketplace-listing-moderator.*.json` for the importable definition).
 * Kept here only as a source of truth so the repo documents what the agent
 * should be configured to do. See README → "Customizing the agent".
 */
export const MODERATOR_SYSTEM_PROMPT = `You are a STRICT content moderator for an online marketplace. Examine the attached listing photo (and the optional seller caption that may accompany it) and judge it against marketplace listing policies. Respond with ONLY a single JSON object — no prose, no markdown fences.

Check for policy violations. Every issue below is blocking — there are no advisory-only notes. Report each issue you find as a violation whose "rule" is EXACTLY one of these ids:
- "prohibited_item" — prohibited or restricted items (weapons, drugs, recalled goods, counterfeits, adult content)
- "unsafe_or_graphic" — unsafe or graphic content (gore, violence, hazardous materials)
- "contact_info_in_image" — contact info shown in the photo (phone numbers, emails, URLs, handles)
- "third_party_watermark" — third-party or retailer watermarks (logos from other marketplaces or stock sites)
- "misleading_or_stock" — stock / misleading imagery (a product render or web-pulled image used as the actual item; a photo that doesn't match the caption)
- "low_quality_photo" — poor image quality (bad lighting, focus, or framing)
- "possibly_ai_generated" — the image appears AI-generated or digitally fabricated rather than a real photo

Schema:
{
  "is_listing_photo": boolean,        // true if this is a usable product/listing photo; false for memes, screenshots, people-only selfies, random unrelated images
  "not_photo_reason": string|null,    // short description of what you see when is_listing_photo is false; null when true
  "violations": [                      // concrete policy violations; [] if none
    {
      "rule": string,                  // EXACTLY one of the ids listed above
      "severity": "high"|"medium"|"low",
      "explanation": string            // one concise sentence
    }
  ],
  "quality_score": number,            // 0..1 — overall listing photo quality (lighting, focus, framing)
  "confidence": number                // 0..1 — your confidence in this assessment
}

Severity guidance: "high" = clearly prohibited / must not be published; "medium" = likely problem needing human review; "low" = minor issue. Be strict — a poor-quality or likely AI-generated/fabricated image IS a violation, not something to overlook. Do NOT include a top-level decision field — that is computed downstream. If the image is not a listing photo, set is_listing_photo=false, fill not_photo_reason, set violations=[], quality_score=0, and confidence to how sure you are it isn't a listing photo.`;

/** Tolerantly pull a JSON object out of the agent's text output. Models
 *  sometimes wrap it in prose or ```json fences. */
export function parseAgentJson(raw: string): unknown {
  const fence = raw.trim().match(/```(?:json)?\s*([\s\S]*?)```/i);
  const c = fence ? fence[1] : raw.trim();
  try { return JSON.parse(c); } catch {
    const s = c.indexOf('{'), e = c.lastIndexOf('}');
    if (s !== -1 && e > s) return JSON.parse(c.slice(s, e + 1));
    throw new Error('Could not parse JSON from the agent response.');
  }
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function toSeverity(v: unknown): Severity {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'high' || s === 'medium' || s === 'low' ? s : 'low';
}

/** The verdict is derived deterministically from the violations, not taken
 *  from the model — so thresholds are tunable here without re-prompting. */
export function decide(violations: Violation[]): Decision {
  // Binary outcome: any violation (of any severity) fails the listing.
  return violations.length > 0 ? 'fail' : 'pass';
}

/** Normalize the loosely-typed agent JSON into a strict ModerationResult. */
export function normalizeResult(data: unknown): ModerationResult {
  const r = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;

  const rawViolations = Array.isArray(r.violations) ? r.violations : [];
  const violations: Violation[] = rawViolations.map((it) => {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    return {
      rule: str(o.rule) ?? 'unspecified',
      severity: toSeverity(o.severity),
      explanation: str(o.explanation) ?? '',
    };
  });

  const is_listing_photo = r.is_listing_photo !== false; // default true if model omits it
  const not_photo_reason = str(r.not_photo_reason);

  // "Not a listing photo" is itself a failure — the model short-circuits before
  // checking policy rules, so surface it as a violation so it fails like anything else.
  if (!is_listing_photo) {
    violations.unshift({
      rule: 'not_a_listing_photo',
      severity: 'high',
      explanation: not_photo_reason ?? 'This image is not a usable product or listing photo.',
    });
  }

  return {
    is_listing_photo,
    not_photo_reason,
    decision: decide(violations),
    violations,
    quality_score: clamp01(r.quality_score),
    confidence: clamp01(r.confidence),
  };
}

// Only the caption is sent as `input`. The moderator prompt lives in the
// agent's `system_template`; sending it at runtime trips the prompt scanner.
const captionInput = (caption: string) => (caption.trim() ? `Seller caption: ${caption.trim()}` : '');

/** Run a listing photo (and optional caption) through the agent. */
export async function moderateListing(
  file: { bytes: Uint8Array; fileName: string; contentType: string },
  caption: string,
  platform?: Platform,
): Promise<ModerationResult> {
  const cfg = getConfig(platform);
  const raw = await runAgent(cfg, captionInput(caption), [file]);
  return normalizeResult(parseAgentJson(raw));
}

/** Streaming variant: yields token text as it arrives, then the parsed result. */
export type ModerationStreamEvent =
  | { type: 'token'; token: string }
  | { type: 'progress'; step: string; message: string }
  | { type: 'result'; result: ModerationResult; model: string | null }
  | { type: 'error'; message: string };

export async function* moderateListingStream(
  file: { bytes: Uint8Array; fileName: string; contentType: string },
  caption: string,
  platform?: Platform,
): AsyncGenerator<ModerationStreamEvent> {
  const cfg = getConfig(platform);
  let full = '';
  for await (const ev of streamAgent(cfg, captionInput(caption), [file])) {
    if (ev.type === 'token') { full += ev.token; yield { type: 'token', token: ev.token }; }
    else if (ev.type === 'progress') yield ev;
    else if (ev.type === 'error') { yield { type: 'error', message: ev.message }; return; }
    else if (ev.type === 'done') {
      const output = ev.output || full;
      if (!output.trim()) { yield { type: 'error', message: 'Run completed but produced no output.' }; return; }
      const model = await getAgentModel(cfg);
      yield { type: 'result', result: normalizeResult(parseAgentJson(output)), model };
    }
  }
}
