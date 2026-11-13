import { describe, expect, it } from "vitest";

import { askedCount, countListedImages, expectedImageCount } from "../app/lib/expected-images";

describe("expectedImageCount", () => {
  it("defaults to 4 on the first turn", () => {
    expect(expectedImageCount({ input: "Title: I tried X", streamedText: "", previousCount: null })).toBe(4);
  });

  it("follows the previous reply's count for refinements", () => {
    expect(
      expectedImageCount({ input: "I prefer the stopwatch icon over the lightning bolt", streamedText: "", previousCount: 1 }),
    ).toBe(1);
  });

  it("uses a count the user asked for", () => {
    expect(expectedImageCount({ input: "give me 2 more versions", streamedText: "", previousCount: 1 })).toBe(2);
    expect(expectedImageCount({ input: "Try three different options", streamedText: "", previousCount: 1 })).toBe(3);
    expect(expectedImageCount({ input: "just a single image please", streamedText: "", previousCount: 4 })).toBe(1);
  });

  it("prefers the numbered list once it streams", () => {
    const text = "Here you go:\n\n1. Stopwatch instead of the bolt\n2. Same, darker background";
    expect(expectedImageCount({ input: "anything", streamedText: text, previousCount: 1 })).toBe(2);
  });

  it("caps at the agent's limit of 6", () => {
    expect(askedCount("make 12 variants")).toBe(6);
  });

  it("ignores numbers that aren't counts", () => {
    expect(askedCount("Title: I built a generator in 15 minutes")).toBeNull();
    expect(askedCount("I like image 3 best")).toBeNull();
    expect(countListedImages("Version 2 is better")).toBe(0);
  });
});
