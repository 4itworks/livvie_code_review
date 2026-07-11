import type { Batch } from "./types.js";
import { countTokens } from "./tokenizer.js";
import { truncateTextToBudget } from "./truncation.js";

function compactHunkSummary(patch: string): string {
  if (!patch) return "";
  const lines: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("+") || line.startsWith("-")) {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

export function buildCrossFileContext(
  allBatches: Batch[],
  currentBatch: Batch,
  maxTokens: number,
): string {
  const otherBatches = allBatches.filter((b) => b.index !== currentBatch.index);
  if (otherBatches.length === 0) return "";

  const parts: string[] = [];
  let tokenCount = 0;
  let skippedAny = false;

  for (const batch of otherBatches) {
    for (const file of batch.files) {
      const header = `### ${file.filename} (in batch ${batch.index} — context only, do not review)`;
      const wrapperTokens = countTokens(`${header}\n\`\`\`diff\n\n\`\`\`\n`);
      const remaining = maxTokens - tokenCount;

      if (remaining <= 0) {
        skippedAny = true;
        break;
      }

      if (wrapperTokens > remaining) {
        skippedAny = true;
        continue;
      }

      const summaryBudget = remaining - wrapperTokens;
      let summary = compactHunkSummary(file.patch);
      let truncated = false;
      const truncatedMarker = "\n// ... (truncated)";
      const markerTokens = countTokens(truncatedMarker);

      if (countTokens(summary) > summaryBudget) {
        const result = truncateTextToBudget(summary, Math.max(0, summaryBudget - markerTokens));
        summary = result.content;
        truncated = result.truncated;
      }

      const section = `${header}\n\`\`\`diff\n${summary}${truncated ? truncatedMarker : ""}\n\`\`\`\n`;
      const sectionTokens = countTokens(section);
      if (tokenCount + sectionTokens > maxTokens) {
        skippedAny = true;
        continue;
      }

      parts.push(section);
      tokenCount += sectionTokens;
    }
  }

  if (skippedAny && parts.length > 0) {
    parts.push("// ... (cross-file context truncated) ...");
  }

  return parts.join("\n");
}
