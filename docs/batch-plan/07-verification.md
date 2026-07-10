# Section 7: Verification Strategy

## Build Verification

```bash
cd C:\Users\joaoc\StudioProjects\livvie-code-review
npm install                  # install gpt-tokenizer
npm run typecheck           # tsc --noEmit — zero errors
npm run build               # ncc build — produces dist/index.js
```

**Pass criteria:** Both commands exit 0 with no errors.

---

## Unit Test Scenarios (manual or automated)

Since the project has no test framework currently, verify by inspection + manual testing. If a test framework is added later, these are the test cases:

### Tokenizer
| Test | Input | Expected |
|---|---|---|
| Count empty string | `""` | `0` |
| Count "hello world" | `"hello world"` | `~2` tokens |
| Budget computation | context=128000, maxOutput=16000, systemPrompt=~500 tokens, reviewInstructions=0, crossFile=0, safety=500 | `availableForFiles = 128000 - 16000 - 500 - 0 - 0 - 500 = 111000` |

### Ignore Patterns
| Test | Input | Expected |
|---|---|---|
| Match *.g.dart | `"src/models/user.g.dart"`, `["*.g.dart"]` | `true` (ignore) |
| Match build/** | `"build/output.js"`, `["build/**"]` | `true` (ignore) |
| No match | `"src/index.ts"`, `["*.g.dart"]` | `false` (review) |
| Default patterns | `"lib/model.freezed.dart"`, `DEFAULT_IGNORE_PATTERNS` | `true` (ignore) |

### Truncation
| Test | Input | Expected |
|---|---|---|
| Small file, no truncation | 50-line file, budget=1000 tokens | Returns full content unchanged |
| Large file, 10-line window | 500-line file with 3 hunks, budget=200 tokens | Returns only 10-line windows around hunks + truncation markers |
| Progressive reduction | 500-line file, 10-line window exceeds budget → 5-line → diff-only | Returns progressively smaller content |
| Truncation markers preserve line numbers | Lines 1-10 present, 11-50 truncated, 51-60 present | Marker shows "... (lines 11-50 truncated, 40 lines omitted) ..." |

### Batcher
| Test | Input | Expected |
|---|---|---|
| Single batch | 3 files, budget=10000 tokens | 1 batch with 3 files |
| Multiple batches | 10 files × 2000 tokens each, budget=5000 tokens | ~4 batches |
| Alphabetical sort | `["z.ts", "a.ts", "m.ts"]` | Batched as `["a.ts", "m.ts", "z.ts"]` |
| Directory grouping | `["src/a.ts", "lib/b.ts", "src/c.ts"]` | Grouped as `["src/a.ts", "src/c.ts", "lib/b.ts"]` |
| Never split file | File exceeds budget alone | Truncated, not split |
| Max-batches cap | 10 files natural→5 batches, maxBatches=3 | Redistributed to 3 batches |

### Circuit Breaker
| Test | Input | Expected |
|---|---|---|
| 3 consecutive failures | 3 failed LLM calls | `tripped = true` |
| Success resets | 2 failures + 1 success + 1 failure | `tripped = false`, `consecutiveFailures = 1` |
| Backoff exponential | attempt=1,2,3 | ~1s, ~2s, ~4s (with jitter 50-100%) |
| Retry-After override | backoff=1s, Retry-After=10 | Sleeps 10s |

### Consolidation
| Test | Input | Expected |
|---|---|---|
| Dedup ±3 lines same file | Two findings: file=a.ts, lines 10 and 12 | Keeps 1 (higher confidence) |
| Dedup different files | Two findings: file=a.ts line 10, file=b.ts line 10 | Keeps both |
| Sort order | high/low, medium/high, high/high | Sorted: high/high, high/low, medium/high |
| Cap at 100 | 150 findings | Returns top 100 after sort |
| Summary merge | Batch1: "🔴 Changes — ...", Batch2: "⚠️ Review — ..." | Merged: "🔴 Changes requested — ..." (highest severity) |
| Unreviewed files | 1 failed batch with 3 files | `unreviewedFiles` contains those 3 filenames |

---

## Integration Verification

### Scenario 1: Small PR (1-3 files)
- **Setup:** Create a PR with 1-3 changed files
- **Expected:** 1 batch, 1 LLM call, review posted successfully
- **Check:** Review appears on PR with inline comments

### Scenario 2: Large PR (20+ files)
- **Setup:** Create a PR with 20+ changed files
- **Expected:** Multiple batches (3-5), parallel LLM calls, consolidated review
- **Check:** 
  - Actions log shows per-batch progress: `[Batch 1/4] Reviewing 5 files...`
  - Review posted with all findings consolidated
  - No duplicate findings (same file + ±3 lines)

### Scenario 3: Generated files
- **Setup:** PR includes `.g.dart`, `.freezed.dart`, `build/output.js` files
- **Expected:** Generated files skipped, not in any batch
- **Check:** Actions log shows "Skipping generated file: X"

### Scenario 4: Model failure + fallback
- **Setup:** Set `model` to an invalid model name, configure `fallback-model`
- **Expected:** Primary fails, circuit breaker eventually trips, fallback used for remaining batches
- **Check:** Review still posted (via fallback model), log shows fallback usage

### Scenario 5: All batches fail
- **Setup:** Both primary and fallback models set to invalid names
- **Expected:** Review posted with "could not review" message, lists all files as unreviewed
- **Check:** Review body contains "⚠️ Files not reviewed" section

### Scenario 6: Large file truncation
- **Setup:** PR includes a 2000-line file with 3 small hunks
- **Expected:** File truncated to 10-line windows around hunks
- **Check:** Actions log shows "Truncated file.ts from 2000 to ~80 lines (10-line window)"

### Scenario 7: Max-batches cap
- **Setup:** 15 files, set `max-batches: 3`
- **Expected:** Exactly 3 batches, files redistributed (may be truncated)
- **Check:** Actions log shows "Forced into 3 batches — some files may be truncated"

### Scenario 8: Ignore patterns
- **Setup:** PR includes `*.g.dart` files + set `ignore-patterns: "*.generated.ts"`
- **Expected:** Both default patterns AND user patterns applied
- **Check:** Both `.g.dart` and `.generated.ts` files skipped

---

## Post-Implementation Checklist

```
[ ] npm install succeeds (gpt-tokenizer added)
[ ] npm run typecheck passes with zero errors
[ ] npm run build produces dist/index.js
[ ] action.yml has all 3 new inputs (ignore-patterns, max-batches, context-window)
[ ] src/types.ts has all new types (FileForReview, Batch, BatchResult, etc.)
[ ] src/concurrency.ts exports Semaphore, pMap, pMapSafe
[ ] src/ignore-patterns.ts exports shouldIgnoreFile, DEFAULT_IGNORE_PATTERNS
[ ] src/circuit-breaker.ts exports all functions
[ ] src/tokenizer.ts exports countTokens, computeTokenBudget
[ ] src/truncation.ts exports truncateFileToWindow, truncateToBudget
[ ] src/cross-file.ts exports extractDiffHunks, buildCrossFileContext
[ ] src/batcher.ts exports createBatches
[ ] src/prompt-builder.ts exports buildBatchUserMessage, formatFileForPrompt
[ ] src/consolidation.ts exports consolidateResults, deduplicateFindings, sortFindings
[ ] src/pipeline.ts exports runPipeline
[ ] src/llm.ts exports reviewWithLLM (modified) + reviewBatch (new)
[ ] src/diff.ts exports fetchFileContentsParallel (modified), extractChangedLines (exported)
[ ] src/diff.ts no longer exports formatDiffForPrompt (removed)
[ ] src/post.ts accepts ConsolidatedReview, caps at 100, shows unreviewed files
[ ] src/index.ts is slim, delegates to pipeline.ts
[ ] prompts/review-batch-system.md exists with batch context note
[ ] Per-batch progress logging present in pipeline.ts
[ ] Circuit breaker (3 consecutive failures → skip to fallback) implemented
[ ] Single semaphore shared by primary + fallback LLM calls
[ ] Token budget formula correct: context - max_output - system - instructions - cross_file - 500
[ ] Files sorted alphabetically before batching
[ ] Directory grouping in batcher.ts
[ ] Never splits a single file across batches
[ ] Truncation markers preserve original line numbers
[ ] Progressive window reduction: 10 → 5 → diff-only
[ ] Cross-file context labeled "do not review"
[ ] Deduplication: ±3 lines same file, keep highest confidence
[ ] Sort: severity desc, confidence desc, filename
[ ] Cap at 100 inline comments
[ ] Programmatic summary merge: highest-severity verdict
[ ] Unreviewed files listed when batches fail
[ ] Generated file skipping: *.g.dart, *.freezed.dart, *.mocks.dart, build/, dist/
[ ] Redundant diff patch removed from per-file prompt
[ ] Diff hunks kept only for cross-file preamble
[ ] Exponential backoff with jitter
[ ] Retry-After header respected
```

---

## Self-Review Subagent Verification

After the 4 subagents produce their reviews:

1. **Collect all reports** from `docs/batch-plan/reviews/`
2. **Triage findings:**
   - Critical issues → fix immediately
   - Warnings → fix if time permits, document otherwise
   - Suggestions → document for future reference
3. **Apply fixes** for all Critical issues found by any subagent
4. **Re-run typecheck + build** after fixes
5. **Document remaining issues** in `docs/batch-plan/reviews/followup.md`
