// How many placeholder cards to show while a run is generating images. The
// stream doesn't say how many images are coming, so this is a best guess:
//
// 1. The reply itself: the agent lists the images it made in a numbered list,
//    so once that list starts streaming, its length is the best estimate.
// 2. A count the user asked for: "give me 2 versions", "three more options".
// 3. The previous reply's image count: refining one image usually returns one.
// 4. The agent's default for a fresh design: 4.

export const DEFAULT_VARIANTS = 4;
/** The agent's per-reply cap on image generations. */
export const MAX_VARIANTS = 6;

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1, single: 1 };
const NOUNS = "variants?|versions?|options?|images?|thumbnails?|designs?|takes?|alternatives?|variations?|concepts?|ideas?";
const ASKED = new RegExp(
  `\\b(\\d+|one|two|three|four|five|six|a|an|single)\\s+(?:more\\s+|new\\s+|different\\s+|other\\s+)?(?:${NOUNS})\\b`,
  "i",
);

function clamp(n: number): number {
  return Math.min(Math.max(n, 1), MAX_VARIANTS);
}

/** Items in the numbered list streamed so far, or 0. */
export function countListedImages(text: string): number {
  return text.split("\n").filter((line) => /^\s*\d+[.)]\s+\S/.test(line)).length;
}

/** A count the user asked for in their message, if any. */
export function askedCount(input: string): number | null {
  const m = ASKED.exec(input);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const n = /^\d+$/.test(raw) ? Number(raw) : WORDS[raw];
  return n ? clamp(n) : null;
}

export function expectedImageCount({
  input,
  streamedText,
  previousCount,
}: {
  input: string;
  streamedText: string;
  /** Images in the last reply that had any; null for the first turn. */
  previousCount: number | null;
}): number {
  const listed = countListedImages(streamedText);
  if (listed > 0) return clamp(listed);
  return askedCount(input) ?? (previousCount ? clamp(previousCount) : DEFAULT_VARIANTS);
}
