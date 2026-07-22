import { describe, it, expect } from "vitest";
import {
  deduplicateFindings,
  areFindingsDuplicate,
  sortFindings,
  capFindings,
  mergeSummaries,
  buildPerspectiveSummaries,
  consolidateReviews,
} from "./consolidation.js";
import type { ReviewFinding, ReviewMatrixResult, Perspective, BatchReviewResult } from "./types.js";

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "test-finding-id",
    severity: "medium",
    confidence: "high",
    file: "lib/main.dart",
    line: 10,
    description: "A null check is missing before accessing the value",
    suggestion: null,
    suggestionStartLine: null,
    perspective: "security",
    foundBy: ["security"],
    ...overrides,
  };
}

describe("areFindingsDuplicate", () => {
  it("same file, same line → true (same perspective)", () => {
    const a = makeFinding({ file: "lib/main.dart", line: 10, perspective: "security" });
    const b = makeFinding({ file: "lib/main.dart", line: 10, perspective: "security" });
    expect(areFindingsDuplicate(a, b)).toBe(true);
  });

  it("same file, ±3 lines, same perspective → true", () => {
    const a = makeFinding({ file: "lib/main.dart", line: 10, perspective: "security" });
    const b = makeFinding({ file: "lib/main.dart", line: 13, perspective: "security" });
    expect(areFindingsDuplicate(a, b)).toBe(true);
  });

  it("same file, ±3 lines, different perspectives, similar descriptions → true", () => {
    const a = makeFinding({
      file: "lib/main.dart",
      line: 10,
      perspective: "security",
      description: "Missing null check before accessing the value safely",
    });
    const b = makeFinding({
      file: "lib/main.dart",
      line: 12,
      perspective: "performance",
      description: "Missing null check before accessing the value correctly",
    });
    expect(areFindingsDuplicate(a, b)).toBe(true);
  });

  it("same file, ±3 lines, different perspectives, different descriptions → false", () => {
    const a = makeFinding({
      file: "lib/main.dart",
      line: 10,
      perspective: "security",
      description: "SQL injection vulnerability in query builder",
    });
    const b = makeFinding({
      file: "lib/main.dart",
      line: 12,
      perspective: "performance",
      description: "Memory leak from unclosed stream subscription",
    });
    expect(areFindingsDuplicate(a, b)).toBe(false);
  });

  it("same file, ±4 lines → false", () => {
    const a = makeFinding({ file: "lib/main.dart", line: 10 });
    const b = makeFinding({ file: "lib/main.dart", line: 14 });
    expect(areFindingsDuplicate(a, b)).toBe(false);
  });

  it("different files → false", () => {
    const a = makeFinding({ file: "lib/main.dart", line: 10 });
    const b = makeFinding({ file: "lib/utils.dart", line: 10 });
    expect(areFindingsDuplicate(a, b)).toBe(false);
  });

  it("empty descriptions with different perspectives (no words >3 chars) → false", () => {
    const a = makeFinding({ description: "bad", perspective: "security" });
    const b = makeFinding({ description: "ok", perspective: "performance" });
    expect(areFindingsDuplicate(a, b)).toBe(false);
  });
});

describe("deduplicateFindings", () => {
  it("empty array → empty array", () => {
    expect(deduplicateFindings([])).toEqual([]);
  });

  it("single finding → [finding]", () => {
    const f = makeFinding();
    const result = deduplicateFindings([f]);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe(f.file);
    expect(result[0].line).toBe(f.line);
  });

  it("two duplicates → merged, foundBy contains both perspectives", () => {
    const a = makeFinding({
      file: "lib/main.dart",
      line: 10,
      perspective: "security",
      foundBy: ["security"],
    });
    const b = makeFinding({
      file: "lib/main.dart",
      line: 10,
      perspective: "performance",
      foundBy: ["performance"],
    });
    const result = deduplicateFindings([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].foundBy).toContain("security");
    expect(result[0].foundBy).toContain("performance");
  });

  it("two different findings → kept separate", () => {
    const a = makeFinding({
      file: "lib/main.dart",
      line: 10,
      perspective: "security",
      description: "SQL injection vulnerability",
    });
    const b = makeFinding({
      file: "lib/utils.dart",
      line: 50,
      perspective: "performance",
      description: "Memory leak in stream",
    });
    const result = deduplicateFindings([a, b]);
    expect(result).toHaveLength(2);
  });

  it("three findings, two are duplicates → 2 results", () => {
    const a = makeFinding({
      file: "lib/main.dart",
      line: 10,
      perspective: "security",
      foundBy: ["security"],
    });
    const b = makeFinding({
      file: "lib/main.dart",
      line: 11,
      perspective: "security",
      foundBy: ["security"],
    });
    const c = makeFinding({
      file: "lib/utils.dart",
      line: 20,
      perspective: "performance",
      foundBy: ["performance"],
    });
    const result = deduplicateFindings([a, b, c]);
    expect(result).toHaveLength(2);
  });
});

describe("sortFindings", () => {
  it("high severity before medium before low", () => {
    const low = makeFinding({ severity: "low", file: "a.dart", line: 1 });
    const high = makeFinding({ severity: "high", file: "a.dart", line: 2 });
    const medium = makeFinding({ severity: "medium", file: "a.dart", line: 3 });
    const result = sortFindings([low, high, medium]);
    expect(result[0].severity).toBe("high");
    expect(result[1].severity).toBe("medium");
    expect(result[2].severity).toBe("low");
  });

  it("same severity: high confidence before low confidence", () => {
    const lowConf = makeFinding({ severity: "high", confidence: "low", file: "a.dart", line: 1 });
    const highConf = makeFinding({ severity: "high", confidence: "high", file: "a.dart", line: 2 });
    const result = sortFindings([lowConf, highConf]);
    expect(result[0].confidence).toBe("high");
    expect(result[1].confidence).toBe("low");
  });

  it("same severity + confidence: alphabetical by file", () => {
    const z = makeFinding({ severity: "high", confidence: "high", file: "z.dart", line: 1 });
    const a = makeFinding({ severity: "high", confidence: "high", file: "a.dart", line: 1 });
    const result = sortFindings([z, a]);
    expect(result[0].file).toBe("a.dart");
    expect(result[1].file).toBe("z.dart");
  });

  it("does not mutate the original array", () => {
    const low = makeFinding({ severity: "low", file: "a.dart", line: 1 });
    const high = makeFinding({ severity: "high", file: "a.dart", line: 2 });
    const original = [low, high];
    sortFindings(original);
    expect(original[0]).toBe(low);
    expect(original[1]).toBe(high);
  });
});

describe("capFindings", () => {
  it("5 findings, max 3 → kept=3, dropped=2", () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ file: `file${i}.dart`, line: i }),
    );
    const result = capFindings(findings, 3);
    expect(result.kept).toHaveLength(3);
    expect(result.dropped).toHaveLength(2);
  });

  it("3 findings, max 5 → kept=3, dropped=0", () => {
    const findings = Array.from({ length: 3 }, (_, i) =>
      makeFinding({ file: `file${i}.dart`, line: i }),
    );
    const result = capFindings(findings, 5);
    expect(result.kept).toHaveLength(3);
    expect(result.dropped).toHaveLength(0);
  });

  it("0 findings, max 10 → kept=0, dropped=0", () => {
    const result = capFindings([], 10);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it("exact max → kept=all, dropped=0", () => {
    const findings = Array.from({ length: 3 }, (_, i) =>
      makeFinding({ file: `file${i}.dart`, line: i }),
    );
    const result = capFindings(findings, 3);
    expect(result.kept).toHaveLength(3);
    expect(result.dropped).toHaveLength(0);
  });
});

function makeResult(overrides: Partial<BatchReviewResult> = {}): BatchReviewResult {
  return {
    batchIndex: 0,
    perspectiveId: "generalist",
    perspectiveName: "General Reviewer",
    review: { summary: "✅ Looks good — nothing to report.", findings: [] },
    modelUsed: "test-model",
    latencyMs: 100,
    usedFallback: false,
    ...overrides,
  };
}

function makePerspective(id: string, name?: string): Perspective {
  return { id, name: name ?? `${id} Reviewer`, systemPrompt: "test", focus: "test" };
}

describe("mergeSummaries", () => {
  it("all failed → fallback message", () => {
    const matrix: ReviewMatrixResult = {
      results: [makeResult({ error: "timeout" })],
      rawFindings: [],
      failedBatches: [0],
      unreviewedFiles: ["a.dart"],
      totalCalls: 1,
      successfulCalls: 0,
    };
    const result = mergeSummaries(matrix, [makePerspective("generalist")]);
    expect(result).toContain("no perspectives produced results");
  });

  it("high severity → changes requested emoji", () => {
    const matrix: ReviewMatrixResult = {
      results: [
        makeResult({ review: { summary: "🔴 Changes requested — bug found.", findings: [] } }),
      ],
      rawFindings: [],
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 1,
      successfulCalls: 1,
    };
    const result = mergeSummaries(matrix, [makePerspective("generalist")]);
    expect(result).toContain("🔴");
  });

  it("medium severity → warning emoji", () => {
    const matrix: ReviewMatrixResult = {
      results: [
        makeResult({
          review: {
            summary: "⚠️ Review recommended — issues found.\n\nChanges in `lib/main.dart`.",
            findings: [],
          },
        }),
      ],
      rawFindings: [],
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 1,
      successfulCalls: 1,
    };
    const result = mergeSummaries(matrix, [makePerspective("generalist")]);
    expect(result).toContain("⚠️");
  });

  it("findings count in summary", () => {
    const f1 = makeFinding({ line: 1 });
    const f2 = makeFinding({ line: 5 });
    const matrix: ReviewMatrixResult = {
      results: [
        makeResult({
          review: { summary: "✅ Looks good.\n\nChanges in `lib/main.dart`.", findings: [f1, f2] },
        }),
      ],
      rawFindings: [f1, f2],
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 1,
      successfulCalls: 1,
    };
    const result = mergeSummaries(matrix, [makePerspective("generalist")]);
    expect(result).toContain("2 findings");
    expect(result).toContain("1 review perspectives");
  });
});

describe("buildPerspectiveSummaries", () => {
  it("perspective with no results → no issues message", () => {
    const matrix: ReviewMatrixResult = {
      results: [],
      rawFindings: [],
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 0,
      successfulCalls: 0,
    };
    const result = buildPerspectiveSummaries(matrix, [
      makePerspective("security", "Security Reviewer"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].findingCount).toBe(0);
    expect(result[0].summary).toContain("No issues found");
  });

  it("perspective with high findings → correct counts", () => {
    const findings = [
      makeFinding({ severity: "high", perspective: "security" }),
      makeFinding({ severity: "medium", perspective: "security", line: 20 }),
      makeFinding({ severity: "low", perspective: "security", line: 30 }),
    ];
    const matrix: ReviewMatrixResult = {
      results: [makeResult({ perspectiveId: "security", review: { summary: "test", findings } })],
      rawFindings: findings,
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 1,
      successfulCalls: 1,
    };
    const result = buildPerspectiveSummaries(matrix, [makePerspective("security")]);
    expect(result[0].highCount).toBe(1);
    expect(result[0].mediumCount).toBe(1);
    expect(result[0].lowCount).toBe(1);
    expect(result[0].findingCount).toBe(3);
    expect(result[0].summary).toContain("high-severity");
  });

  it("perspective with only low findings → low-severity message", () => {
    const findings = [makeFinding({ severity: "low", perspective: "generalist" })];
    const matrix: ReviewMatrixResult = {
      results: [makeResult({ perspectiveId: "generalist", review: { summary: "test", findings } })],
      rawFindings: findings,
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 1,
      successfulCalls: 1,
    };
    const result = buildPerspectiveSummaries(matrix, [makePerspective("generalist")]);
    expect(result[0].summary).toContain("low-severity issue");
  });

  it("perspective with medium only → medium message without high", () => {
    const findings = [
      makeFinding({ severity: "medium", perspective: "perf", line: 10 }),
      makeFinding({ severity: "medium", perspective: "perf", line: 20 }),
    ];
    const matrix: ReviewMatrixResult = {
      results: [makeResult({ perspectiveId: "perf", review: { summary: "test", findings } })],
      rawFindings: findings,
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 1,
      successfulCalls: 1,
    };
    const result = buildPerspectiveSummaries(matrix, [makePerspective("perf")]);
    expect(result[0].summary).toContain("medium and");
    expect(result[0].summary).not.toContain("high-severity");
  });

  it("error results are excluded from counts", () => {
    const matrix: ReviewMatrixResult = {
      results: [
        makeResult({
          perspectiveId: "security",
          review: { summary: "test", findings: [makeFinding({ perspective: "security" })] },
        }),
        makeResult({ perspectiveId: "security", error: "timeout" }),
      ],
      rawFindings: [],
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 2,
      successfulCalls: 1,
    };
    const result = buildPerspectiveSummaries(matrix, [makePerspective("security")]);
    expect(result[0].findingCount).toBe(1);
  });
});

describe("consolidateReviews", () => {
  it("full pipeline: dedup + sort + cap + summaries + stats", () => {
    const findings = [
      makeFinding({ severity: "high", file: "lib/main.dart", line: 10, perspective: "generalist" }),
      makeFinding({
        severity: "high",
        file: "lib/utils.dart",
        line: 20,
        perspective: "generalist",
      }),
      makeFinding({ severity: "low", file: "lib/b.dart", line: 30, perspective: "generalist" }),
      makeFinding({ severity: "low", file: "lib/c.dart", line: 40, perspective: "generalist" }),
      makeFinding({ severity: "low", file: "lib/d.dart", line: 50, perspective: "generalist" }),
    ];
    const matrix: ReviewMatrixResult = {
      results: [
        makeResult({
          perspectiveId: "generalist",
          review: { summary: "✅ Looks good.\n\nChanges in `lib/main.dart`.", findings },
        }),
      ],
      rawFindings: findings,
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 1,
      successfulCalls: 1,
    };
    const result = consolidateReviews(matrix, [makePerspective("generalist")]);
    expect(result.stats.totalFindings).toBeGreaterThan(0);
    expect(result.stats.high).toBe(2);
    expect(result.perspectiveSummaries).toHaveLength(1);
    expect(result.findings.length).toBeLessThanOrEqual(100);
  });

  it("0 findings → approved summary", () => {
    const matrix: ReviewMatrixResult = {
      results: [
        makeResult({
          perspectiveId: "generalist",
          review: { summary: "✅ Looks good.", findings: [] },
        }),
      ],
      rawFindings: [],
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 1,
      successfulCalls: 1,
    };
    const result = consolidateReviews(matrix, [makePerspective("generalist")]);
    expect(result.stats.totalFindings).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("caps at 100 findings", () => {
    const findings = Array.from({ length: 150 }, (_, i) =>
      makeFinding({ file: `lib/file${i}.dart`, line: i, perspective: "generalist" }),
    );
    const matrix: ReviewMatrixResult = {
      results: [
        makeResult({
          perspectiveId: "generalist",
          review: { summary: "🔴 Changes requested.\n\nMany issues.", findings },
        }),
      ],
      rawFindings: findings,
      failedBatches: [],
      unreviewedFiles: [],
      totalCalls: 1,
      successfulCalls: 1,
    };
    const result = consolidateReviews(matrix, [makePerspective("generalist")]);
    expect(result.findings.length).toBeLessThanOrEqual(100);
    expect(result.stats.totalFindings).toBeLessThanOrEqual(100);
  });

  it("unreviewed files passed through", () => {
    const matrix: ReviewMatrixResult = {
      results: [],
      rawFindings: [],
      failedBatches: [0],
      unreviewedFiles: ["lib/broken.dart"],
      totalCalls: 1,
      successfulCalls: 0,
    };
    const result = consolidateReviews(matrix, [makePerspective("generalist")]);
    expect(result.unreviewedFiles).toContain("lib/broken.dart");
  });
});
