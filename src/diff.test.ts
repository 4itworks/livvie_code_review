import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

import { isLineInDiff, fetchDiff } from "./diff.js";
import * as core from "@actions/core";

// ---------------------------------------------------------------------------
// isLineInDiff
// ---------------------------------------------------------------------------
describe("isLineInDiff", () => {
  const patch = [
    "@@ -10,5 +10,7 @@",
    " context",
    "+added line 1",
    "+added line 2",
    " context",
    "@@ -20,3 +22,5 @@",
    " context",
    "+added line 3",
    " context",
  ].join("\n");

  // Hunk 1: @@ -10,5 +10,7 @@
  //   context at new line 10 → advance to 11
  //   + at 11 → added, advance to 12
  //   + at 12 → added, advance to 13
  //   context at 13 → advance to 14
  // Hunk 2: @@ -20,3 +22,5 @@
  //   context at new line 22 → advance to 23
  //   + at 23 → added, advance to 24
  //   context at 24 → advance to 25

  it("line in added section → true", () => {
    expect(isLineInDiff(patch, 11)).toBe(true);
  });

  it("line not in diff → false", () => {
    expect(isLineInDiff(patch, 50)).toBe(false);
  });

  it("line in context (not added) → false", () => {
    // Line 10 is a context line in hunk 1
    expect(isLineInDiff(patch, 10)).toBe(false);
  });

  it("empty patch → false", () => {
    expect(isLineInDiff("", 11)).toBe(false);
  });

  it("multi-hunk patch: line in second hunk → true", () => {
    expect(isLineInDiff(patch, 23)).toBe(true);
  });

  it("line from removed section → false", () => {
    const removalPatch = [
      "@@ -5,4 +5,3 @@",
      " context",
      "-removed line",
      " context",
      " context",
    ].join("\n");
    // Removed lines don't advance the new-file line counter,
    // so there's no new-file line corresponding to the removed line.
    expect(isLineInDiff(removalPatch, 5)).toBe(false);
  });

  it("first line of hunk → true if it is an added line", () => {
    // Hunk where the very first line in new file is added
    const addFirstPatch = ["@@ -0,0 +1,3 @@", "+first added", "+second added", "+third added"].join(
      "\n",
    );
    expect(isLineInDiff(addFirstPatch, 1)).toBe(true);
  });

  it("multiple added lines each individually verified", () => {
    expect(isLineInDiff(patch, 11)).toBe(true);
    expect(isLineInDiff(patch, 12)).toBe(true);
    expect(isLineInDiff(patch, 13)).toBe(false); // context
    expect(isLineInDiff(patch, 22)).toBe(false); // context
    expect(isLineInDiff(patch, 23)).toBe(true);
    expect(isLineInDiff(patch, 24)).toBe(false); // context
  });
});

// ---------------------------------------------------------------------------
// fetchDiff
// ---------------------------------------------------------------------------
function makeOctokitMock(files: unknown[]) {
  return {
    paginate: vi.fn().mockResolvedValue(files),
    rest: { pulls: { listFiles: {} } },
  } as never;
}

describe("fetchDiff", () => {
  it("skips files whose patch exceeds maxDiffSize", async () => {
    const hugePatch = "+" + "x".repeat(100);
    const files = [
      { filename: "small.dart", patch: "@@ -1 +1 @@\n+a", additions: 1, deletions: 0 },
      { filename: "huge.dart", patch: hugePatch, additions: 50, deletions: 50 },
    ];

    const result = await fetchDiff(makeOctokitMock(files), "owner", "repo", 1, 50);

    expect(result.map((f) => f.filename)).toEqual(["small.dart"]);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("huge.dart"));
  });

  it("includes files whose patch is within maxDiffSize", async () => {
    const files = [
      { filename: "a.dart", patch: "@@ -1 +1 @@\n+a", additions: 1, deletions: 0 },
      { filename: "b.dart", patch: "@@ -2 +2 @@\n+b", additions: 1, deletions: 0 },
    ];

    const result = await fetchDiff(makeOctokitMock(files), "owner", "repo", 1, 1000);

    expect(result).toHaveLength(2);
    expect(result[0].patch).not.toContain("truncated");
  });
});
