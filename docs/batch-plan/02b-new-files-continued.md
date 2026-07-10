# Section 2 (cont): New Files continued

## src/circuit-breaker.ts

```typescript
import type { CircuitBreakerState } from "./types.js";

/** Create a fresh circuit breaker state */
export function createCircuitBreaker(threshold?: number): CircuitBreakerState;

/**
 * Record a successful operation — resets consecutive failures.
 */
export function recordSuccess(state: CircuitBreakerState): void;

/**
 * Record a failed operation — increments failures, trips if threshold reached.
 * @returns true if the breaker just tripped
 */
export function recordFailure(state: CircuitBreakerState): boolean;

/** Check if the circuit breaker is tripped */
export function isTripped(state: CircuitBreakerState): boolean;

/**
 * Compute exponential backoff delay with jitter.
 *
 * @param attempt Attempt number (1-based)
 * @param baseDelayMs Base delay (default 1000ms)
 * @param maxDelayMs Maximum delay cap (default 30000ms)
 * @returns Delay in milliseconds
 *
 * Formula: delay = min(baseDelay * 2^(attempt-1), maxDelay) * (0.5 + random() * 0.5)
 * (jitter: 50%-100% of the exponential delay)
 */
export function computeBackoff(
  attempt: number,
  baseDelayMs?: number,
  maxDelayMs?: number
): number;

/**
 * Parse Retry-After header value.
 * @param headerValue Raw header string (could be seconds or HTTP date)
 * @returns Delay in milliseconds, or null if not parseable
 */
export function parseRetryAfter(headerValue: string | null): number | null;

/**
 * Sleep for a given duration, respecting the Retry-After header.
 * Returns the actual delay used (max of backoff and retry-after).
 */
export async function sleepWithRetryAfter(
  backoffMs: number,
  retryAfterMs: number | null
): Promise<number>;
```

**Circuit breaker behavior:**
- Threshold: 3 consecutive failures
- Once tripped: ALL remaining batches skip directly to fallback model
- The breaker does NOT self-heal within a single pipeline run (no half-open state — too short-lived to matter)
- State is shared across all concurrent batch reviews

---

## src/prompt-builder.ts

```typescript
import type { Batch, FileForReview } from "./types.js";

/**
 * Build the user message for a single batch.
 *
 * Structure:
 * 1. Review instructions (if provided)
 * 2. Cross-file context preamble (diff hunks from other batches)
 * 3. For each file in the batch:
 *    - File header with filename
 *    - Full file content with line numbers + → markers
 *    - NO separate diff patch section (markers suffice)
 * 4. JSON instruction
 *
 * @param batch The batch to build a prompt for
 * @param reviewInstructions Project-specific review rules
 * @returns Formatted user message string
 */
export function buildBatchUserMessage(
  batch: Batch,
  reviewInstructions: string
): string;

/**
 * Format a single file for the batch prompt.
 * Includes line numbers + → markers, NO diff patch section.
 */
export function formatFileForPrompt(file: FileForReview): string;
```

**Key change from current `formatDiffForPrompt`:**
- REMOVES the `### Diff` section (the `→` markers in the full file already show what changed)
- KEEPS diff hunks ONLY in the cross-file context preamble (for files in other batches)
- This reduces token usage significantly

**Output format for a file:**
```markdown
## src/widget.dart

### Full file (with line numbers, → marks changed lines)
```
278:   void changeIncomingPackageLocation() {
279:     final location = locationSelectableFieldValue;
280:
281: →     if (location.id == null) {
282: →       DSSnackBar.show(
283: →         context: getContext(),
284: →         description: 'Please select a valid location.',
285: →       );
286: →       return;
287: →     }
```
```

**Cross-file preamble format (before the file sections):**
```markdown
## Context — other files in this PR (do NOT review these, for understanding only)

### lib/utils.dart
```diff
@@ -10,5 +12,7 @@
-const old = "value";
+const new = "updated";
```
```

---

## src/consolidation.ts

```typescript
import type {
  BatchResult,
  ConsolidatedReview,
  ReviewFinding,
  StructuredReview,
} from "./types.js";

/**
 * Consolidate results from all batch reviews.
 *
 * Steps:
 * 1. Collect all findings from successful batches
 * 2. Deduplicate: ±3 lines same file, keep highest confidence
 * 3. Sort: severity (high→low), confidence (high→low), filename (A→Z)
 * 4. Cap at 100 findings (GitHub inline comment limit)
 * 5. Merge summaries programmatically
 * 6. List unreviewed files from failed batches
 *
 * @param results All batch results (including failed ones)
 * @returns Consolidated review
 */
export function consolidateResults(results: BatchResult[]): ConsolidatedReview;

/**
 * Deduplicate findings.
 * Two findings are duplicates if:
 * - Same file
 * - Line numbers within ±3 of each other
 * Keep the one with higher confidence (high > medium > low).
 * If same confidence, keep the one from the earlier batch (lower batchId).
 *
 * @param findings Findings to deduplicate
 * @returns Deduplicated findings
 */
export function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[];

/**
 * Sort findings by:
 * 1. Severity descending: high → medium → low
 * 2. Confidence descending: high → medium → low
 * 3. Filename ascending: A → Z
 * 4. Line ascending (tiebreaker within same file)
 */
export function sortFindings(findings: ReviewFinding[]): ReviewFinding[];

/**
 * Cap findings at a maximum count.
 * Keeps the top N after sorting.
 */
export function capFindings(findings: ReviewFinding[], max: number): ReviewFinding[];

/**
 * Merge summaries from multiple batches programmatically.
 *
 * Logic:
 * 1. Determine highest severity across all batches → pick verdict prefix
 * 2. Concatenate "what changed" portions from all batch summaries
 * 3. If any batch failed, append "⚠️ N files could not be reviewed"
 *
 * @param results Batch results (successful ones contribute summaries)
 * @param unreviewedFiles Files from failed batches
 * @returns Merged summary string
 */
export function mergeSummaries(
  results: BatchResult[],
  unreviewedFiles: string[]
): string;
```

**Severity ordering map:**
```typescript
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const CONFIDENCE_ORDER = { high: 0, medium: 1, low: 2 };
```

**Summary merge format:**
```
🔴 Changes requested — The PR has high-severity issues that must be fixed before merge.

The PR refactors `changeIncomingPackageLocation` in widget.dart and migrates utils.dart to use new state tracking. {batch 2 summary what-changed} {batch 3 summary what-changed}

⚠️ 2 files could not be reviewed due to errors: lib/failed.ts, src/other.ts
```

**Deduplication algorithm:**
```
1. Group findings by file
2. Within each file group, sort by line number
3. Walk the sorted list, merge findings within ±3 lines:
   - Keep the one with higher confidence
   - If same confidence, keep the one from the lower batchId
   - If same confidence and batchId, keep the first encountered
```

---

## src/pipeline.ts

```typescript
import { Octokit } from "@octokit/rest";
import type { PipelineConfig, ConsolidatedReview } from "./types.js";

/**
 * Run the full 5-stage pipeline:
 *
 * Stage 1: FETCH — fetch diffs + file contents in parallel (concurrency 5)
 * Stage 2: BATCHING — bin-pack files into batches with token budget
 * Stage 3: REVIEW — parallel per-batch LLM calls (concurrency 3) with circuit breaker
 * Stage 4: CONSOLIDATION — deduplicate, sort, cap, merge summaries
 * Stage 5: POST — post single consolidated review to GitHub
 *
 * @param octokit Authenticated Octokit instance
 * @param owner Repo owner
 * @param repo Repo name
 * @param pullNumber PR number
 * @param config Pipeline configuration
 * @returns Consolidated review (also posts to GitHub)
 */
export async function runPipeline(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  config: PipelineConfig
): Promise<ConsolidatedReview>;
```

**Internal functions in pipeline.ts:**

```typescript
/** Stage 1: Fetch diffs and file contents in parallel */
async function stageFetch(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  prHeadRef: string,
  config: PipelineConfig
): Promise<FileForReview[]>;

/** Stage 2: Bin-pack files into batches */
function stageBatch(
  files: FileForReview[],
  config: PipelineConfig
): Batch[];

/** Stage 3: Review each batch in parallel with circuit breaker */
async function stageReview(
  batches: Batch[],
  config: PipelineConfig,
  semaphore: Semaphore
): Promise<BatchResult[]>;

/** Stage 4: Consolidate results */
function stageConsolidate(
  results: BatchResult[],
  batches: Batch[]
): ConsolidatedReview;

/** Stage 5: Post review to GitHub */
async function stagePost(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  consolidated: ConsolidatedReview,
  files: FileForReview[],
  config: PipelineConfig
): Promise<void>;
```

**Stage 3 (REVIEW) detail:**
```
1. Create a single Semaphore(reviewConcurrency=3) — shared by primary + fallback
2. Create a CircuitBreakerState(threshold=3) — shared across all batches
3. For each batch (parallel via pMap with semaphore):
   a. If circuit breaker is tripped → go straight to fallback model
   b. Try primary model:
      - Acquire semaphore
      - Call reviewWithLLM with exponential backoff + jitter + Retry-After
      - On success: recordSuccess(circuitBreaker), return result
      - On failure: recordFailure(circuitBreaker)
        - If circuit just tripped: log "Circuit breaker tripped, using fallback for remaining batches"
        - Try fallback model (if configured) within same semaphore
        - If fallback also fails: return BatchResult with success=false
   c. Log per-batch progress:
      "[Batch 2/5] Reviewing 3 files (src/a.ts, src/b.ts, src/c.ts)..."
      "[Batch 2/5] Complete: 5 findings"
      "[Batch 2/5] Failed: timeout — using fallback"
```

**Retry details in stage 3:**
- Max retries per batch: 3
- Backoff: exponential with jitter (base 1s, max 30s)
- If response has `Retry-After` header: use `max(computed_backoff, retry_after)`
- Circuit breaker tracks CONSECUTIVE failures across ALL batches (not per-batch)
- Once tripped, remaining batches skip primary entirely
