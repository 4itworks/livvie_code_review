import type {
  ReviewMatrixResult,
  ConsolidatedReview,
  ReviewFinding,
  PerspectiveSummary,
  Perspective,
  ReviewStats,
} from "./types.js";

const MAX_FINDINGS = 100;

const SEVERITY_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const CONFIDENCE_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const MAX_SUMMARY_WORDS = 150;

export function consolidateReviews(
  matrixResult: ReviewMatrixResult,
  perspectives: Perspective[],
): ConsolidatedReview {
  const deduplicated = deduplicateFindings(matrixResult.rawFindings);
  const sorted = sortFindings(deduplicated);
  const { kept } = capFindings(sorted, MAX_FINDINGS);

  const summary = mergeSummaries(matrixResult, perspectives);
  const perspectiveSummaries = buildPerspectiveSummaries(matrixResult, perspectives);

  const stats: ReviewStats = {
    totalFindings: kept.length,
    high: kept.filter((f) => f.severity === "high").length,
    medium: kept.filter((f) => f.severity === "medium").length,
    low: kept.filter((f) => f.severity === "low").length,
    totalBatches: new Set(matrixResult.results.map((r) => r.batchIndex)).size,
    totalPerspectives: perspectives.length,
    totalLLMCalls: matrixResult.totalCalls,
    successfulLLMCalls: matrixResult.successfulCalls,
    failedBatches: matrixResult.failedBatches.length,
  };

  return {
    summary,
    findings: kept,
    perspectiveSummaries,
    unreviewedFiles: matrixResult.unreviewedFiles,
    stats,
  };
}

export function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  if (findings.length === 0) return [];

  const sorted = [...findings].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  const result: ReviewFinding[] = [];

  for (const current of sorted) {
    let merged = false;

    for (let existingIndex = 0; existingIndex < result.length; existingIndex++) {
      const existing = result[existingIndex];
      if (areFindingsDuplicate(current, existing)) {
        const winner = compareFindings(current, existing) > 0 ? current : existing;
        const loser = winner === current ? existing : current;
        const foundBy = Array.from(new Set<string>([...winner.foundBy, ...loser.foundBy]));

        result[existingIndex] = {
          ...winner,
          foundBy: [...foundBy],
        };
        merged = true;
        break;
      }
    }

    if (!merged) {
      result.push({ ...current, foundBy: [...current.foundBy] });
    }
  }

  return result;
}

function compareFindings(a: ReviewFinding, b: ReviewFinding): number {
  const confDiff = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
  if (confDiff !== 0) return confDiff;
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

export function areFindingsDuplicate(a: ReviewFinding, b: ReviewFinding): boolean {
  if (a.file !== b.file || Math.abs(a.line - b.line) > 3) return false;
  if (a.perspective === b.perspective) return true;
  const descA = a.description.toLowerCase();
  const descB = b.description.toLowerCase();
  const wordsA = new Set(descA.split(/\s+/).filter((w) => w.length > 3));
  const wordsB = new Set(descB.split(/\s+/).filter((w) => w.length > 3));
  let overlap = 0;
  for (const word of Array.from(wordsA)) {
    if (wordsB.has(word)) overlap++;
  }
  const minSize = Math.min(wordsA.size, wordsB.size);
  return minSize > 0 && overlap / minSize >= 0.5;
}

export function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (sevDiff !== 0) return sevDiff;
    const confDiff = CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence];
    if (confDiff !== 0) return confDiff;
    return a.file.localeCompare(b.file);
  });
}

export function capFindings(
  findings: ReviewFinding[],
  max: number,
): { kept: ReviewFinding[]; dropped: ReviewFinding[] } {
  if (findings.length <= max) {
    return { kept: [...findings], dropped: [] };
  }
  return {
    kept: findings.slice(0, max),
    dropped: findings.slice(max),
  };
}

export function mergeSummaries(results: ReviewMatrixResult, perspectives: Perspective[]): string {
  const successful = results.results.filter((r) => !r.error);
  if (successful.length === 0) {
    return "Review completed but no perspectives produced results.";
  }

  let highestVerdict = "✅ Looks good";
  let verdictEmoji = "✅";

  const whatChangedParts: string[] = [];
  const seenFiles: Set<string> = new Set();

  for (const result of successful) {
    const summary = result.review.summary;
    if (summary.startsWith("🔴")) {
      highestVerdict = "🔴 Changes requested";
      verdictEmoji = "🔴";
    } else if (summary.startsWith("⚠️") && verdictEmoji !== "🔴") {
      highestVerdict = "⚠️ Review recommended";
      verdictEmoji = "⚠️";
    }

    const parts = summary.split("\n\n");
    if (parts.length > 1) {
      const whatChanged = parts.slice(1).join("\n\n");
      const fileRefs = whatChanged.match(/`[^`]+`/g);
      if (fileRefs) {
        let hasNewContent = false;
        for (const ref of fileRefs) {
          const key = ref.toLowerCase();
          if (!seenFiles.has(key)) {
            seenFiles.add(key);
            hasNewContent = true;
          }
        }
        if (hasNewContent) {
          whatChangedParts.push(whatChanged);
        }
      } else if (whatChangedParts.length === 0) {
        whatChangedParts.push(whatChanged);
      }
    }
  }

  let whatChanged = whatChangedParts.join("\n\n");
  const words = whatChanged.split(/\s+/);
  if (words.length > MAX_SUMMARY_WORDS) {
    whatChanged = words.slice(0, MAX_SUMMARY_WORDS).join(" ") + "...";
  }

  return `${highestVerdict} — The PR has ${countFindings(results)} findings from ${perspectives.length} review perspectives.\n\n${whatChanged}`;
}

function countFindings(results: ReviewMatrixResult): number {
  let count = 0;
  for (const result of results.results) {
    if (!result.error) {
      count += result.review.findings.length;
    }
  }
  return count;
}

export function buildPerspectiveSummaries(
  results: ReviewMatrixResult,
  perspectives: Perspective[],
): PerspectiveSummary[] {
  const summaries: PerspectiveSummary[] = [];

  for (const perspective of perspectives) {
    const perspectiveResults = results.results.filter(
      (r) => r.perspectiveId === perspective.id && !r.error,
    );

    const allFindings: ReviewFinding[] = [];
    for (const result of perspectiveResults) {
      allFindings.push(...result.review.findings);
    }

    const high = allFindings.filter((f) => f.severity === "high").length;
    const medium = allFindings.filter((f) => f.severity === "medium").length;
    const low = allFindings.filter((f) => f.severity === "low").length;

    let summary: string;
    if (allFindings.length === 0) {
      summary = `No issues found from the ${perspective.name} perspective.`;
    } else if (high > 0) {
      summary = `${perspective.name} found ${high} high-severity, ${medium} medium, and ${low} low issues.`;
    } else if (medium > 0) {
      summary = `${perspective.name} found ${medium} medium and ${low} low issues.`;
    } else {
      summary = `${perspective.name} found ${low} low-severity issue${low !== 1 ? "s" : ""}.`;
    }

    summaries.push({
      perspectiveId: perspective.id,
      perspectiveName: perspective.name,
      findingCount: allFindings.length,
      highCount: high,
      mediumCount: medium,
      lowCount: low,
      summary,
    });
  }

  return summaries;
}
