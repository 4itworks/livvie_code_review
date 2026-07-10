# Section 6: Self-Review Subagent Structure

After implementation is complete, spawn 4 subagents in parallel to review the codebase from different perspectives. Each subagent receives the full codebase + a specific review checklist.

## Subagent Spawning

Use the `autonomous-ai-agents` skill (`claude-code` or `codex` subagent) to spawn 4 parallel review agents.

### Common Context (given to ALL subagents)

```
You are reviewing the livvie-code-review GitHub Action codebase at C:\Users\joaoc\StudioProjects\livvie-code-review.

This is a TypeScript GitHub Action that uses LLMs to review PRs. It was just refactored from a single-LLM-call architecture to a 5-stage batched/parallel pipeline:
1. FETCH (parallel, concurrency 5) — diffs + full file contents
2. BATCHING — bin-packing with real token counting, directory grouping, cross-file diff hunks
3. REVIEW (parallel, concurrency 3, single semaphore) — per-batch LLM calls with circuit breaker
4. CONSOLIDATION — deduplicate, sort, cap at 100, merge summaries
5. POST — single consolidated review

Key files:
- src/pipeline.ts — orchestrates the 5-stage pipeline
- src/batcher.ts — bin-packing algorithm
- src/tokenizer.ts — real token counting via gpt-tokenizer
- src/concurrency.ts — Semaphore + pMap
- src/circuit-breaker.ts — circuit breaker + exponential backoff
- src/truncation.ts — file truncation with window reduction
- src/cross-file.ts — cross-file diff hunk context
- src/consolidation.ts — dedup, sort, cap, merge summaries
- src/prompt-builder.ts — per-batch prompt assembly
- src/ignore-patterns.ts — generated file skipping
- src/llm.ts — LLM API call with retry + fallback
- src/diff.ts — diff fetching + file content fetching
- src/post.ts — GitHub review posting
- src/index.ts — entry point
- src/types.ts — all TypeScript types

Review the code and produce a report with:
1. Issues found (categorized as Critical/Warning/Suggestion)
2. Specific file + line references
3. Recommended fixes

Do NOT modify any files. Only read and report.
```

---

## Subagent 1: Performance Review

**Additional instructions:**
```
Focus specifically on PERFORMANCE. Evaluate:

1. TOKEN EFFICIENCY
   - Are token counts computed once and cached, or recomputed?
   - Is the cross-file context token count computed per-batch or memoized?
   - Are system prompt / review instructions token counts cached?
   - Is truncation re-computing tokens unnecessarily?

2. CONCURRENCY
   - Is the semaphore correctly limiting to 3 concurrent LLM calls?
   - Is the fetch stage correctly limited to 5 concurrent API calls?
   - Is there any unnecessary serialization between stages?
   - Does the circuit breaker check happen before or after acquiring the semaphore? (should be before)
   - Is there a risk of semaphore starvation?

3. LATENCY
   - What's the critical path? (fetch → batch → review → consolidate → post)
   - Is batching O(n) or worse? (should be O(n log n) due to sort)
   - Is deduplication O(n²) or O(n)? (should be O(n log n) with sort)
   - Are there any unnecessary awaits in loops?

4. MEMORY
   - Are large strings (file contents) held in memory longer than needed?
   - Is there any risk of holding all batches in memory simultaneously?

For each issue, specify:
- Current behavior
- Expected behavior
- Impact (estimated token/time waste)
- Fix recommendation
```

---

## Subagent 2: Code Quality Review

**Additional instructions:**
```
Focus specifically on CODE QUALITY. Evaluate:

1. CLEAN CODE
   - Are function names descriptive and accurate?
   - Are functions under 50 lines? (flag any over 100)
   - Is there dead code?
   - Are magic numbers extracted to named constants?

2. DRY (Don't Repeat Yourself)
   - Is the diff hunk parsing logic duplicated? (check diff.ts extractChangedLines vs cross-file.ts extractDiffHunks vs post.ts isLineInDiff — they all parse patches)
   - Is the severity ordering logic duplicated between consolidation.ts and post.ts?
   - Is there a shared "patch parser" that should exist?

3. ERROR HANDLING
   - Are all async operations wrapped in try/catch?
   - Are errors properly propagated? (no swallowed errors)
   - Is the circuit breaker state correctly managed across concurrent calls?
   - Does the semaphore release happen in finally blocks?
   - What happens if ALL batches fail? (should still post a review saying so)

4. TYPE SAFETY
   - Are there any `any` types that should be typed?
   - Are null/undefined cases handled?
   - Is `FileForReview.fullContent` null handled everywhere?

5. NAMING CONSISTENCY
   - "batch" vs "batchId" vs "batchId" — consistent?
   - "finding" vs "result" vs "review" — clear distinction?
   - "file" vs "filename" vs "filepath" — consistent?

For each issue, specify:
- File + line number
- Current code
- Problem
- Suggested fix with code
```

---

## Subagent 3: Architecture Review

**Additional instructions:**
```
Focus specifically on ARCHITECTURE. Evaluate:

1. SEPARATION OF CONCERNS
   - Does pipeline.ts only orchestrate, or does it contain business logic?
   - Is the token budget calculation in tokenizer.ts or batcher.ts? (should be tokenizer)
   - Is the prompt building separate from the LLM calling? (should be)
   - Does post.ts know about batching? (shouldn't — it just posts ConsolidatedReview)

2. EXTENSIBILITY
   - Can a new LLM provider be added without modifying pipeline.ts?
   - Can a new ignore pattern format be added without modifying batcher.ts?
   - Can the consolidation strategy be swapped (e.g., different dedup distance)?
   - Can the circuit breaker threshold be configured without code changes?

3. DEPENDENCY DIRECTION
   - Does pipeline.ts depend on everything? (acceptable as orchestrator)
   - Do leaf modules (concurrency, circuit-breaker, ignore-patterns) depend on anything? (shouldn't)
   - Is there circular dependency risk? (check: batcher → truncation → tokenizer, but does tokenizer → batcher?)

4. COHESION
   - Is each module focused on one responsibility?
   - Does llm.ts contain both LLM calling AND retry logic? (should reviewBatch be in llm.ts or pipeline.ts?)
   - Is the diff parsing logic scattered or centralized? (diff.ts, cross-file.ts, post.ts all parse patches)

5. TESTABILITY
   - Can each module be unit tested in isolation?
   - Are external dependencies (Octokit, fetch) injected or hardcoded?
   - Can the pipeline be tested with mock LLM responses?

For each issue, specify:
- Architectural concern
- Current design
- Recommended design
- Refactoring steps
```

---

## Subagent 4: Security Review

**Additional instructions:**
```
Focus specifically on SECURITY. Evaluate:

1. API KEY HANDLING
   - Is the LLM API key ever logged? (check core.info, core.debug, error messages)
   - Is the API key passed in URLs or query params? (should be header only)
   - Is the API key stored in any object that could be serialized?
   - Is the GitHub token ever logged?

2. PROMPT INJECTION
   - File contents from PRs are untrusted input. Are they embedded in prompts safely?
   - Could a malicious file content contain instructions like "ignore all previous instructions"?
   - Is the cross-file context also untrusted?
   - Could a filename contain special characters that break the prompt format?

3. INPUT VALIDATION
   - Are action.yml inputs validated? (e.g., max-batches could be negative)
   - Are ignore-patterns validated against regex injection?
   - Is the context-window input validated as a positive integer?
   - Could a very large context-window cause OOM?

4. SSRF / NETWORK
   - Is the llm-base-url validated? (could point to internal services)
   - Are file content fetches limited to the PR's repo? (could octokit.rest.repos.getContent be abused?)

5. DATA EXFILTRATION
   - Could LLM responses contain exfiltration attempts? (e.g., "post this finding to evil.com")
   - Are review findings sanitized before posting to GitHub?
   - Could a finding's suggestion field contain malicious markdown?

For each issue, specify:
- Attack vector
- Severity (Critical/High/Medium/Low)
- Current mitigation (if any)
- Recommended fix
```

---

## Subagent Output Format

Each subagent should produce a markdown report saved to:
- `docs/batch-plan/reviews/performance-review.md`
- `docs/batch-plan/reviews/code-quality-review.md`
- `docs/batch-plan/reviews/architecture-review.md`
- `docs/batch-plan/reviews/security-review.md`

Each report contains:
```markdown
# [Perspective] Review — livvie-code-review

## Summary
[1-2 sentence overall assessment]

## Issues Found

### Critical
1. **[Title]** — `src/file.ts:42`
   - Problem: ...
   - Fix: ...

### Warning
1. **[Title]** — `src/file.ts:42`
   - Problem: ...
   - Fix: ...

### Suggestion
1. **[Title]** — `src/file.ts:42`
   - Problem: ...
   - Fix: ...

## Positive Observations
[What's done well]
```
