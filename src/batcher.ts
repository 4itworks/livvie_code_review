import type { DiffFile, PreparedFile, Batch, TokenBudget } from "./types.js";
import * as core from "@actions/core";
import { countTokens } from "./tokenizer.js";
import { progressiveTruncate } from "./truncation.js";
import { buildCrossFileContext } from "./cross-file.js";

function getDirectory(filename: string): string {
  const lastSlash = filename.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return filename.substring(0, lastSlash);
}

function formatFileSection(file: PreparedFile): string {
  const parts: string[] = [];
  parts.push(`### ${file.filename} (${file.additions}+, ${file.deletions}-)`);
  parts.push("Full file with line numbers. Lines marked with \u2192 were changed in this PR.");
  parts.push("");
  parts.push("```");
  parts.push(file.content);
  parts.push("```");
  parts.push("");
  return parts.join("\n");
}

export function prepareFiles(
  files: DiffFile[],
  fileContents: Map<string, string>,
  tokenBudget: TokenBudget,
): PreparedFile[] {
  const prepared: PreparedFile[] = [];

  for (const file of files) {
    const rawContent = fileContents.get(file.filename) ?? "";
    let content = rawContent;
    let truncated = false;

    if (content && countTokens(content) > tokenBudget.fileBudget) {
      const result = progressiveTruncate(content, file.patch, tokenBudget.fileBudget);
      content = result.content;
      truncated = true;
    }

    const tempFile: PreparedFile = {
      filename: file.filename,
      patch: file.patch,
      additions: file.additions,
      deletions: file.deletions,
      content,
      tokenCount: 0,
      truncated,
      directory: getDirectory(file.filename),
    };

    tempFile.tokenCount = countTokens(formatFileSection(tempFile));
    prepared.push(tempFile);
  }

  return prepared;
}

export function binPackFiles(
  preparedFiles: PreparedFile[],
  tokenBudget: TokenBudget,
  maxBatches: number,
): Batch[] {
  const sorted = [...preparedFiles].sort((a, b) =>
    a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0,
  );

  const batches: Batch[] = [];
  const directoryBatchIndex = new Map<string, number>();

  for (const file of sorted) {
    let targetBatch: Batch | null = null;

    const dirIndex = directoryBatchIndex.get(file.directory);
    if (dirIndex !== undefined && dirIndex < batches.length) {
      const candidate = batches[dirIndex];
      if (candidate.tokenCount + file.tokenCount <= tokenBudget.fileBudget) {
        targetBatch = candidate;
      }
    }

    if (!targetBatch) {
      for (const batch of batches) {
        if (batch.tokenCount + file.tokenCount <= tokenBudget.fileBudget) {
          targetBatch = batch;
          break;
        }
      }
    }

    if (targetBatch) {
      targetBatch.files.push(file);
      targetBatch.tokenCount += file.tokenCount;
      directoryBatchIndex.set(file.directory, targetBatch.index);
      continue;
    }

    if (maxBatches > 0 && batches.length >= maxBatches) {
      const lastBatch = batches[batches.length - 1];
      if (lastBatch.tokenCount + file.tokenCount > tokenBudget.fileBudget * 2) {
        core.warning(
          `Batch ${lastBatch.index} overflow: ${lastBatch.tokenCount} + ${file.tokenCount} tokens exceeds 2x budget (${tokenBudget.fileBudget}). ` +
            `File ${file.filename} may cause LLM truncation. Consider increasing max-batches.`,
        );
      }
      lastBatch.files.push(file);
      lastBatch.tokenCount += file.tokenCount;
      continue;
    }

    const newBatch: Batch = {
      index: batches.length,
      files: [file],
      tokenCount: file.tokenCount,
      crossFileContext: "",
      totalTokenCount: file.tokenCount,
    };
    batches.push(newBatch);
    directoryBatchIndex.set(file.directory, newBatch.index);
  }

  return batches;
}

export function assignCrossFileContext(batches: Batch[], tokenBudget: TokenBudget): void {
  for (const batch of batches) {
    const crossContext = buildCrossFileContext(batches, batch, tokenBudget.crossFileHunksTokens);
    batch.crossFileContext = crossContext;
    batch.totalTokenCount = batch.tokenCount + countTokens(crossContext);
  }
}

export function createBatches(
  files: DiffFile[],
  fileContents: Map<string, string>,
  tokenBudget: TokenBudget,
  maxBatches: number,
): Batch[] {
  const prepared = prepareFiles(files, fileContents, tokenBudget);
  const batches = binPackFiles(prepared, tokenBudget, maxBatches);
  assignCrossFileContext(batches, tokenBudget);
  return batches;
}
