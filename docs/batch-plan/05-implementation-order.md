# Section 5: Implementation Order (Dependency Graph)

## Dependency Graph

```
Layer 0 (no deps — implement first)
├── src/types.ts (type definitions)
├── src/concurrency.ts (Semaphore, pMap, pMapSafe)
├── src/ignore-patterns.ts (shouldIgnoreFile, DEFAULT_IGNORE_PATTERNS)
└── src/circuit-breaker.ts (CircuitBreakerState, backoff, retry-after)

Layer 1 (depends on Layer 0)
├── src/tokenizer.ts (countTokens, computeTokenBudget — no code deps, but needed by Layer 2)
└── src/diff.ts modifications (extractChangedLines export, fetchFileContentsParallel — depends on concurrency.ts)

Layer 2 (depends on Layer 1)
├── src/truncation.ts (truncateFileToWindow, truncateToBudget — depends on tokenizer.ts, diff.ts extractChangedLines)
├── src/cross-file.ts (extractDiffHunks, buildCrossFileContext — depends on tokenizer.ts, types.ts)
└── src/prompt-builder.ts (buildBatchUserMessage, formatFileForPrompt — depends on types.ts)

Layer 3 (depends on Layer 2)
├── src/batcher.ts (createBatches — depends on tokenizer.ts, truncation.ts, cross-file.ts, types.ts)
└── src/llm.ts modifications (reviewBatch — depends on circuit-breaker.ts, concurrency.ts, types.ts)

Layer 4 (depends on Layer 3)
├── src/consolidation.ts (consolidateResults, deduplicateFindings, sortFindings, mergeSummaries — depends on types.ts)
└── src/post.ts modifications (accept ConsolidatedReview — depends on types.ts)

Layer 5 (depends on Layer 4)
├── src/pipeline.ts (runPipeline + stage functions — depends on ALL)
└── prompts/review-batch-system.md (updated system prompt)

Layer 6 (depends on Layer 5)
├── src/index.ts (slim entry point — delegates to pipeline.ts)
├── action.yml (new inputs)
└── package.json (gpt-tokenizer dep)
```

## Step-by-Step Implementation Order

### Step 1: Install dependency + type definitions
```bash
cd C:\Users\joaoc\StudioProjects\livvie-code-review
npm install gpt-tokenizer
```

### Step 2: Update `src/types.ts`
Add all new types from `01-types.md`. No breaking changes to existing types.

### Step 3: Create `src/concurrency.ts`
Implement `Semaphore`, `pMap`, `pMapSafe`. Pure TypeScript, no imports.

### Step 4: Create `src/ignore-patterns.ts`
Implement `shouldIgnoreFile()` + `DEFAULT_IGNORE_PATTERNS`. Pure TypeScript.

### Step 5: Create `src/circuit-breaker.ts`
Implement circuit breaker state + backoff + Retry-After parsing. Pure TypeScript.

### Step 6: Create `src/tokenizer.ts`
Implement `countTokens()` using `gpt-tokenizer`, `computeTokenBudget()`, `getDefaultContextWindow()`.

### Step 7: Modify `src/diff.ts`
- Export `extractChangedLines`
- Replace `fetchFileContents` with `fetchFileContentsParallel` (uses `pMapSafe`)
- Remove `formatDiffForPrompt` (moved to prompt-builder.ts)
- Keep `fetchDiff`, `isLineInDiff` unchanged

### Step 8: Create `src/truncation.ts`
Implement truncation with window reduction (10→5→diff-only). Depends on tokenizer + diff.extractChangedLines.

### Step 9: Create `src/cross-file.ts`
Implement `extractDiffHunks`, `buildCrossFileContext`, `countCrossFileTokens`. Depends on tokenizer.

### Step 10: Create `src/prompt-builder.ts`
Implement `buildBatchUserMessage`, `formatFileForPrompt`. Depends on types only.

### Step 11: Create `src/batcher.ts`
Implement `createBatches` with bin-packing + directory grouping. Depends on tokenizer, truncation, cross-file.

### Step 12: Modify `src/llm.ts`
- Remove `buildUserMessage` (moved to prompt-builder)
- Change `reviewWithLLM` to accept pre-built `userMessage`
- Add `reviewBatch` wrapper with circuit breaker + semaphore
- Replace linear backoff with exponential + jitter + Retry-After

### Step 13: Create `src/consolidation.ts`
Implement dedup, sort, cap, merge summaries. Depends on types only.

### Step 14: Modify `src/post.ts`
- Change `postReview` to accept `ConsolidatedReview`
- Cap at 100 inline comments
- Add unreviewed files section to review body

### Step 15: Create `prompts/review-batch-system.md`
Updated system prompt with batch context note, removed diff patch references.

### Step 16: Create `src/pipeline.ts`
Implement `runPipeline` + all stage functions. Depends on everything.

### Step 17: Modify `src/index.ts`
Slim down to read inputs + call `runPipeline`. Move `loadReviewInstructions` here or to pipeline.

### Step 18: Update `action.yml`
Add `ignore-patterns`, `max-batches`, `context-window` inputs.

### Step 19: Update `package.json`
Add `gpt-tokenizer` dependency.

### Step 20: Build + verify
```bash
npm run build  # ncc build
npm run typecheck  # tsc --noEmit
```

### Step 21: Spawn self-review subagents
See `06-self-review.md`.

### Step 22: Verification
See `07-verification.md`.
