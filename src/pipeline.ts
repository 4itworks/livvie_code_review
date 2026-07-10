import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import type {
  PipelineConfig,
  Batch,
  Perspective,
  ReviewMatrixResult,
} from "./types.js";
import { fetchDiff, fetchFileContentsParallel } from "./diff.js";
import { filterIgnoredFiles } from "./ignore-patterns.js";
import { countTokens, calculateTokenBudget } from "./tokenizer.js";
import { createBatches } from "./batcher.js";
import { getPerspectives } from "./perspectives.js";
import { createSemaphore, mapWithConcurrency } from "./concurrency.js";
import { createCircuitBreaker } from "./circuit-breaker.js";
import { reviewBatchFromPerspective, type LLMCallConfig } from "./llm-batch.js";
import { consolidateReviews } from "./consolidation.js";
import { postReview } from "./post.js";

export async function runPipeline(config: PipelineConfig): Promise<{ reviewId: number; findingCount: number }> {
  const octokit = new Octokit({ auth: config.githubToken });

  core.startGroup("Stage 1: Fetch");
  const allFiles = await fetchDiff(
    octokit,
    config.owner,
    config.repo,
    config.pullNumber,
    config.maxDiffSize
  );
  if (allFiles.length === 0) {
    core.info("No files with diffs");
    core.endGroup();
    return { reviewId: 0, findingCount: 0 };
  }

  const { kept: files, ignored } = filterIgnoredFiles(allFiles, config.ignorePatterns);
  if (ignored.length > 0) {
    core.info(`Ignored ${ignored.length} generated files: ${ignored.map((f) => f.filename).join(", ")}`);
  }
  if (files.length === 0) {
    core.info("All files ignored");
    core.endGroup();
    return { reviewId: 0, findingCount: 0 };
  }

  core.info(`Fetching contents for ${files.length} files (concurrency ${config.fetchConcurrency})...`);
  const fileContents = await fetchFileContentsParallel(
    octokit,
    config.owner,
    config.repo,
    config.prHeadRef,
    files,
    config.fetchConcurrency
  );
  core.info(`Fetched ${fileContents.size}/${files.length} file contents`);
  core.endGroup();

  core.startGroup("Stage 2: Batching");
  const perspectives = getPerspectives(config.perspectives);
  const maxSystemPromptTokens = Math.max(
    ...perspectives.map((p) => countTokens(p.systemPrompt))
  );
  const reviewInstructionsTokens = countTokens(config.reviewInstructions);
  const crossFileHunksTokens = Math.min(2000, Math.floor(config.contextWindow * 0.05));
  const tokenBudget = calculateTokenBudget(
    config.contextWindow,
    config.maxOutputTokens,
    maxSystemPromptTokens,
    reviewInstructionsTokens,
    crossFileHunksTokens
  );
  const batches = createBatches(files, fileContents, tokenBudget, config.maxBatches);
  core.info(`Created ${batches.length} batches for ${files.length} files`);
  for (const b of batches) {
    core.info(`  Batch ${b.index}: ${b.files.length} files, ${b.totalTokenCount} tokens`);
  }
  core.endGroup();

  core.startGroup("Stage 3: Review (matrix)");
  const semaphore = createSemaphore(config.llmConcurrency);
  const circuitBreaker = createCircuitBreaker(3);
  const llmConfig: LLMCallConfig = {
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
    model: config.model,
    fallbackModel: config.fallbackModel,
    maxOutputTokens: config.maxOutputTokens,
    reasoningEffort: config.reasoningEffort,
    reviewInstructions: config.reviewInstructions,
    semaphore,
    circuitBreaker,
    maxRetries: 3,
  };

  const matrixCalls: Array<{ batch: Batch; perspective: Perspective }> = [];
  for (const batch of batches) {
    for (const perspective of perspectives) {
      matrixCalls.push({ batch, perspective });
    }
  }
  core.info(
    `Matrix: ${batches.length} batches × ${perspectives.length} perspectives = ${matrixCalls.length} LLM calls`
  );

  const results = await mapWithConcurrency(
    matrixCalls,
    ({ batch, perspective }) => {
      core.info(`  Reviewing batch ${batch.index} as ${perspective.name}...`);
      return reviewBatchFromPerspective(batch, perspective, llmConfig);
    },
    config.llmConcurrency
  );

  const failedBatches = Array.from(new Set(
    results.filter((r) => r.error && !r.review.findings.length).map((r) => r.batchIndex)
  ));
  const unreviewedFiles = batches
    .filter((b) => failedBatches.includes(b.index))
    .flatMap((b) => b.files.map((f) => f.filename));

  const matrixResult: ReviewMatrixResult = {
    results,
    rawFindings: results.flatMap((r) => r.review.findings),
    failedBatches,
    unreviewedFiles,
    totalCalls: matrixCalls.length,
    successfulCalls: results.filter((r) => !r.error).length,
  };
  core.info(
    `Review complete: ${matrixResult.successfulCalls}/${matrixResult.totalCalls} calls succeeded, ${matrixResult.rawFindings.length} raw findings`
  );
  core.endGroup();

  core.startGroup("Stage 4: Consolidation");
  const consolidated = consolidateReviews(matrixResult, perspectives);
  core.info(
    `Consolidated: ${consolidated.findings.length} findings (after dedup), ${consolidated.stats.high} high, ${consolidated.stats.medium} medium, ${consolidated.stats.low} low`
  );
  if (consolidated.unreviewedFiles.length > 0) {
    core.warning(`Unreviewed files: ${consolidated.unreviewedFiles.join(", ")}`);
  }
  core.endGroup();

  core.startGroup("Stage 5: Post");
  const reviewId = await postReview(
    octokit,
    config.owner,
    config.repo,
    config.pullNumber,
    consolidated,
    files,
    config.requestChangesOnHigh,
    config.maxComments
  );
  core.endGroup();

  return { reviewId, findingCount: consolidated.findings.length };
}
