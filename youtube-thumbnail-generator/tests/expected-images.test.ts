import { describe, expect, it } from "vitest";

import { askedCount, countListedImages, expectedImageCount, isPlainUndo } from "../app/lib/expected-images";

describe("expectedImageCount", () => {
  it("defaults to 4 on the first turn", () => {
    expect(expectedImageCount({ input: "Title: I tried X", streamedText: "", hasImages: false, hasUploads: true })).toBe(4);
    expect(expectedImageCount({ input: "Title: I tried X", streamedText: "", hasImages: false, hasUploads: false })).toBe(4);
  });

  it("expects one image for a change after a round of 4", () => {
    expect(
      expectedImageCount({ input: "I prefer the stopwatch icon over the lightning bolt", streamedText: "", hasImages: true, hasUploads: false }),
    ).toBe(1);
  });

  it("expects 4 again when a later message brings new uploads", () => {
    expect(expectedImageCount({ input: "Now try this style", streamedText: "", hasImages: true, hasUploads: true })).toBe(4);
  });

  it("uses a count the user asked for", () => {
    expect(expectedImageCount({ input: "give me 2 more versions", streamedText: "", hasImages: true, hasUploads: false })).toBe(2);
    expect(expectedImageCount({ input: "Try three different options", streamedText: "", hasImages: true, hasUploads: false })).toBe(3);
    expect(expectedImageCount({ input: "just a single image please", streamedText: "", hasImages: true, hasUploads: false })).toBe(1);
  });

  it("prefers the numbered list once it streams", () => {
    const text = "Here you go:\n\n1. Stopwatch instead of the bolt\n2. Same, darker background";
    expect(expectedImageCount({ input: "anything", streamedText: text, hasImages: true, hasUploads: false })).toBe(2);
  });

  it("caps at the agent's limit of 6", () => {
    expect(askedCount("make 12 variants")).toBe(6);
  });

  it("ignores numbers that aren't counts", () => {
    expect(askedCount("Title: I built a generator in 15 minutes")).toBeNull();
    expect(askedCount("I like image 3 best")).toBeNull();
    expect(countListedImages("Version 2 is better")).toBe(0);
  });

  it("expects no image for a plain undo", () => {
    expect(expectedImageCount({ input: "undo that", streamedText: "", hasImages: true, hasUploads: false })).toBe(0);
    expect(expectedImageCount({ input: "Go back to the previous version.", streamedText: "", hasImages: true, hasUploads: false })).toBe(0);
  });

  it("still expects images when an undo comes with a change", () => {
    expect(isPlainUndo("undo that and make the title yellow")).toBe(false);
    expect(isPlainUndo("I like image 2, undo the rest")).toBe(false);
    expect(expectedImageCount({ input: "revert, but keep the red title", streamedText: "", hasImages: true, hasUploads: false })).toBe(1);
  });
});
