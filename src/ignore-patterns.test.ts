import { describe, it, expect } from "vitest";
import { parseIgnorePatterns, shouldIgnoreFile, filterIgnoredFiles } from "./ignore-patterns.js";
import type { DiffFile } from "./types.js";

describe("parseIgnorePatterns", () => {
  it("empty string → []", () => {
    expect(parseIgnorePatterns("")).toEqual([]);
  });

  it("whitespace-only string → []", () => {
    expect(parseIgnorePatterns("   ")).toEqual([]);
  });

  it("single pattern → [pattern]", () => {
    expect(parseIgnorePatterns("*.g.dart")).toEqual(["*.g.dart"]);
  });

  it("multiple comma-separated → [p1, p2, p3]", () => {
    expect(parseIgnorePatterns("*.g.dart,build/**,dist/**")).toEqual([
      "*.g.dart",
      "build/**",
      "dist/**",
    ]);
  });

  it("patterns with spaces are trimmed", () => {
    expect(parseIgnorePatterns(" *.g.dart , build/** ")).toEqual(["*.g.dart", "build/**"]);
  });

  it("trailing comma → filtered out", () => {
    expect(parseIgnorePatterns("*.g.dart,")).toEqual(["*.g.dart"]);
  });

  it("leading and trailing commas → filtered out", () => {
    expect(parseIgnorePatterns(",*.g.dart,")).toEqual(["*.g.dart"]);
  });

  it("multiple commas only → []", () => {
    expect(parseIgnorePatterns(",,,")).toEqual([]);
  });
});

describe("shouldIgnoreFile", () => {
  describe("*.g.dart pattern", () => {
    const patterns = ["*.g.dart"];

    it("foo.g.dart → true", () => {
      expect(shouldIgnoreFile("foo.g.dart", patterns)).toBe(true);
    });

    it("foo.dart → false", () => {
      expect(shouldIgnoreFile("foo.dart", patterns)).toBe(false);
    });

    it("foo.g.dart.backup → false (anchored)", () => {
      expect(shouldIgnoreFile("foo.g.dart.backup", patterns)).toBe(false);
    });
  });

  describe("build/** pattern", () => {
    const patterns = ["build/**"];

    it("build/output.js → true", () => {
      expect(shouldIgnoreFile("build/output.js", patterns)).toBe(true);
    });

    it("build/nested/deep/file.js → true", () => {
      expect(shouldIgnoreFile("build/nested/deep/file.js", patterns)).toBe(true);
    });

    it("src/build/output.js → false", () => {
      expect(shouldIgnoreFile("src/build/output.js", patterns)).toBe(false);
    });
  });

  describe("dist/** pattern", () => {
    const patterns = ["dist/**"];

    it("dist/index.js → true", () => {
      expect(shouldIgnoreFile("dist/index.js", patterns)).toBe(true);
    });
  });

  describe("*.min.js pattern", () => {
    const patterns = ["*.min.js"];

    it("app.min.js → true", () => {
      expect(shouldIgnoreFile("app.min.js", patterns)).toBe(true);
    });

    it("app.js → false", () => {
      expect(shouldIgnoreFile("app.js", patterns)).toBe(false);
    });
  });

  describe("multiple patterns", () => {
    const patterns = ["*.g.dart", "build/**", "*.min.js"];

    it("matches first pattern", () => {
      expect(shouldIgnoreFile("foo.g.dart", patterns)).toBe(true);
    });

    it("matches second pattern", () => {
      expect(shouldIgnoreFile("build/output.js", patterns)).toBe(true);
    });

    it("matches third pattern", () => {
      expect(shouldIgnoreFile("app.min.js", patterns)).toBe(true);
    });

    it("matches none → false", () => {
      expect(shouldIgnoreFile("src/main.dart", patterns)).toBe(false);
    });
  });

  describe("no patterns", () => {
    it("empty patterns → false", () => {
      expect(shouldIgnoreFile("any/file.txt", [])).toBe(false);
    });
  });

  describe("node_modules/** pattern", () => {
    const patterns = ["node_modules/**"];

    it("node_modules/pkg/index.js → true", () => {
      expect(shouldIgnoreFile("node_modules/pkg/index.js", patterns)).toBe(true);
    });

    it("src/node_modules/pkg/index.js → false", () => {
      expect(shouldIgnoreFile("src/node_modules/pkg/index.js", patterns)).toBe(false);
    });
  });
});

function makeDiffFile(filename: string): DiffFile {
  return { filename, patch: "", additions: 1, deletions: 0 };
}

describe("filterIgnoredFiles", () => {
  it("mix of matching and non-matching files → correct split", () => {
    const files = [
      makeDiffFile("src/main.dart"),
      makeDiffFile("foo.g.dart"),
      makeDiffFile("build/output.js"),
      makeDiffFile("src/bar.dart"),
    ];
    const patterns = ["*.g.dart", "build/**"];
    const result = filterIgnoredFiles(files, patterns);

    expect(result.kept).toHaveLength(2);
    expect(result.kept.map((f) => f.filename)).toEqual(["src/main.dart", "src/bar.dart"]);
    expect(result.ignored).toHaveLength(2);
    expect(result.ignored.map((f) => f.filename)).toEqual(["foo.g.dart", "build/output.js"]);
  });

  it("empty files array → kept=[], ignored=[]", () => {
    const result = filterIgnoredFiles([], ["*.g.dart"]);
    expect(result.kept).toEqual([]);
    expect(result.ignored).toEqual([]);
  });

  it("all ignored → kept=[], ignored=[all]", () => {
    const files = [makeDiffFile("a.g.dart"), makeDiffFile("b.g.dart")];
    const result = filterIgnoredFiles(files, ["*.g.dart"]);
    expect(result.kept).toEqual([]);
    expect(result.ignored).toHaveLength(2);
  });

  it("none ignored → kept=[all], ignored=[]", () => {
    const files = [makeDiffFile("src/main.dart"), makeDiffFile("lib/utils.dart")];
    const result = filterIgnoredFiles(files, ["*.g.dart"]);
    expect(result.kept).toHaveLength(2);
    expect(result.ignored).toEqual([]);
  });
});
