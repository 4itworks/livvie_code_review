import { Octokit } from "@octokit/rest";
import type { DiffFile } from "./types.js";

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

export function formatDiffForPrompt(files: DiffFile[]): string {
  const parts: string[] = [];

  for (const file of files) {
    parts.push(`## ${file.filename}`);
    parts.push("```diff");
    parts.push(file.patch);
    parts.push("```");
    parts.push("");
  }

  return parts.join("\n");
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
      if (currentLine === targetLine) return true;
      currentLine++;
    }
  }

  return false;
}
