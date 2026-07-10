import type { Batch } from "./types.js";
import { countTokens } from "./tokenizer.js";

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
  maxTokens: number
): string {
  const otherBatches = allBatches.filter((b) => b.index !== currentBatch.index);
  if (otherBatches.length === 0) return "";

  const parts: string[] = [];
  let tokenCount = 0;

  for (const batch of otherBatches) {
    for (const file of batch.files) {
      const header = `### ${file.filename} (in batch ${batch.index} — context only, do not review)`;
      const summary = compactHunkSummary(file.patch);
      const section = `${header}\n\`\`\`diff\n${summary}\n\`\`\`\n`;
      const sectionTokens = countTokens(section);

      if (tokenCount + sectionTokens > maxTokens) {
        return parts.join("\n");
      }

      parts.push(section);
      tokenCount += sectionTokens;
    }
  }

  return parts.join("\n");
}
