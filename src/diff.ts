import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import type { DiffFile } from "./types.js";
import { mapWithConcurrency } from "./concurrency.js";
import { extractChangedLines } from "./truncation.js";

export interface FileContentsResult {
  contents: Map<string, string>;
  failed: string[];
}

export async function fetchDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  maxDiffSize: number,
): Promise<DiffFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const result: DiffFile[] = [];

  for (const file of files) {
    if (!file.patch) continue;

    const patchSize = file.patch.length;
    if (patchSize > maxDiffSize) {
      core.warning(
        `Skipping ${file.filename}: patch size ${patchSize} exceeds max-diff-size ${maxDiffSize}`,
      );
      continue;
    }

    result.push({
      filename: file.filename,
      patch: file.patch,
      additions: file.additions,
      deletions: file.deletions,
      status: (file.status as DiffFile["status"]) ?? "modified",
    });
  }

  return result;
}

export async function fetchFileContentsParallel(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  files: DiffFile[],
  concurrency: number,
): Promise<FileContentsResult> {
  const contents = new Map<string, string>();
  const failed: string[] = [];

  const filesToFetch = files.filter((file) => file.status !== "removed");

  const results = await mapWithConcurrency(
    filesToFetch,
    async (file) => {
      try {
        const response = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: file.filename,
          ref,
        });

        if ("content" in response.data && response.data.content) {
          const text = Buffer.from(response.data.content, "base64").toString("utf8");
          const changedLines = extractChangedLines(file.patch);
          const numbered = text
            .split("\n")
            .map((line, i) => {
              const lineNum = i + 1;
              const marker = changedLines.has(lineNum) ? " →" : "";
              return `${lineNum}:${marker} ${line}`;
            })
            .join("\n");
          return { filename: file.filename, content: numbered, ok: true as const };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        core.warning(`Could not fetch content for ${file.filename}: ${msg}`);
      }
      return { filename: file.filename, content: "", ok: false as const };
    },
    concurrency,
  );

  for (const { filename, content, ok } of results) {
    if (ok && content) {
      contents.set(filename, content);
    } else {
      failed.push(filename);
    }
  }

  return { contents, failed };
}

export function isLineInDiff(patch: string, targetLine: number): boolean {
  if (!patch) return false;

  let currentLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        currentLine = parseInt(match[1], 10);
      }
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("\\")) continue;

    if (line.startsWith("+")) {
      if (currentLine === targetLine) return true;
      currentLine++;
    } else if (line.startsWith("-")) {
      // removed line, don't advance
    } else {
      // context line — advance but don't accept as target
      currentLine++;
    }
  }

  return false;
}
