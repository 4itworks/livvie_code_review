import { Octokit } from "@octokit/rest";
import type { DiffFile } from "./types.js";
import { mapWithConcurrency } from "./concurrency.js";
import { extractChangedLines } from "./truncation.js";

export async function fetchDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  maxDiffSize: number
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
      result.push({
        filename: file.filename,
        patch: file.patch.slice(0, maxDiffSize) + "\n... (truncated)",
        additions: file.additions,
        deletions: file.deletions,
      });
    } else {
      result.push({
        filename: file.filename,
        patch: file.patch,
        additions: file.additions,
        deletions: file.deletions,
      });
    }
  }

  return result;
}

export async function fetchFileContentsParallel(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  files: DiffFile[],
  concurrency: number
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();

  const results = await mapWithConcurrency(
    files,
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
          return { filename: file.filename, content: numbered };
        }
      } catch {
        // File might be deleted or binary — skip
      }
      return { filename: file.filename, content: "" };
    },
    concurrency
  );

  for (const { filename, content } of results) {
    if (content) {
      contents.set(filename, content);
    }
  }

  return contents;
}

export function extractDiffHunks(patch: string): Array<{
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  content: string;
}> {
  const hunks: Array<{
    oldStart: number;
    newStart: number;
    oldLines: number;
    newLines: number;
    content: string;
  }> = [];

  const lines = patch.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

    if (match) {
      const oldStart = parseInt(match[1], 10);
      const oldLines = match[2] ? parseInt(match[2], 10) : 1;
      const newStart = parseInt(match[3], 10);
      const newLines = match[4] ? parseInt(match[4], 10) : 1;

      const contentLines: string[] = [line];
      i++;

      while (i < lines.length && !lines[i].startsWith("@@")) {
        contentLines.push(lines[i]);
        i++;
      }

      hunks.push({
        oldStart,
        newStart,
        oldLines,
        newLines,
        content: contentLines.join("\n"),
      });
    } else {
      i++;
    }
  }

  return hunks;
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
