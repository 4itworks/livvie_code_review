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
      process.env.GITHUB_EVENT_PATH
        ? fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
        : "{}"
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
    const reviewInstructionsFile = core.getInput("review-instructions-file") || ".github/code-reviewer.md";
    const prBaseRef = context.pull_request?.base?.ref ?? "main";

    const octokit = new Octokit({ auth: githubToken });
    const reviewInstructions = await loadReviewInstructions(
      octokit,
      owner,
      repo,
      prBaseRef,
      reviewInstructionsFile
    );

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
      maxOutputTokens: parseInt(core.getInput("max-output-tokens") || "16000", 10),
      reasoningEffort: core.getInput("reasoning-effort") || "none",
      maxDiffSize: parseInt(core.getInput("max-diff-size") || "50000", 10),
      maxBatches: parseInt(core.getInput("max-batches") || "0", 10),
      contextWindow: parseInt(core.getInput("context-window") || "128000", 10),
      ignorePatterns: parseIgnorePatterns(
        core.getInput("ignore-patterns") ||
          "*.g.dart,*.freezed.dart,*.mocks.dart,*.gen.dart,build/**,dist/**"
      ),
      perspectives: parsePerspectivesInput(core.getInput("perspectives") || "generalist"),
      reviewInstructions,
      requestChangesOnHigh: core.getInput("request-changes-on-high") !== "false",
      maxComments: parseInt(core.getInput("max-comments") || "25", 10),
      fetchConcurrency: 5,
      llmConcurrency: 3,
    };

    core.info(`Reviewing PR #${pullNumber} in ${owner}/${repo}`);
    core.info(`Perspectives: ${config.perspectives.join(", ")}`);
    core.info(`Max batches: ${config.maxBatches || "unlimited"}`);

    const reviewId = await runPipeline(config);
    if (reviewId > 0) {
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
  filePath: string
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
