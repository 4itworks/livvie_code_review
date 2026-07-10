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

export async function fetchFileContents(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  files: DiffFile[]
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();

  for (const file of files) {
    try {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: file.filename,
        ref,
      });

      if ("content" in response.data && response.data.content) {
        const text = Buffer.from(response.data.content, "base64").toString("utf8");
        const numbered = text
          .split("\n")
          .map((line, i) => `${i + 1}: ${line}`)
          .join("\n");
        contents.set(file.filename, numbered);
      }
    } catch {
      // File might be deleted or binary — skip
    }
  }

  return contents;
}

export function formatDiffForPrompt(files: DiffFile[], fileContents: Map<string, string>): string {
  const parts: string[] = [];

  for (const file of files) {
    parts.push(`## ${file.filename}`);
    parts.push("");

    const content = fileContents.get(file.filename);
    if (content) {
      parts.push("### Full file (with line numbers)");
      parts.push("```");
      parts.push(content);
      parts.push("```");
      parts.push("");
    }

    parts.push("### Diff");
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
