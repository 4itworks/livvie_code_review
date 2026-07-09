import * as fs from "fs";
import * as path from "path";
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import type { StructuredReview, ReviewFinding, ReviewComment, DiffFile } from "./types.js";
import { isLineInDiff } from "./diff.js";

const REVIEW_SIGNATURE = "Livvie Code Review";

export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  review: StructuredReview,
  files: DiffFile[],
  requestChangesOnHigh: boolean,
  maxComments: number
): Promise<void> {
  const { comments, postedFindings } = buildComments(review, files, maxComments);
  const body = buildReviewBody(review, postedFindings);

  const hasHigh = review.findings.some((f) => f.severity === "high");
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
      core.warning("GitHub rejected inline comments, posting summary only...");
      const response = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        body: buildReviewBody(review, new Set()),
        event,
      });
      reviewId = response.data.id;
    } else {
      throw error;
    }
  }

  core.info(`Posted review #${reviewId}`);

  await dismissStaleReviews(octokit, owner, repo, pullNumber, reviewId);
}

function buildComments(
  review: StructuredReview,
  files: DiffFile[],
  maxComments: number
): { comments: ReviewComment[]; postedFindings: Set<ReviewFinding> } {
  const comments: ReviewComment[] = [];
  const postedFindings = new Set<ReviewFinding>();

  for (const finding of review.findings) {
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

    comments.push({
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: formatCommentBody(finding),
    });
    postedFindings.add(finding);
  }

  return { comments, postedFindings };
}

function formatCommentBody(finding: ReviewFinding): string {
  const severityBadge = severityBadgeMap[finding.severity];
  const confidenceLabel = confidenceLabelMap[finding.confidence];

  const parts: string[] = [];
  parts.push(`${severityBadge} **${REVIEW_SIGNATURE}** — **${finding.severity.toUpperCase()}**`);
  parts.push(`🎯 Confidence: **${confidenceLabel}**`);
  parts.push("");
  parts.push(finding.description);

  if (finding.suggestion) {
    parts.push("");
    parts.push("```suggestion");
    parts.push(finding.suggestion);
    parts.push("```");
  }

  return parts.join("\n");
}

const severityBadgeMap: Record<string, string> = {
  high: "🔴",
  medium: "🟡",
  low: "🔵",
};

const confidenceLabelMap: Record<string, string> = {
  high: "🟢 High",
  medium: "🟡 Medium",
  low: "🔴 Low",
};

function buildReviewBody(review: StructuredReview, postedFindings: Set<ReviewFinding>): string {
  const parts: string[] = [];

  parts.push(`## ${REVIEW_SIGNATURE}`);
  parts.push("");

  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of review.findings) {
    counts[f.severity]++;
  }

  const stats: string[] = [];
  if (counts.high > 0) stats.push(`🔴 **${counts.high} High**`);
  if (counts.medium > 0) stats.push(`🟡 **${counts.medium} Medium**`);
  if (counts.low > 0) stats.push(`🔵 **${counts.low} Low**`);
  if (stats.length === 0) stats.push("✅ **No issues found**");
  parts.push(stats.join(" | "));
  parts.push("");

  if (review.summary) {
    parts.push("### Summary");
    parts.push(review.summary);
    parts.push("");
  }

  const unposted = review.findings.filter((f) => !postedFindings.has(f));
  if (unposted.length > 0) {
    parts.push("---");
    parts.push("### Findings not posted inline");
    parts.push("");
    for (let i = 0; i < unposted.length; i++) {
      const f = unposted[i];
      const sevBadge = severityBadgeMap[f.severity];
      const confLabel = confidenceLabelMap[f.confidence];
      parts.push(`${sevBadge} **${i + 1}** — \`${f.file}:${f.line}\` · 🎯 ${confLabel}`);
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

  parts.push("---");
  parts.push("*[Livvie Code Review](https://github.com/4itworks/livvie-code-review)*");

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
