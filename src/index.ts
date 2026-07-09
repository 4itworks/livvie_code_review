import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import { Octokit } from "@octokit/rest";
import { fetchDiff, formatDiffForPrompt } from "./diff.js";
import { reviewWithLLM } from "./llm.js";
import { postReview } from "./post.js";

async function run(): Promise<void> {
  try {
    const githubToken = core.getInput("github-token", { required: true });
    const llmApiKey = core.getInput("llm-api-key", { required: true });
    const llmBaseUrl = core.getInput("llm-base-url", { required: true });
    const model = core.getInput("model", { required: true });
    const reviewInstructionsFile = core.getInput("review-instructions-file");
    const maxDiffSize = parseInt(core.getInput("max-diff-size") || "50000", 10);
    const maxOutputTokens = parseInt(core.getInput("max-output-tokens") || "16000", 10);
    const requestChangesOnHigh = core.getInput("request-changes-on-high") !== "false";
    const maxComments = parseInt(core.getInput("max-comments") || "25", 10);

    const context = JSON.parse(process.env.GITHUB_EVENT_PATH ? fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8") : "{}");
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

    core.info(`Reviewing PR #${pullNumber} in ${owner}/${repo}`);

    const octokit = new Octokit({ auth: githubToken });

    const files = await fetchDiff(octokit, owner, repo, pullNumber, maxDiffSize);

    if (files.length === 0) {
      core.info("No files with diffs found, skipping");
      return;
    }

    core.info(`Found ${files.length} files with diffs`);

    const diffText = formatDiffForPrompt(files);
    const systemPrompt = loadSystemPrompt();
    const reviewInstructions = await loadReviewInstructions(octokit, owner, repo, context.pull_request.base.ref, reviewInstructionsFile);

    const review = await reviewWithLLM(
      llmApiKey,
      llmBaseUrl,
      model,
      systemPrompt,
      diffText,
      reviewInstructions,
      maxOutputTokens
    );

    core.info(`Review complete: ${review.findings.length} findings`);

    await postReview(octokit, owner, repo, pullNumber, review, files, requestChangesOnHigh, maxComments);

    core.info("Done");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

function loadSystemPrompt(): string {
  const promptPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "prompts", "review-system.md");
  return fs.readFileSync(promptPath, "utf8");
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
