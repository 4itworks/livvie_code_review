# Batched Architecture Refactor — Implementation Plan

## Overview

Refactor livvie-code-review from a single-LLM-call architecture to a 5-stage parallel pipeline:
1. **FETCH** — parallel file content fetching (concurrency 5)
2. **BATCHING** — bin-packing with real token counting
3. **REVIEW** — parallel per-batch LLM calls (concurrency 3) with circuit breaker
4. **CONSOLIDATION** — deduplicate, sort, cap, merge summaries
5. **POST** — single consolidated review

## Current Architecture (Before)

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point: reads inputs, fetches diff, fetches files, calls LLM once, posts review |
| `src/llm.ts` | Single LLM API call with 3 retries (linear backoff), JSON parsing, fallback support |
| `src/diff.ts` | `fetchDiff()`, `fetchFileContents()` (sequential), `formatDiffForPrompt()`, `isLineInDiff()` |
| `src/post.ts` | Comment building, review body formatting, review posting, stale review dismissal |
| `src/types.ts` | `ReviewFinding`, `StructuredReview`, `DiffFile`, `ReviewComment` |
| `prompts/review-system.md` | System prompt with JSON format spec |
| `action.yml` | GitHub Action inputs |

**Key problems with current architecture:**
- Single LLM call — large PRs exceed context windows
- Sequential file fetching — slow for many files
- No token counting — char-based truncation is inaccurate
- No batching — can't parallelize review work
- Linear backoff — no jitter, no Retry-After, no circuit breaker
- Redundant data — sends both full file AND diff patch (markers already show changes)
- No generated file skipping
- No cross-file context between batches

## New Architecture (After)

### New Files

| File | Purpose |
|---|---|
| `src/tokenizer.ts` | Real token counting via gpt-tokenizer |
| `src/concurrency.ts` | Semaphore + pMap-style concurrency utilities |
| `src/batcher.ts` | Bin-packing algorithm with directory grouping |
| `src/truncation.ts` | File truncation with window reduction |
| `src/cross-file.ts` | Cross-file diff hunk extraction for batch context |
| `src/circuit-breaker.ts` | Circuit breaker + exponential backoff with jitter |
| `src/consolidation.ts` | Dedup, sort, cap, merge summaries |
| `src/prompt-builder.ts` | Per-batch prompt assembly (replaces inline `buildUserMessage`) |
| `src/ignore-patterns.ts` | Generated file pattern matching |
| `src/pipeline.ts` | Orchestrates the 5-stage pipeline (replaces inline logic in index.ts) |
| `prompts/review-batch-system.md` | Updated system prompt for batched context |

### Modified Files

| File | Changes |
|---|---|
| `src/types.ts` | Add `Batch`, `BatchResult`, `PipelineConfig`, `TokenBudget`, `CircuitBreakerState` types |
| `src/diff.ts` | Add parallel fetching with semaphore, remove `formatDiffForPrompt`, add `extractDiffHunks` |
| `src/llm.ts` | Refactor to accept batch prompt, use circuit breaker, shared semaphore |
| `src/post.ts` | Accept consolidated review with unreviewed files list, cap at 100 |
| `src/index.ts` | Delegate to `pipeline.ts`, read new inputs |
| `action.yml` | Add `ignore-patterns`, `max-batches`, `context-window` inputs |
| `package.json` | Add `gpt-tokenizer` dependency |

See the detailed sections in the companion files:
- `docs/batch-plan/01-types.md` — All new types
- `docs/batch-plan/02-new-files.md` — New files with function signatures (part 1)
- `docs/batch-plan/02b-new-files-continued.md` — New files with function signatures (part 2)
- `docs/batch-plan/03-modifications.md` — File modifications
- `docs/batch-plan/04-dependencies-inputs.md` — Dependencies + action.yml
- `docs/batch-plan/05-implementation-order.md` — Dependency graph + order
- `docs/batch-plan/06-self-review.md` — Subagent structure
- `docs/batch-plan/07-verification.md` — Testing strategy
