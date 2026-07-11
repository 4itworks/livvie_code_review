import * as core from "@actions/core";
import type { ReviewFinding } from "./types.js";

const OPENERS = new Set(["{", "[", "("]);
const CLOSERS: Record<string, string> = {
  "}": "{",
  "]": "[",
  ")": "(",
};

export function isSuggestionBalanced(code: string): boolean {
  const stack: string[] = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    const ch = code[i];
    const next = i + 1 < len ? code[i + 1] : "";

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && code[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(code[i] === "*" && i + 1 < len && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const triple = code.slice(i, i + 3) === quote.repeat(3);
      if (triple) {
        const close = quote.repeat(3);
        i += 3;
        while (i < len) {
          if (code.slice(i, i + 3) === close) {
            i += 3;
            break;
          }
          if (code[i] === "\\") {
            i += 2;
            continue;
          }
          i++;
        }
        continue;
      }
      i++;
      while (i < len) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i++;
          break;
        }
        if (code[i] === "\n") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "`") {
      i++;
      while (i < len) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === "`") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (OPENERS.has(ch)) {
      stack.push(ch);
    } else if (CLOSERS[ch]) {
      const opener = stack.pop();
      if (opener !== CLOSERS[ch]) {
        return false;
      }
    }

    i++;
  }

  return stack.length === 0;
}

export function validateSuggestion(finding: ReviewFinding): ReviewFinding {
  if (!finding.suggestion) {
    return finding;
  }

  if (!isSuggestionBalanced(finding.suggestion)) {
    core.warning(
      `Stripped unbalanced suggestion for ${finding.file}:${finding.line} — ` +
        `braces/brackets/parentheses do not match. The finding description is kept.`,
    );
    return { ...finding, suggestion: null, suggestionStartLine: null };
  }

  return finding;
}
