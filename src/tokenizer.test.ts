import { describe, it, expect } from "vitest";

import { countTokens, calculateTokenBudget, PER_FILE_OVERHEAD_TOKENS } from "./tokenizer.js";

// ---------------------------------------------------------------------------
// PER_FILE_OVERHEAD_TOKENS constant
// ---------------------------------------------------------------------------
describe("PER_FILE_OVERHEAD_TOKENS", () => {
  it("is 100", () => {
    expect(PER_FILE_OVERHEAD_TOKENS).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------
describe("countTokens", () => {
  it("empty string → 0", () => {
    expect(countTokens("")).toBe(0);
  });

  it("short text → positive number", () => {
    const result = countTokens("Hello world");
    expect(result).toBeGreaterThan(0);
  });

  it("longer text → more tokens than shorter text", () => {
    const short = countTokens("hello");
    const long = countTokens(
      "This is a much longer piece of text that should produce more tokens than the short one.",
    );
    expect(long).toBeGreaterThan(short);
  });
});

// ---------------------------------------------------------------------------
// calculateTokenBudget
// ---------------------------------------------------------------------------
describe("calculateTokenBudget", () => {
  it("normal values → correct fileBudget calculation", () => {
    const budget = calculateTokenBudget(128000, 4096, 2000, 1000, 500, 1000, 0);
    // fileBudget = 128000 - 4096 - 2000 - 1000 - 500 - 1000 - 0 = 119404
    expect(budget.contextWindow).toBe(128000);
    expect(budget.maxOutput).toBe(4096);
    expect(budget.systemPromptTokens).toBe(2000);
    expect(budget.reviewInstructionsTokens).toBe(1000);
    expect(budget.crossFileHunksTokens).toBe(500);
    expect(budget.safetyMargin).toBe(1000);
    expect(budget.fileBudget).toBe(119404);
  });

  it("insufficient budget (negative fileBudget) → throws Error", () => {
    expect(() => calculateTokenBudget(1000, 4096, 2000, 1000, 500, 1000, 0)).toThrow(Error);
  });

  it("zero context window → throws", () => {
    expect(() => calculateTokenBudget(0, 4096, 2000, 1000, 500, 1000, 0)).toThrow(Error);
  });

  it("large context window → large fileBudget", () => {
    const budget = calculateTokenBudget(1_000_000, 4096, 2000, 1000, 500, 1000, 0);
    expect(budget.fileBudget).toBeGreaterThan(900_000);
  });
});
