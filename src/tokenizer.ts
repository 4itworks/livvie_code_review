import { encode } from "gpt-tokenizer";
import type { TokenBudget } from "./types.js";

export const PER_FILE_OVERHEAD_TOKENS = 100;

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

export function calculateTokenBudget(
  contextWindow: number,
  maxOutput: number,
  systemPromptTokens: number,
  reviewInstructionsTokens: number,
  crossFileHunksTokens: number
): TokenBudget {
  const safetyMargin = 500;
  const fileBudget =
    contextWindow -
    maxOutput -
    systemPromptTokens -
    reviewInstructionsTokens -
    crossFileHunksTokens -
    safetyMargin;

  if (fileBudget <= 0) {
    throw new Error(
      `Token budget insufficient: contextWindow=${contextWindow}, maxOutput=${maxOutput}, ` +
        `systemPrompt=${systemPromptTokens}, reviewInstructions=${reviewInstructionsTokens}, ` +
        `crossFileHunks=${crossFileHunksTokens}, safetyMargin=${safetyMargin} ` +
        `→ fileBudget=${fileBudget}. Reduce input sizes or increase context-window.`
    );
  }

  return {
    contextWindow,
    maxOutput,
    systemPromptTokens,
    reviewInstructionsTokens,
    crossFileHunksTokens,
    safetyMargin,
    fileBudget,
  };
}
