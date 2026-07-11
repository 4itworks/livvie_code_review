import { describe, it, expect } from "vitest";
import { buildCrossFileContext } from "./cross-file.js";
import type { Batch, PreparedFile } from "./types.js";

function makePreparedFile(filename: string, patch: string): PreparedFile {
  return {
    filename,
    patch,
    additions: 1,
    deletions: 0,
    content: "",
    tokenCount: 50,
    truncated: false,
    directory: filename.includes("/") ? filename.substring(0, filename.lastIndexOf("/")) : "",
  };
}

function makeBatch(index: number, files: PreparedFile[]): Batch {
  return {
    index,
    files,
    tokenCount: files.reduce((sum, f) => sum + f.tokenCount, 0),
    crossFileContext: "",
    totalTokenCount: 0,
  };
}

describe("buildCrossFileContext", () => {
  it("only batch → empty context", () => {
    const batch = makeBatch(0, [makePreparedFile("lib/a.dart", "@@ -1,3 +1,4 @@\n+added")]);
    const result = buildCrossFileContext([batch], batch, 10000);
    expect(result).toBe("");
  });

  it("two batches → current gets other batch files", () => {
    const batch0 = makeBatch(0, [makePreparedFile("lib/a.dart", "@@ -1,3 +1,4 @@\n+line")]);
    const batch1 = makeBatch(1, [makePreparedFile("lib/b.dart", "@@ -5,3 +5,4 @@\n+other")]);
    const result = buildCrossFileContext([batch0, batch1], batch1, 10000);
    expect(result).toContain("lib/a.dart");
    expect(result).toContain("context only");
    expect(result).not.toContain("lib/b.dart");
  });

  it("respects token limit", () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      makePreparedFile(`lib/file${i}.dart`, `@@ -1,3 +1,4 @@\n+line${i}`),
    );
    const batch0 = makeBatch(0, files);
    const batch1 = makeBatch(1, [makePreparedFile("lib/main.dart", "@@ -1,3 +1,4 @@\n+main")]);
    const result = buildCrossFileContext([batch0, batch1], batch1, 100);
    expect(result.length).toBeLessThan(5000);
  });

  it("truncates oversized sections and marks context as truncated", () => {
    const hugePatch =
      "@@ -1,1 +1,10001 @@\n" +
      Array.from({ length: 10000 }, (_, i) => `+line number ${i} with varied content ${i % 100}`).join("\n");
    const batch0 = makeBatch(0, [makePreparedFile("lib/huge.dart", hugePatch)]);
    const batch1 = makeBatch(1, [makePreparedFile("lib/main.dart", "@@ -1,3 +1,4 @@\n+main")]);
    const result = buildCrossFileContext([batch0, batch1], batch1, 1000);
    expect(result).toContain("lib/huge.dart");
    expect(result).toContain("(truncated)");
  });

  it("empty patch → compact summary is empty", () => {
    const batch0 = makeBatch(0, [makePreparedFile("lib/empty.dart", "")]);
    const batch1 = makeBatch(1, [makePreparedFile("lib/main.dart", "@@ -1,3 +1,4 @@\n+main")]);
    const result = buildCrossFileContext([batch0, batch1], batch1, 10000);
    expect(result).toContain("lib/empty.dart");
  });

  it("multi-file batches → all other files included", () => {
    const batch0 = makeBatch(0, [
      makePreparedFile("lib/a.dart", "@@ -1,3 +1,4 @@\n+lineA"),
      makePreparedFile("lib/b.dart", "@@ -1,3 +1,4 @@\n+lineB"),
    ]);
    const batch1 = makeBatch(1, [makePreparedFile("lib/main.dart", "@@ -1,3 +1,4 @@\n+main")]);
    const result = buildCrossFileContext([batch0, batch1], batch1, 10000);
    expect(result).toContain("lib/a.dart");
    expect(result).toContain("lib/b.dart");
  });
});
