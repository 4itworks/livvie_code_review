import * as core from "@actions/core";
import * as fs from "fs";
import { Octokit } from "@octokit/rest";
import { runPipeline } from "./pipeline.js";
import type { PipelineConfig } from "./types.js";
import { parseIgnorePatterns } from "./ignore-patterns.js";
import { parsePerspectivesInput } from "./perspectives.js";

async function run(): Promise<void> {
  try {
    const context = JSON.parse(
      process.env.GITHUB_EVENT_PATH ? fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8") : "{}",
    );
    const pullNumber = context.pull_request?.number;
    if (!pullNumber) {
      core.info("No pull request in event, skipping");
      return;
    }

    const owner = context.repository?.owner?.login;
    const repo = context.repository?.name;
    if (!owner || !repo) {
      throw new Error("Could not determine repository owner/name");
    }

    const githubToken = core.getInput("github-token", { required: true });
    const reviewInstructionsFile =
      core.getInput("review-instructions-file") || ".github/code-reviewer.md";
    const prBaseRef = context.pull_request?.base?.ref ?? "main";

    const octokit = new Octokit({ auth: githubToken });
    const reviewInstructions = await loadReviewInstructions(
      octokit,
      owner,
      repo,
      prBaseRef,
      reviewInstructionsFile,
    );

    function parsePositiveInt(value: string, name: string, defaultValue: number): number {
      const parsed = parseInt(value || String(defaultValue), 10);
      if (isNaN(parsed) || parsed < 0) {
        throw new Error(`Invalid value for ${name}: "${value}". Must be a non-negative integer.`);
      }
      return parsed;
    }

    const config: PipelineConfig = {
      githubToken,
      owner,
      repo,
      pullNumber,
      prHeadRef: context.pull_request?.head?.ref ?? "",
      prBaseRef,
      llmApiKey: core.getInput("llm-api-key", { required: true }),
      llmBaseUrl: core.getInput("llm-base-url", { required: true }),
      model: core.getInput("model", { required: true }),
      fallbackModel: core.getInput("fallback-model") || "",
      maxOutputTokens: parsePositiveInt(
        core.getInput("max-output-tokens"),
        "max-output-tokens",
        16000,
      ),
      reasoningEffort: core.getInput("reasoning-effort") || "none",
      maxDiffSize: parsePositiveInt(core.getInput("max-diff-size"), "max-diff-size", 50000),
      maxBatches: parsePositiveInt(core.getInput("max-batches"), "max-batches", 0),
      contextWindow: parsePositiveInt(core.getInput("context-window"), "context-window", 128000),
      ignorePatterns: parseIgnorePatterns(
        core.getInput("ignore-patterns") || "build/**,dist/**,node_modules/**",
      ),
      perspectives: parsePerspectivesInput(core.getInput("perspectives") || "generalist"),
      reviewInstructions,
      requestChangesOnHigh: core.getInput("request-changes-on-high") !== "false",
      maxComments: parsePositiveInt(core.getInput("max-comments"), "max-comments", 25),
      fetchConcurrency: 5,
      llmConcurrency: 3,
    };

    core.setSecret(config.githubToken);
    core.setSecret(config.llmApiKey);
    const verbose = core.getInput("verbose") === "true";
    process.env.LIVVIE_VERBOSE = verbose ? "1" : "";

    core.info(`Reviewing PR #${pullNumber} in ${owner}/${repo}`);
    core.info(`Perspectives: ${config.perspectives.join(", ")}`);
    core.info(`Max batches: ${config.maxBatches || "unlimited"}`);

    const { reviewId, findingCount } = await runPipeline(config);
    if (reviewId > 0) {
      core.setOutput("review-id", String(reviewId));
      core.setOutput("finding-count", String(findingCount));
      core.info(`Posted review #${reviewId}`);
    }
    core.info("Done");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

async function loadReviewInstructions(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
): Promise<string> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref,
    });

    if ("content" in response.data && response.data.content) {
      return Buffer.from(response.data.content, "base64").toString("utf8");
    }
  } catch {
    core.info(`No review instructions file found at ${filePath}`);
  }

  return "";
}

run();
