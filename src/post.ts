import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import type { ConsolidatedReview, ReviewFinding, ReviewComment, DiffFile } from "./types.js";
import { PERSPECTIVE_REGISTRY } from "./perspectives.js";
import { isLineInDiff } from "./diff.js";

const REVIEW_SIGNATURE = "Livvie Code Review";

export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  consolidated: ConsolidatedReview,
  files: DiffFile[],
  requestChangesOnHigh: boolean,
  maxComments: number
): Promise<number> {
  const { comments, postedFindings } = buildComments(consolidated, files, maxComments);
  const body = buildReviewBody(consolidated, postedFindings);

  const hasHigh = consolidated.findings.some((f) => f.severity === "high");
  const event = hasHigh && requestChangesOnHigh ? "REQUEST_CHANGES" : "COMMENT";

  core.info(`Posting ${event} review with ${comments.length} inline comments...`);

  let reviewId: number;

  try {
    const response = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      body,
      event,
      comments,
    });
    reviewId = response.data.id;
  } catch (error: any) {
    if (comments.length > 0 && shouldRetryWithoutInline(error)) {
      core.warning("GitHub rejected inline comments, retrying as single-line...");

      const singleLineComments = comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side as "RIGHT",
        body: c.body,
      }));

      try {
        const response = await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          body,
          event,
          comments: singleLineComments,
        });
        reviewId = response.data.id;
      } catch {
        core.warning("Single-line comments also rejected, posting summary only...");
        const response = await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          body: buildReviewBody(consolidated, new Set()),
          event,
        });
        reviewId = response.data.id;
      }
    } else {
      throw error;
    }
  }

  core.info(`Posted review #${reviewId}`);

  await dismissStaleReviews(octokit, owner, repo, pullNumber, reviewId);

  return reviewId;
}

function buildComments(
  consolidated: ConsolidatedReview,
  files: DiffFile[],
  maxComments: number
): { comments: ReviewComment[]; postedFindings: Set<ReviewFinding> } {
  const comments: ReviewComment[] = [];
  const postedFindings = new Set<ReviewFinding>();

  for (const finding of consolidated.findings) {
    if (comments.length >= maxComments) {
      core.info(`Reached max-comments limit (${maxComments})`);
      break;
    }

    const diffFile = files.find((f) => f.filename === finding.file);
    if (!diffFile) {
      core.warning(`File not in diff: ${finding.file}`);
      continue;
    }

    if (!isLineInDiff(diffFile.patch, finding.line)) {
      core.warning(`Line ${finding.line} not in diff for ${finding.file}`);
      continue;
    }

    const comment: ReviewComment = {
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: formatCommentBody(finding),
    };

    if (finding.suggestion) {
      const startLine = calculateStartLine(finding);
      if (startLine && startLine < finding.line) {
        comment.start_line = startLine;
        comment.start_side = "RIGHT";
      }
    }

    comments.push(comment);
    postedFindings.add(finding);
  }

  return { comments, postedFindings };
}

function calculateStartLine(finding: ReviewFinding): number | undefined {
  if (!finding.suggestion) return undefined;
  const lineCount = finding.suggestion.split("\n").length;
  if (lineCount <= 1) return undefined;
  const startLine = finding.line - lineCount + 1;
  if (startLine < 1 || startLine >= finding.line) return undefined;
  return startLine;
}

function formatCommentBody(finding: ReviewFinding): string {
  const severityBadge = severityBadgeMap[finding.severity];
  const confidenceIcon = confidenceIconMap[finding.confidence];
  const perspectiveName = PERSPECTIVE_REGISTRY[finding.perspective]?.name ?? finding.perspective;

  const parts: string[] = [];
  parts.push(`${severityBadge} **Severity: ${finding.severity.toUpperCase()}**`);
  parts.push(`${confidenceIcon} **Confidence: ${finding.confidence}**`);
  parts.push("");
  parts.push(finding.description);

  if (finding.suggestion) {
    parts.push("");
    parts.push("```suggestion");
    parts.push(finding.suggestion);
    parts.push("```");
  }

  parts.push("");
  parts.push(`— Found by: **${perspectiveName}**`);

  return parts.join("\n");
}

const severityBadgeMap: Record<string, string> = {
  high: "🔴",
  medium: "🟡",
  low: "🔵",
};

const confidenceIconMap: Record<string, string> = {
  high: "✅",
  medium: "⚠️",
  low: "❓",
};

function buildReviewBody(
  consolidated: ConsolidatedReview,
  postedFindings: Set<ReviewFinding>
): string {
  const parts: string[] = [];

  parts.push(`## ${REVIEW_SIGNATURE}`);
  parts.push("");

  const { stats } = consolidated;
  const statParts: string[] = [];
  if (stats.high > 0) statParts.push(`🔴 **${stats.high} High**`);
  if (stats.medium > 0) statParts.push(`🟡 **${stats.medium} Medium**`);
  if (stats.low > 0) statParts.push(`🔵 **${stats.low} Low**`);
  if (statParts.length === 0) statParts.push("✅ **No issues found**");
  parts.push(statParts.join(" · "));
  parts.push("");

  if (consolidated.summary) {
    parts.push(consolidated.summary);
    parts.push("");
  }

  if (consolidated.perspectiveSummaries.length > 0) {
    parts.push("### 🏷️ Perspective Breakdown");
    parts.push("");
    parts.push("| Perspective | High | Medium | Low | Total |");
    parts.push("|---|---|---|---|---|");
    for (const ps of consolidated.perspectiveSummaries) {
      parts.push(`| ${ps.perspectiveName} | ${ps.highCount} | ${ps.mediumCount} | ${ps.lowCount} | ${ps.findingCount} |`);
    }
    parts.push("");
  }

  const posted = consolidated.findings.filter((f) => postedFindings.has(f));
  if (posted.length > 0) {
    parts.push("### 📋 Posted findings");
    parts.push("");
    parts.push("| # | Severity | Confidence | File | Line | Perspective |");
    parts.push("|---|---|---|---|---|---|");
    for (let i = 0; i < posted.length; i++) {
      const f = posted[i];
      const sevBadge = severityBadgeMap[f.severity];
      const confIcon = confidenceIconMap[f.confidence];
      const shortFile = f.file.split("/").pop() ?? f.file;
      const perspName = PERSPECTIVE_REGISTRY[f.perspective]?.name ?? f.perspective;
      parts.push(`| **${i + 1}** | ${sevBadge} ${f.severity} | ${confIcon} ${f.confidence} | \`${shortFile}\` | ${f.line} | ${perspName} |`);
    }
    parts.push("");
  }

  const unposted = consolidated.findings.filter((f) => !postedFindings.has(f));
  if (unposted.length > 0) {
    parts.push("---");
    parts.push("### Findings not posted inline");
    parts.push("");
    for (let i = 0; i < unposted.length; i++) {
      const f = unposted[i];
      const sevBadge = severityBadgeMap[f.severity];
      const confIcon = confidenceIconMap[f.confidence];
      const perspName = PERSPECTIVE_REGISTRY[f.perspective]?.name ?? f.perspective;
      parts.push(`${sevBadge} **${i + 1}** — \`${f.file}:${f.line}\` · ${confIcon} ${f.confidence} · Found by: ${perspName}`);
      parts.push("");
      parts.push(f.description);
      if (f.suggestion) {
        parts.push("");
        parts.push("```suggestion");
        parts.push(f.suggestion);
        parts.push("```");
      }
      parts.push("");
    }
  }

  if (consolidated.unreviewedFiles.length > 0) {
    parts.push("---");
    parts.push("### ⚠️ Unreviewed files");
    parts.push("");
    parts.push("The following files could not be reviewed (LLM calls failed):");
    parts.push("");
    for (const f of consolidated.unreviewedFiles) {
      parts.push(`- \`${f}\``);
    }
    parts.push("");
  }

  parts.push("---");
  parts.push(`*Batches: ${stats.totalBatches} · Perspectives: ${stats.totalPerspectives} · LLM calls: ${stats.successfulLLMCalls}/${stats.totalLLMCalls}*`);
  parts.push("");
  parts.push("*[Livvie Code Review](https://github.com/4itworks/livvie_code_review)*");

  return parts.join("\n");
}

function shouldRetryWithoutInline(error: any): boolean {
  if (error?.status !== 422) return false;
  const details = JSON.stringify(error?.response?.data || error?.message || "");
  return /position|line|side|diff/i.test(details);
}

async function dismissStaleReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  currentReviewId: number
): Promise<void> {
  try {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    for (const review of reviews) {
      if (
        review.id !== currentReviewId &&
        review.state === "CHANGES_REQUESTED" &&
        review.user?.type === "Bot" &&
        (review.body || "").includes(REVIEW_SIGNATURE)
      ) {
        try {
          await octokit.rest.pulls.dismissReview({
            owner,
            repo,
            pull_number: pullNumber,
            review_id: review.id,
            message: "Superseded by a newer review.",
          });
          core.info(`Dismissed stale review #${review.id}`);
        } catch (error) {
          core.warning(`Could not dismiss stale review #${review.id}: ${error}`);
        }
      }
    }
  } catch (error) {
    core.warning(`Could not check for stale reviews: ${error}`);
  }
}
