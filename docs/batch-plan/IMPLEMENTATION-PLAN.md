# Multi-Perspective Batched Review Architecture — Implementation Plan

## Executive Summary

Refactor livvie-code-review from a single-LLM-call architecture to a **matrix architecture**: files are batched by token budget, and each batch is reviewed by **multiple specialist perspectives** (performance, code quality, security, architecture, etc.). Each cell in the matrix (batch × perspective) is one LLM call.

### Design Decisions (answers to key questions)

| Question | Decision | Rationale |
|---|---|---|
| How many perspectives by default? Which ones? | **5 default**: `code-quality`, `security`, `performance`, `architecture`, `generalist` | Covers the major axes of code review. Generalist catches cross-cutting concerns specialists might miss. |
| Should all perspectives review ALL batches? | **Yes** — every perspective reviews every batch | Simpler, more thorough, and avoids missing issues in "unrelated" files. A security bug can exist in any file. |
| How to handle cost explosion? | `max-batches` caps total batches; `perspectives` input lets users opt into fewer reviewers; `max-comments` still caps output. Total LLM calls = `min(batches, max-batches) × len(perspectives)`. | User-controlled cost ceiling. |
| Should perspectives be configurable via action.yml? | **Yes** — `perspectives` input (comma-separated) defaults to `"code-quality,security,performance,architecture,generalist"` | Users can run just `security` for a security-focused repo, or add custom ones. |
| How should review body show which perspective found each finding? | Each finding gets a `perspective` field. Inline comment footer: `— Found by: Security Reviewer`. Summary table includes a "Perspective" column. | Transparency without clutter. |
| Should there be a "generalist" perspective? | **Yes** — catches style, naming, readability, and cross-cutting concerns that don't fit a specialist bucket | Prevents blind spots between specialists. |

### 5-Stage Pipeline

```
┌─────────┐    ┌──────────┐    ┌─────────────────────────────┐    ┌────────────────┐    ┌──────┐
│  FETCH  │───▶│ BATCHING │───▶│ REVIEW (matrix: B × P)      │───▶│ CONSOLIDATION  │───▶│ POST │
│ parallel│    │ bin-pack │    │ batches × perspectives      │    │ dedup + merge  │    │      │
│ conc=5  │    │ tokens   │    │ single semaphore, conc=3    │    │ cap 100        │    │      │
└─────────┘    └──────────┘    └─────────────────────────────┘    └────────────────┘    └──────┘
```

---

## 1. New Types (`src/types.ts` — full replacement)

The entire `src/types.ts` file will be replaced. Here is the complete new content:

```typescript
// ============================================================
// Core domain types (existing, extended)
// ============================================================

export interface DiffFile {
  filename: string;
  patch: string;
  additions: number;
  deletions: number;
  status?: "added" | "modified" | "removed" | "renamed";
}

export interface ReviewFinding {
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  file: string;
  line: number;
  description: string;
  suggestion: string | null;
  perspective: string; // NEW: which perspective found this (e.g. "security")
}

export interface StructuredReview {
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
}

// ============================================================
// Perspective definitions
// ============================================================

export interface Perspective {
  /** Machine name, e.g. "security" */
  id: string;
  /** Display name, e.g. "Security Reviewer" */
  name: string;
  /** Full system prompt text for this perspective */
  systemPrompt: string;
  /** Short focus description for logging, e.g. "injection risks, secret leaks, auth bypass" */
  focus: string;
}

// ============================================================
// Batching types
// ============================================================

/** A file prepared for batching — content already fetched and optionally truncated. */
export interface PreparedFile {
  filename: string;
  patch: string;
  additions: number;
  deletions: number;
  /** Full file content with line-number prefixes, possibly truncated. Empty if fetch failed. */
  content: string;
  /** Token count of the formatted prompt section for this file (content + patch + headers). */
  tokenCount: number;
  /** Whether the content was truncated. */
  truncated: boolean;
  /** Directory of the file (for grouping), e.g. "src/components" */
  directory: string;
}

/** A batch of files that fits within the token budget. */
export interface Batch {
  /** 0-indexed batch number */
  index: number;
  /** Files in this batch */
  files: PreparedFile[];
  /** Total token count of all file sections in this batch */
  tokenCount: number;
  /** Cross-file context: diff hunks of files in OTHER batches */
  crossFileContext: string;
  /** Total token count including cross-file context */
  totalTokenCount: number;
}

// ============================================================
// Review result types
// ============================================================

/** Result of a single LLM call (one batch × one perspective). */
export interface BatchReviewResult {
  batchIndex: number;
  perspectiveId: string;
  perspectiveName: string;
  review: StructuredReview;
  /** Which model actually produced this (primary or fallback) */
  modelUsed: string;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Whether the fallback model was used */
  usedFallback: boolean;
  error?: string;
}

/** Aggregated results from the entire review matrix. */
export interface ReviewMatrixResult {
  results: BatchReviewResult[];
  /** All findings from all results, before consolidation */
  rawFindings: ReviewFinding[];
  /** Batches that failed entirely (all perspectives failed) */
  failedBatches: number[];
  /** Files that were in failed batches */
  unreviewedFiles: string[];
  /** Total LLM calls made */
  totalCalls: number;
  /** Total LLM calls that succeeded */
  successfulCalls: number;
}

// ============================================================
// Consolidated review (input to POST stage)
// ============================================================

export interface ConsolidatedReview {
  summary: string;
  findings: ReviewFinding[];
  /** Per-perspective summary fragments for the review body */
  perspectiveSummaries: PerspectiveSummary[];
  /** Files that couldn't be reviewed */
  unreviewedFiles: string[];
  /** Stats */
  stats: ReviewStats;
}

export interface PerspectiveSummary {
  perspectiveId: string;
  perspectiveName: string;
  findingCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  /** 1-sentence summary from this perspective */
  summary: string;
}

export interface ReviewStats {
  totalFindings: number;
  high: number;
  medium: number;
  low: number;
  totalBatches: number;
  totalPerspectives: number;
  totalLLMCalls: number;
  successfulLLMCalls: number;
  failedBatches: number;
}

// ============================================================
// Pipeline configuration
// ============================================================

export interface PipelineConfig {
  // GitHub
  githubToken: string;
  owner: string;
  repo: string;
  pullNumber: number;
  prHeadRef: string;
  prBaseRef: string;
  // LLM
  llmApiKey: string;
  llmBaseUrl: string;
  model: string;
  fallbackModel: string;
  maxOutputTokens: number;
  reasoningEffort: string;
  // Batching
  maxDiffSize: number;
  maxBatches: number;
  contextWindow: number;
  ignorePatterns: string[];
  // Perspectives
  perspectives: string[]; // perspective IDs to run
  // Review
  reviewInstructions: string;
  // Posting
  requestChangesOnHigh: boolean;
  maxComments: number;
  // Concurrency
  fetchConcurrency: number;
  llmConcurrency: number;
}

// ============================================================
// Token budget calculation
// ============================================================

export interface TokenBudget {
  contextWindow: number;
  maxOutput: number;
  systemPromptTokens: number;
  reviewInstructionsTokens: number;
  crossFileHunksTokens: number;
  safetyMargin: number;
  /** Effective budget for file content in a single batch */
  fileBudget: number;
}

// ============================================================
// Circuit breaker
// ============================================================

export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  /** Timestamp when circuit opens; used for half-open timing */
  openedAt: number | null;
  /** Threshold of consecutive failures before opening */
  threshold: number;
}

// ============================================================
// Semaphore
// ============================================================

export interface Semaphore {
  acquire(): Promise<() => void>;
  get available(): number;
  get waiting(): number;
}
```

---

## 2. New Files (with full function signatures)

### 2.1 `src/concurrency.ts`

Semaphore-based concurrency control. Used by both FETCH and REVIEW stages.

```typescript
/**
 * Create a counting semaphore for concurrency limiting.
 * @param maxConcurrency Maximum number of concurrent acquires.
 * @returns Semaphore object with acquire() that returns a release function.
 */
export function createSemaphore(maxConcurrency: number): Semaphore;

/**
 * Map over an array with bounded concurrency.
 * Like p-map but dependency-free.
 * @param items Input array.
 * @param mapper Async function applied to each item.
 * @param concurrency Max concurrent calls.
 * @returns Array of results in the same order as input.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]>;

/**
 * Run an async function with a timeout. Rejects if the timeout elapses.
 * @param fn Async function to run.
 * @param timeoutMs Timeout in milliseconds.
 * @param label Description for the error message.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T>;
```

**Implementation notes:**
- `createSemaphore`: maintains a count and a queue of `(resolve) => release` callbacks. `acquire()` returns a `release` function that decrements count and drains the queue.
- `mapWithConcurrency`: wraps each mapper call in `semaphore.acquire()`, calls the mapper, and always releases in a `finally` block. Uses `Promise.all` on an array of per-item promises.
- `withTimeout`: `Promise.race` between `fn()` and a `setTimeout` that rejects with `Error(`${label} timed out after ${timeoutMs}ms`)`.

### 2.2 `src/tokenizer.ts`

Real token counting using `gpt-tokenizer`.

```typescript
import { encode } from "gpt-tokenizer";

/**
 * Count tokens in a text string using GPT-compatible tokenizer.
 * @param text Input text.
 * @returns Token count.
 */
export function countTokens(text: string): number;

/**
 * Count tokens for a structured prompt section (system + user content).
 * More accurate than concatenating and counting, as it accounts for
 * message framing overhead.
 * @param systemPrompt System prompt text.
 * @param userContent User message text.
 * @returns Total token count including ~4 token overhead per message.
 */
export function countPromptTokens(systemPrompt: string, userContent: string): number;

/**
 * Estimate the token budget available for file content in each batch.
 * @param config Pipeline configuration values.
 * @param systemPromptTokens Token count of the (longest) perspective system prompt.
 * @param reviewInstructionsTokens Token count of review instructions.
 * @param crossFileHunksTokens Token count of cross-file context hunks.
 * @returns TokenBudget with fileBudget calculated.
 */
export function calculateTokenBudget(
  contextWindow: number,
  maxOutput: number,
  systemPromptTokens: number,
  reviewInstructionsTokens: number,
  crossFileHunksTokens: number
): TokenBudget;
```

**Implementation notes:**
- `countTokens`: `encode(text).length`. Catches errors and falls back to `Math.ceil(text.length / 4)`.
- `countPromptTokens`: `countTokens(systemPrompt) + countTokens(userContent) + 8` (4 tokens overhead per message × 2 messages, matching OpenAI's convention).
- `calculateTokenBudget`: `fileBudget = contextWindow - maxOutput - systemPromptTokens - reviewInstructionsTokens - crossFileHunksTokens - 500 (safety margin)`. Asserts `fileBudget > 0`; throws if not.
- **Important**: Use the longest perspective system prompt for budget calculation, since each perspective gets its own system prompt. The `systemPromptTokens` parameter should be `max(perspectives.map(p => countTokens(p.systemPrompt)))`.

### 2.3 `src/ignore-patterns.ts`

Generated/irrelevant file skipping.

```typescript
/** Default patterns for generated files. */
export const DEFAULT_IGNORE_PATTERNS: string[];

/**
 * Parse a comma-separated ignore-patterns string into an array of glob patterns.
 * @param input Comma-separated string (e.g. "*.g.dart,*.freezed.dart,build/").
 * @returns Array of glob pattern strings.
 */
export function parseIgnorePatterns(input: string): string[];

/**
 * Check if a filename matches any of the ignore patterns.
 * Uses minimatch-style matching (delegated to a lightweight glob matcher).
 * @param filename File path (e.g. "lib/src/models/user.g.dart").
 * @param patterns Array of glob patterns.
 * @returns True if the file should be ignored.
 */
export function shouldIgnoreFile(filename: string, patterns: string[]): boolean;

/**
 * Filter a list of DiffFiles, removing ignored ones.
 * @param files Diff files to filter.
 * @param patterns Ignore patterns.
 * @returns Tuple of [kept, ignored] arrays.
 */
export function filterIgnoredFiles(
  files: DiffFile[],
  patterns: string[]
): { kept: DiffFile[]; ignored: DiffFile[] };
```

**Default patterns:**
```typescript
export const DEFAULT_IGNORE_PATTERNS = [
  "*.g.dart",
  "*.freezed.dart",
  "*.mocks.dart",
  "*.gen.dart",
  "build/**",
  "dist/**",
  "node_modules/**",
  "*.min.js",
  "*.min.css",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];
```

**Implementation notes:**
- `shouldIgnoreFile`: implements matching with `**` for directory recursion. Since we want to avoid a `minimatch` dependency, we convert each glob to a regex: `*` → `[^/]*`, `**` → `.*`, `.` → `\.`. Test against the full filename. This is a lightweight glob-to-regex converter, not full minimatch, but sufficient for file path patterns.

### 2.4 `src/truncation.ts`

File content truncation with progressive window reduction.

```typescript
/**
 * Truncate file content to a window around diff hunks.
 * @param content Full file content WITH line-number prefixes (e.g. "42: → code here").
 * @param patch Git diff patch for this file.
 * @param windowLines Number of lines of context around each hunk (default 10).
 * @returns Object with truncated content and whether truncation occurred.
 */
export function truncateToWindow(
  content: string,
  patch: string,
  windowLines: number
): { content: string; truncated: boolean };

/**
 * Progressively truncate a file that exceeds the token budget:
 * 1. Try 10-line window
 * 2. If still too big, try 5-line window
 * 3. If still too big, return diff-only (no full file content)
 * @param content Full file content with line-number prefixes.
 * @param patch Git diff patch.
 * @param maxTokens Maximum tokens allowed for this file's content section.
 * @returns Truncated content and truncation metadata.
 */
export function progressiveTruncate(
  content: string,
  patch: string,
  maxTokens: number
): { content: string; truncated: boolean; strategy: "full" | "window-10" | "window-5" | "diff-only" };

/**
 * Extract the set of changed line numbers from a diff patch.
 * (Moved from diff.ts — reused by truncation and posting logic.)
 * @param patch Git diff patch string.
 * @returns Set of line numbers (in the new file) that were added or modified.
 */
export function extractChangedLines(patch: string): Set<number>;
```

**Implementation notes:**
- `truncateToWindow`: parses the patch to find all hunk start lines (regex `@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@`), then for each hunk, keeps `[start - windowLines, end + windowLines]` lines. Inserts truncation markers like `// ... (lines 1-31 truncated) ...` preserving original line numbers. The content already has line-number prefixes, so we just filter which lines to keep.
- `progressiveTruncate`: calls `truncateToWindow` with 10, then 5, then returns just the patch (diff-only). Checks token count after each step using `countTokens`. Returns the strategy used for logging.
- `extractChangedLines`: same logic currently in `diff.ts`, moved here for reusability.

### 2.5 `src/cross-file.ts`

Cross-file diff hunk extraction for inter-batch context.

```typescript
import type { PreparedFile, Batch } from "./types.js";

/**
 * Build cross-file context for a batch: diff hunks of files in OTHER batches.
 * These are marked as "context only, do not review" so the LLM understands
 * changes in related files without commenting on them.
 * @param allBatches All batches in the pipeline.
 * @param currentBatch The batch to build context for.
 * @param maxTokens Maximum tokens for cross-file context.
 * @returns Formatted cross-file context string.
 */
export function buildCrossFileContext(
  allBatches: Batch[],
  currentBatch: Batch,
  maxTokens: number
): string;

/**
 * Extract a compact diff hunk summary for a file.
 * Just the @@ headers and added/removed lines, no context lines.
 * @param patch Git diff patch.
 * @returns Compact diff string.
 */
export function compactHunkSummary(patch: string): string;
```

**Implementation notes:**
- `buildCrossFileContext`: iterates over all batches except `currentBatch`, for each file builds a header `### {filename} (in batch N — context only, do not review)`, followed by `compactHunkSummary(patch)`. Accumulates until `maxTokens` is reached. If no other batches, returns empty string.
- `compactHunkSummary`: splits patch by lines, keeps `@@` headers, `+` lines, and `-` lines. Drops context lines (lines starting with space). This gives a compact view of what changed.

### 2.6 `src/batcher.ts`

Bin-packing algorithm with directory grouping.

```typescript
import type { DiffFile, PreparedFile, Batch, TokenBudget } from "./types.js";

/**
 * Prepare files for batching: fetch content (already done), truncate, compute token counts.
 * @param files Diff files with patches.
 * @param fileContents Map of filename → full file content (with line-number prefixes).
 * @param tokenBudget Token budget for file content per batch.
 * @returns Array of PreparedFile objects.
 */
export function prepareFiles(
  files: DiffFile[],
  fileContents: Map<string, string>,
  tokenBudget: TokenBudget
): PreparedFile[];

/**
 * Bin-pack prepared files into batches.
 * Algorithm:
 * 1. Sort files alphabetically by filename (deterministic).
 * 2. Group by directory preferentially (files in same dir go in same batch if they fit).
 * 3. Greedy first-fit: add file to current batch if it fits; otherwise start new batch.
 * 4. If a single file exceeds budget, it was truncated in prepareFiles — it gets its own batch.
 * 5. Cap at maxBatches; if exceeded, merge remaining files into last batch (will be truncated).
 * @param preparedFiles Files prepared for batching.
 * @param tokenBudget Token budget.
 * @param maxBatches Maximum number of batches (0 = no limit).
 * @returns Array of Batch objects.
 */
export function binPackFiles(
  preparedFiles: PreparedFile[],
  tokenBudget: TokenBudget,
  maxBatches: number
): Batch[];

/**
 * Assign cross-file context to each batch.
 * Mutates each batch's crossFileContext and totalTokenCount fields.
 * @param batches All batches.
 * @param tokenBudget Token budget (for cross-file hunks token limit).
 */
export function assignCrossFileContext(
  batches: Batch[],
  tokenBudget: TokenBudget
): void;

/**
 * Full batching pipeline: prepare → bin-pack → assign cross-file context.
 * @param files Diff files.
 * @param fileContents File contents map.
 * @param tokenBudget Token budget.
 * @param maxBatches Max batches cap.
 * @returns Final array of batches ready for review.
 */
export function createBatches(
  files: DiffFile[],
  fileContents: Map<string, string>,
  tokenBudget: TokenBudget,
  maxBatches: number
): Batch[];
```

**Implementation notes:**
- `prepareFiles`: for each file, get content from map (or empty string if not found), call `progressiveTruncate` if `countTokens(content) > tokenBudget.fileBudget` (single file exceeds budget), compute `tokenCount = countTokens(formattedFileSection(file))` where `formattedFileSection` is the markdown header + content + patch. Extract `directory` from filename (everything before the last `/`).
- `binPackFiles`: sort alphabetically. Iterate. For each file, check if adding it to the current batch would exceed `fileBudget`. If yes, close current batch and start a new one. Group by directory: if the current batch already has a file from the same directory, prefer adding to it even if a new batch would otherwise be started (as long as it fits). If `maxBatches > 0` and we've created `maxBatches` batches, merge all remaining files into the last batch.
- `assignCrossFileContext`: for each batch, call `buildCrossFileContext(allBatches, batch, tokenBudget.crossFileHunksTokens)`. Update `batch.crossFileContext` and `batch.totalTokenCount = batch.tokenCount + countTokens(batch.crossFileContext)`.

### 2.7 `src/perspectives.ts`

Perspective definitions and loading.

```typescript
import type { Perspective } from "./types.js";

/**
 * All available perspective definitions.
 * Each has its own system prompt focused on a specific review angle.
 */
export const PERSPECTIVE_REGISTRY: Record<string, Perspective>;

/**
 * Default perspective IDs to run.
 */
export const DEFAULT_PERSPECTIVES: string[];

/**
 * Get perspective definitions by IDs.
 * @param ids Array of perspective IDs (e.g. ["security", "performance"]).
 * @returns Array of Perspective objects. Unknown IDs are logged and skipped.
 */
export function getPerspectives(ids: string[]): Perspective[];

/**
 * Parse the perspectives input string.
 * @param input Comma-separated string (e.g. "security,performance").
 * @returns Array of perspective IDs. Empty input returns DEFAULT_PERSPECTIVES.
 */
export function parsePerspectivesInput(input: string): string[];
```

**Perspective registry (see section 5 for full prompts):**

```typescript
export const DEFAULT_PERSPECTIVES = [
  "code-quality",
  "security",
  "performance",
  "architecture",
  "generalist",
];

export const PERSPECTIVE_REGISTRY: Record<string, Perspective> = {
  "code-quality": {
    id: "code-quality",
    name: "Code Quality Reviewer",
    focus: "readability, naming, dead code, complexity, maintainability",
    systemPrompt: `...`, // see section 5.1
  },
  security: {
    id: "security",
    name: "Security Reviewer",
    focus: "injection risks, secret leaks, auth bypass, input validation",
    systemPrompt: `...`, // see section 5.2
  },
  performance: {
    id: "performance",
    name: "Performance Reviewer",
    focus: "N+1 queries, unnecessary rebuilds, memory leaks, algorithmic complexity",
    systemPrompt: `...`, // see section 5.3
  },
  architecture: {
    id: "architecture",
    name: "Architecture Reviewer",
    focus: "separation of concerns, coupling, layering, dependency direction, SOLID",
    systemPrompt: `...`, // see section 5.4
  },
  generalist: {
    id: "generalist",
    name: "General Reviewer",
    focus: "style, documentation, error handling, edge cases, cross-cutting concerns",
    systemPrompt: `...`, // see section 5.5
  },
};
```

### 2.8 `src/circuit-breaker.ts`

Circuit breaker + exponential backoff with jitter.

```typescript
import type { CircuitBreakerStatus, CircuitBreakerState } from "./types.js";

/**
 * Create a circuit breaker instance.
 * @param threshold Number of consecutive failures before opening (default 3).
 * @returns Object with check(), recordSuccess(), recordFailure(), getStatus() methods.
 */
export function createCircuitBreaker(threshold?: number): {
  /**
   * Check if the circuit is open (should skip to fallback).
   * Returns true if circuit is open — caller should use fallback model directly.
   */
  check(): boolean;

  /** Record a successful call — resets consecutive failures, closes circuit. */
  recordSuccess(): void;

  /** Record a failed call — increments consecutive failures, may open circuit. */
  recordFailure(): void;

  /** Get current status. */
  getStatus(): CircuitBreakerStatus;
};

/**
 * Calculate exponential backoff delay with jitter.
 * @param attempt Attempt number (1-indexed).
 * @param baseDelayMs Base delay in ms (default 1000).
 * @param maxDelayMs Maximum delay in ms (default 30000).
 * @returns Delay in milliseconds.
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs?: number,
  maxDelayMs?: number
): number;

/**
 * Parse Retry-After header value into milliseconds.
 * @param retryAfter Header value (either seconds or HTTP date).
 * @returns Milliseconds to wait, or null if header is absent/invalid.
 */
export function parseRetryAfter(retryAfter: string | null): number | null;

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void>;
```

**Implementation notes:**
- `createCircuitBreaker`: maintains `CircuitBreakerStatus`. `recordFailure()` increments `consecutiveFailures`; if `>= threshold`, sets state to `"open"` and records `openedAt = Date.now()`. `check()` returns `state === "open"`. `recordSuccess()` resets `consecutiveFailures = 0` and sets `state = "closed"`.
- `calculateBackoff`: `delay = min(baseDelayMs * 2^(attempt-1), maxDelayMs)`, then apply jitter: `delay = delay * (0.5 + Math.random() * 0.5)` (random between 50% and 100% of calculated delay).
- `parseRetryAfter`: if numeric, treat as seconds → `parseInt * 1000`. If it parses as a date, compute `date.getTime() - Date.now()`. Return `null` if invalid or negative.

### 2.9 `src/llm-batch.ts`

Refactored LLM caller for batched, multi-perspective reviews. This replaces the core call logic in `llm.ts`.

```typescript
import type { Batch, Perspective, BatchReviewResult, Semaphore } from "./types.js";

/**
 * Configuration for a single LLM review call.
 */
export interface LLMCallConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  maxOutputTokens: number;
  reasoningEffort: string;
  reviewInstructions: string;
  semaphore: Semaphore;
  circuitBreaker: ReturnType<typeof createCircuitBreaker>;
  maxRetries: number;
}

/**
 * Review a single batch from a single perspective.
 * This is ONE cell in the matrix (batch × perspective).
 *
 * Flow:
 * 1. Check circuit breaker — if open, skip primary model, go straight to fallback.
 * 2. Acquire semaphore (concurrency control).
 * 3. Build user message (batch files + cross-file context + review instructions).
 * 4. Call primary model with retries (exponential backoff + jitter + Retry-After).
 * 5. If primary fails after retries, try fallback model (if configured).
 * 6. Parse response, tag findings with perspective.
 * 7. Return BatchReviewResult.
 *
 * @param batch The batch to review.
 * @param perspective The perspective to review from.
 * @param config LLM call configuration.
 * @returns BatchReviewResult with findings tagged with perspective.
 */
export async function reviewBatchFromPerspective(
  batch: Batch,
  perspective: Perspective,
  config: LLMCallConfig
): Promise<BatchReviewResult>;

/**
 * Build the user message for a batch × perspective LLM call.
 * @param batch The batch (files + cross-file context).
 * @param reviewInstructions Project-specific review instructions.
 * @returns Formatted user message string.
 */
export function buildBatchUserMessage(
  batch: Batch,
  reviewInstructions: string
): string;

/**
 * Make a single LLM API call with retry logic.
 * @param apiKey API key.
 * @param baseUrl Base URL.
 * @param model Model name.
 * @param systemPrompt System prompt.
 * @param userContent User message.
 * @param maxOutputTokens Max output tokens.
 * @param reasoningEffort Reasoning effort.
 * @param maxRetries Max retry attempts.
 * @param circuitBreaker Circuit breaker to check/update.
 * @returns Raw response content string.
 * @throws Error if all retries fail.
 */
export async function callLLMWithRetry(
  apiKey: string,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  maxOutputTokens: number,
  reasoningEffort: string,
  maxRetries: number,
  circuitBreaker: ReturnType<typeof createCircuitBreaker>
): Promise<{ content: string; modelUsed: string }>;
```

**Implementation notes for `reviewBatchFromPerspective`:**

```
1. Check circuit breaker. If open, set skipPrimary = true.
2. Acquire semaphore (await config.semaphore.acquire()).
3. Record start time.
4. Try primary model (unless skipPrimary):
   a. callLLMWithRetry(primary...)
   b. On success: circuitBreaker.recordSuccess(), parse review, tag findings.
   c. On failure: circuitBreaker.recordFailure(), log warning.
5. If primary failed and fallbackModel is set:
   a. callLLMWithRetry(fallback...) — with reasoningEffort="none"
   b. On success: parse review, tag findings, mark usedFallback=true.
   c. On failure: return BatchReviewResult with error.
6. Release semaphore (in finally block).
7. Return BatchReviewResult.
```

**Tagging findings with perspective:** After parsing the LLM response, map over `findings` and set `finding.perspective = perspective.id` on each.

**`buildBatchUserMessage` format:**
```
## Project-specific review rules
{reviewInstructions}

## Cross-file context (context only — do NOT review these files)
{batch.crossFileContext}

## Files to review

### {file1.filename}
### Full file (with line numbers, → marks changed lines)
```
{file1.content}
```
### Diff
```diff
{file1.patch}
```

### {file2.filename}
...

Return your review as a JSON object. Only return JSON, no markdown.
```

**Important**: the diff patch is still included per-file (the requirement says "remove redundant diff patch from per-file prompt" but also "keep diff hunks only for cross-file preamble"). After analysis, the diff patch per file IS redundant when we have the full file with `→` markers. So the per-file section will have:
- Full file content with line numbers and `→` markers (truncated if needed)
- NO separate diff patch section (the `→` markers in the full file content already show what changed)

The diff patch is only used in the **cross-file preamble** (for files in other batches), where we don't have full content.

**Revised `buildBatchUserMessage` format:**
```
## Project-specific review rules
{reviewInstructions}

## Cross-file context (context only — do NOT review these files)
{batch.crossFileContext}

## Files to review

### {file1.filename} ({file1.additions}+, {file1.deletions}-)
Full file with line numbers. Lines marked with → were changed in this PR.

```
{file1.content}
```

### {file2.filename} ({file2.additions}+, {file2.deletions}-)
...

Return your review as a JSON object. Only return JSON, no markdown.
```

### 2.10 `src/consolidation.ts`

Merge, deduplicate, sort, and cap findings from all matrix results.

```typescript
import type {
  ReviewMatrixResult,
  ConsolidatedReview,
  ReviewFinding,
  PerspectiveSummary,
} from "./types.js";

/**
 * Consolidate all review matrix results into a single review.
 * @param matrixResult All batch × perspective results.
 * @param perspectives All perspectives that were run.
 * @returns ConsolidatedReview ready for posting.
 */
export function consolidateReviews(
  matrixResult: ReviewMatrixResult,
  perspectives: Perspective[]
): ConsolidatedReview;

/**
 * Deduplicate findings: if two findings are in the same file within ±3 lines,
 * keep the one with higher confidence (or higher severity if confidence is equal).
 * Tag the kept finding with all perspectives that found it.
 * @param findings All raw findings from all matrix cells.
 * @returns Deduplicated findings array.
 */
export function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[];

/**
 * Check if two findings are duplicates (same file, within ±3 lines).
 * @param a First finding.
 * @param b Second finding.
 * @returns True if they're considered duplicates.
 */
export function areFindingsDuplicate(a: ReviewFinding, b: ReviewFinding): boolean;

/**
 * Sort findings by severity (high→low), then confidence (high→low), then filename.
 * @param findings Findings to sort.
 * @returns New sorted array.
 */
export function sortFindings(findings: ReviewFinding[]): ReviewFinding[];

/**
 * Cap findings at a maximum count (GitHub hard limit is 100 inline comments).
 * @param findings Sorted findings.
 * @param max Maximum findings to keep.
 * @returns Tuple of [kept, dropped].
 */
export function capFindings(
  findings: ReviewFinding[],
  max: number
): { kept: ReviewFinding[]; dropped: ReviewFinding[] };

/**
 * Merge per-perspective summaries into a consolidated summary.
 * - Highest-severity verdict across all perspectives.
 * - Concatenated "what changed" descriptions.
 * - Per-perspective breakdown of finding counts.
 * @param results Matrix results.
 * @param perspectives Perspectives that were run.
 * @returns Consolidated summary string (Markdown).
 */
export function mergeSummaries(
  results: ReviewMatrixResult,
  perspectives: Perspective[]
): string;

/**
 * Build per-perspective summary entries for the review body.
 * @param results Matrix results.
 * @param perspectives Perspectives that were run.
 * @returns Array of PerspectiveSummary objects.
 */
export function buildPerspectiveSummaries(
  results: ReviewMatrixResult,
  perspectives: Perspective[]
): PerspectiveSummary[];
```

**Implementation notes:**
- `deduplicateFindings`: sort by file, then line. Iterate. For each finding, check if it's within ±3 lines of an already-seen finding in the same file. If yes, compare confidence (high > medium > low) and severity (high > medium > low); keep the "better" one. Merge perspective tags: if finding A was found by "security" and finding B (duplicate) was found by "performance", the kept finding's description gets a note appended: `\n\n*Also identified by: Performance Reviewer*`. Or better: the `perspective` field becomes a comma-separated list: `"security,performance"`.
- Actually, to keep the `perspective` field clean as a single string (since the type says `perspective: string`), we'll append a `foundBy` note to the description instead. The primary `perspective` field stays as the perspective of the kept (highest-confidence) finding.
- `mergeSummaries`: iterate over all successful `BatchReviewResult` objects. Extract the verdict from each summary (regex for 🔴/⚠️/✅ at start). Take the highest-severity verdict. Extract "what changed" from the first result that has it (they should all be similar since they see the same files). Build a per-perspective breakdown table.

### 2.11 `src/pipeline.ts`

Orchestrates the entire 5-stage pipeline. Replaces the inline logic in `index.ts`.

```typescript
import type { PipelineConfig, ConsolidatedReview } from "./types.js";

/**
 * Run the full 5-stage review pipeline.
 * 1. FETCH — parallel diff + file content fetching (concurrency 5)
 * 2. BATCHING — bin-pack with token counting
 * 3. REVIEW — parallel matrix (batches × perspectives), concurrency 3
 * 4. CONSOLIDATION — dedup, sort, cap, merge
 * 5. POST — single consolidated review
 *
 * @param config Pipeline configuration.
 * @returns The posted review ID.
 */
export async function runPipeline(config: PipelineConfig): Promise<number>;
```

**Internal flow of `runPipeline`:**

```typescript
export async function runPipeline(config: PipelineConfig): Promise<number> {
  const octokit = new Octokit({ auth: config.githubToken });

  // ─── STAGE 1: FETCH ──────────────────────────────────────
  core.startGroup("Stage 1: Fetch");
  const allFiles = await fetchDiff(octokit, config.owner, config.repo, config.pullNumber, config.maxDiffSize);
  if (allFiles.length === 0) { core.info("No files with diffs"); return 0; }

  const { kept: files, ignored } = filterIgnoredFiles(allFiles, config.ignorePatterns);
  if (ignored.length > 0) core.info(`Ignored ${ignored.length} generated files: ${ignored.map(f => f.filename).join(", ")}`);
  if (files.length === 0) { core.info("All files ignored"); return 0; }

  const fileContents = await fetchFileContentsParallel(
    octokit, config.owner, config.repo, config.prHeadRef, files, config.fetchConcurrency
  );
  core.endGroup();

  // ─── STAGE 2: BATCHING ───────────────────────────────────
  core.startGroup("Stage 2: Batching");
  const perspectives = getPerspectives(config.perspectives);
  const maxSystemPromptTokens = Math.max(...perspectives.map(p => countTokens(p.systemPrompt)));
  const reviewInstructionsTokens = countTokens(config.reviewInstructions);
  // Cross-file hunks: estimate as ~10% of file budget, capped at 2000 tokens
  const crossFileHunksTokens = Math.min(2000, Math.floor(config.contextWindow * 0.05));
  const tokenBudget = calculateTokenBudget(
    config.contextWindow, config.maxOutputTokens, maxSystemPromptTokens,
    reviewInstructionsTokens, crossFileHunksTokens
  );
  const batches = createBatches(files, fileContents, tokenBudget, config.maxBatches);
  core.info(`Created ${batches.length} batches for ${files.length} files`);
  batches.forEach(b => core.info(`  Batch ${b.index}: ${b.files.length} files, ${b.totalTokenCount} tokens`));
  core.endGroup();

  // ─── STAGE 3: REVIEW (matrix) ────────────────────────────
  core.startGroup("Stage 3: Review (matrix)");
  const semaphore = createSemaphore(config.llmConcurrency);
  const circuitBreaker = createCircuitBreaker(3);
  const llmConfig: LLMCallConfig = {
    apiKey: config.llmApiKey, baseUrl: config.llmBaseUrl,
    model: config.model, fallbackModel: config.fallbackModel,
    maxOutputTokens: config.maxOutputTokens, reasoningEffort: config.reasoningEffort,
    reviewInstructions: config.reviewInstructions, semaphore, circuitBreaker, maxRetries: 3,
  };

  // Build the matrix: batches × perspectives
  const matrixCalls: Array<{ batch: Batch; perspective: Perspective }> = [];
  for (const batch of batches) {
    for (const perspective of perspectives) {
      matrixCalls.push({ batch, perspective });
    }
  }
  core.info(`Matrix: ${batches.length} batches × ${perspectives.length} perspectives = ${matrixCalls.length} LLM calls`);

  const results = await mapWithConcurrency(
    matrixCalls,
    ({ batch, perspective }) => {
      core.info(`  Reviewing batch ${batch.index} as ${perspective.name}...`);
      return reviewBatchFromPerspective(batch, perspective, llmConfig);
    },
    config.llmConcurrency
  );

  const failedBatches = [...new Set(
    results.filter(r => r.error && !r.review.findings.length).map(r => r.batchIndex)
  )];
  const unreviewedFiles = batches
    .filter(b => failedBatches.includes(b.index))
    .flatMap(b => b.files.map(f => f.filename));

  const matrixResult: ReviewMatrixResult = {
    results,
    rawFindings: results.flatMap(r => r.review.findings),
    failedBatches,
    unreviewedFiles,
    totalCalls: matrixCalls.length,
    successfulCalls: results.filter(r => !r.error).length,
  };
  core.info(`Review complete: ${matrixResult.successfulCalls}/${matrixResult.totalCalls} calls succeeded, ${matrixResult.rawFindings.length} raw findings`);
  core.endGroup();

  // ─── STAGE 4: CONSOLIDATION ──────────────────────────────
  core.startGroup("Stage 4: Consolidation");
  const consolidated = consolidateReviews(matrixResult, perspectives);
  core.info(`Consolidated: ${consolidated.findings.length} findings (after dedup), ${consolidated.stats.high} high, ${consolidated.stats.medium} medium, ${consolidated.stats.low} low`);
  if (consolidated.unreviewedFiles.length > 0) {
    core.warning(`Unreviewed files: ${consolidated.unreviewedFiles.join(", ")}`);
  }
  core.endGroup();

  // ─── STAGE 5: POST ───────────────────────────────────────
  core.startGroup("Stage 5: Post");
  const reviewId = await postReview(
    octokit, config.owner, config.repo, config.pullNumber,
    consolidated, files, config.requestChangesOnHigh, config.maxComments
  );
  core.endGroup();

  return reviewId;
}
```

---

## 3. Files to Modify

### 3.1 `src/diff.ts` — Major refactor

**Keep (unchanged):**
- `fetchDiff()` — unchanged signature and behavior.
- `isLineInDiff()` — unchanged (used by post.ts).

**Remove:**
- `formatDiffForPrompt()` — replaced by `buildBatchUserMessage` in `llm-batch.ts`.
- `extractChangedLines()` — moved to `truncation.ts`.

**Modify `fetchFileContents()` → rename to `fetchFileContentsParallel()`:**

```typescript
/**
 * Fetch full file contents for all diff files in parallel with bounded concurrency.
 * Each file's content is returned with line-number prefixes and → markers on changed lines.
 *
 * @param octokit Octokit instance.
 * @param owner Repo owner.
 * @param repo Repo name.
 * @param ref Git ref (PR head branch).
 * @param files Diff files to fetch contents for.
 * @param concurrency Max concurrent API calls (default 5).
 * @returns Map of filename → content (with line numbers and → markers).
 */
export async function fetchFileContentsParallel(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  files: DiffFile[],
  concurrency: number
): Promise<Map<string, string>>;
```

**Implementation:** Uses `mapWithConcurrency` from `concurrency.ts`. For each file: call `octokit.rest.repos.getContent()`, decode base64, split by newlines, prefix each line with `{lineNum}: {→ if changed}`, join. On error (deleted file, binary), skip silently. The `→` marker logic is the same as the current implementation but uses `extractChangedLines` from `truncation.ts`.

**Add `extractDiffHunks()` (used by cross-file context):**

```typescript
/**
 * Extract structured diff hunks from a patch string.
 * @param patch Git diff patch.
 * @returns Array of { oldStart, newStart, oldLines, newLines, content } hunk objects.
 */
export function extractDiffHunks(patch: string): Array<{
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  content: string;
}>;
```

### 3.2 `src/llm.ts` — Slim down, delegate to `llm-batch.ts`

**Keep:**
- `parseReview()` — JSON extraction and parsing logic (used by `llm-batch.ts`).
- `extractJson()` — JSON extraction helper.
- `normalizeFinding()` — finding normalization (but add `perspective` field handling).
- `isValidFinding()` — validation.

**Export these** (currently private) so `llm-batch.ts` can use them:

```typescript
export function parseReview(content: string, perspectiveId: string): StructuredReview;
export function extractJson(content: string): string | null;
export function normalizeFinding(raw: any, perspectiveId: string): ReviewFinding;
export function isValidFinding(f: ReviewFinding): boolean;
```

**Modify `normalizeFinding`:** Add `perspective: perspectiveId` to the returned object.

**Remove:**
- `reviewWithLLM()` — replaced by `reviewBatchFromPerspective` in `llm-batch.ts`.
- `buildUserMessage()` — replaced by `buildBatchUserMessage` in `llm-batch.ts`.

**Or alternatively** (simpler for migration): Keep `llm.ts` as a pure utility module with `parseReview`, `extractJson`, `normalizeFinding`, `isValidFinding` — all exported. Move all call logic to `llm-batch.ts`.

### 3.3 `src/post.ts` — Accept consolidated review

**Modify `postReview()` signature:**

```typescript
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  consolidated: ConsolidatedReview,  // CHANGED: was StructuredReview
  files: DiffFile[],
  requestChangesOnHigh: boolean,
  maxComments: number
): Promise<number>;  // CHANGED: returns reviewId
```

**Modify `buildComments()`:** No change to logic, but `review.findings` is now `consolidated.findings` (same `ReviewFinding[]` shape, now includes `perspective` field).

**Modify `formatCommentBody()`:** Add perspective attribution at the end of each comment body:

```typescript
function formatCommentBody(finding: ReviewFinding): string {
  const severityBadge = severityBadgeMap[finding.severity];
  const confidenceIcon = confidenceIconMap[finding.confidence];
  const parts: string[] = [];
  parts.push(`${severityBadge} **Severity: ${finding.severity.toUpperCase()}**`);
  parts.push(`${confidenceIcon} **Confidence: ${finding.confidence}**`);
  parts.push("");
  parts.push(finding.description);
  if (finding.suggestion) {
    parts.push("");
    parts.push("```suggestion");
    parts.push(finding.suggestion);
    parts.push("```");
  }
  // NEW: perspective attribution
  const perspectiveName = PERSPECTIVE_NAMES[finding.perspective] ?? finding.perspective;
  parts.push("");
  parts.push(`— Found by: **${perspectiveName}**`);
  return parts.join("\n");
}
```

Where `PERSPECTIVE_NAMES` is a simple lookup imported from `perspectives.ts` or inlined:

```typescript
const PERSPECTIVE_NAMES: Record<string, string> = {
  "code-quality": "Code Quality Reviewer",
  "security": "Security Reviewer",
  "performance": "Performance Reviewer",
  "architecture": "Architecture Reviewer",
  "generalist": "General Reviewer",
};
```

**Modify `buildReviewBody()`:** Accept `ConsolidatedReview` instead of `StructuredReview`. Changes:
- Summary section uses `consolidated.summary` (which includes merged per-perspective summaries).
- Posted findings table gets a new "Perspective" column.
- Unposted findings also show perspective.
- Add "Perspective Breakdown" section showing finding counts per perspective.
- Add "Unreviewed Files" section if `consolidated.unreviewedFiles.length > 0`.

```typescript
function buildReviewBody(
  consolidated: ConsolidatedReview,
  postedFindings: Set<ReviewFinding>
): string {
  const parts: string[] = [];
  parts.push(`## ${REVIEW_SIGNATURE}`);
  parts.push("");

  // Stats
  const { stats } = consolidated;
  const statParts: string[] = [];
  if (stats.high > 0) statParts.push(`🔴 **${stats.high} High**`);
  if (stats.medium > 0) statParts.push(`🟡 **${stats.medium} Medium**`);
  if (stats.low > 0) statParts.push(`🔵 **${stats.low} Low**`);
  if (statParts.length === 0) statParts.push("✅ **No issues found**");
  parts.push(statParts.join(" · "));
  parts.push("");

  // Summary (merged)
  if (consolidated.summary) {
    parts.push(consolidated.summary);
    parts.push("");
  }

  // Perspective breakdown
  if (consolidated.perspectiveSummaries.length > 0) {
    parts.push("### 🏷️ Perspective Breakdown");
    parts.push("");
    parts.push("| Perspective | High | Medium | Low | Total |");
    parts.push("|---|---|---|---|---|");
    for (const ps of consolidated.perspectiveSummaries) {
      parts.push(`| ${ps.perspectiveName} | ${ps.highCount} | ${ps.mediumCount} | ${ps.lowCount} | ${ps.findingCount} |`);
    }
    parts.push("");
  }

  // Posted findings (with Perspective column)
  const posted = consolidated.findings.filter(f => postedFindings.has(f));
  if (posted.length > 0) {
    parts.push("### 📋 Posted findings");
    parts.push("");
    parts.push("| # | Severity | Confidence | File | Line | Perspective |");
    parts.push("|---|---|---|---|---|---|");
    for (let i = 0; i < posted.length; i++) {
      const f = posted[i];
      const sevBadge = severityBadgeMap[f.severity];
      const confIcon = confidenceIconMap[f.confidence];
      const shortFile = f.file.split("/").pop() ?? f.file;
      const perspName = PERSPECTIVE_NAMES[f.perspective] ?? f.perspective;
      parts.push(`| **${i + 1}** | ${sevBadge} ${f.severity} | ${confIcon} ${f.confidence} | \`${shortFile}\` | ${f.line} | ${perspName} |`);
    }
    parts.push("");
  }

  // Unposted findings (same as before but with perspective)
  const unposted = consolidated.findings.filter(f => !postedFindings.has(f));
  if (unposted.length > 0) {
    parts.push("---");
    parts.push("### Findings not posted inline");
    parts.push("");
    for (let i = 0; i < unposted.length; i++) {
      const f = unposted[i];
      const sevBadge = severityBadgeMap[f.severity];
      const confIcon = confidenceIconMap[f.confidence];
      const perspName = PERSPECTIVE_NAMES[f.perspective] ?? f.perspective;
      parts.push(`${sevBadge} **${i + 1}** — \`${f.file}:${f.line}\` · ${confIcon} ${f.confidence} · Found by: ${perspName}`);
      parts.push("");
      parts.push(f.description);
      if (f.suggestion) {
        parts.push("");
        parts.push("```suggestion");
        parts.push(f.suggestion);
        parts.push("```");
      }
      parts.push("");
    }
  }

  // Unreviewed files
  if (consolidated.unreviewedFiles.length > 0) {
    parts.push("---");
    parts.push("### ⚠️ Unreviewed files");
    parts.push("");
    parts.push("The following files could not be reviewed (LLM calls failed):");
    parts.push("");
    for (const f of consolidated.unreviewedFiles) {
      parts.push(`- \`${f}\``);
    }
    parts.push("");
  }

  // Pipeline stats footer
  parts.push("---");
  parts.push(`*Batches: ${stats.totalBatches} · Perspectives: ${stats.totalPerspectives} · LLM calls: ${stats.successfulLLMCalls}/${stats.totalLLMCalls}*`);
  parts.push("");
  parts.push("*[Livvie Code Review](https://github.com/4itworks/livvie_code_review)*");

  return parts.join("\n");
}
```

### 3.4 `src/index.ts` — Delegate to pipeline

**Replace the entire `run()` function body** with:

```typescript
import * as core from "@actions/core";
import * as fs from "fs";
import { Octokit } from "@octokit/rest";
import { runPipeline } from "./pipeline.js";
import type { PipelineConfig } from "./types.js";
import { parseIgnorePatterns } from "./ignore-patterns.js";
import { parsePerspectivesInput } from "./perspectives.js";

async function run(): Promise<void> {
  try {
    const context = JSON.parse(
      process.env.GITHUB_EVENT_PATH
        ? fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
        : "{}"
    );
    const pullNumber = context.pull_request?.number;
    if (!pullNumber) {
      core.info("No pull request in event, skipping");
      return;
    }

    const owner = context.repository?.owner?.login;
    const repo = context.repository?.name;
    if (!owner || !repo) {
      throw new Error("Could not determine repository owner/name");
    }

    const config: PipelineConfig = {
      githubToken: core.getInput("github-token", { required: true }),
      owner,
      repo,
      pullNumber,
      prHeadRef: context.pull_request?.head?.ref ?? "",
      prBaseRef: context.pull_request?.base?.ref ?? "main",
      llmApiKey: core.getInput("llm-api-key", { required: true }),
      llmBaseUrl: core.getInput("llm-base-url", { required: true }),
      model: core.getInput("model", { required: true }),
      fallbackModel: core.getInput("fallback-model") || "",
      maxOutputTokens: parseInt(core.getInput("max-output-tokens") || "16000", 10),
      reasoningEffort: core.getInput("reasoning-effort") || "none",
      maxDiffSize: parseInt(core.getInput("max-diff-size") || "50000", 10),
      maxBatches: parseInt(core.getInput("max-batches") || "0", 10),
      contextWindow: parseInt(core.getInput("context-window") || "128000", 10),
      ignorePatterns: parseIgnorePatterns(core.getInput("ignore-patterns") || ""),
      perspectives: parsePerspectivesInput(core.getInput("perspectives") || ""),
      reviewInstructions: await loadReviewInstructions(/* ... */),
      requestChangesOnHigh: core.getInput("request-changes-on-high") !== "false",
      maxComments: parseInt(core.getInput("max-comments") || "25", 10),
      fetchConcurrency: 5,
      llmConcurrency: 3,
    };

    core.info(`Reviewing PR #${pullNumber} in ${owner}/${repo}`);
    core.info(`Perspectives: ${config.perspectives.join(", ")}`);
    core.info(`Max batches: ${config.maxBatches || "unlimited"}`);

    const reviewId = await runPipeline(config);
    if (reviewId > 0) {
      core.info(`Posted review #${reviewId}`);
    }
    core.info("Done");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

// loadReviewInstructions stays the same — fetches from repo via Octokit
async function loadReviewInstructions(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  filePath: string
): Promise<string> {
  // ... same as current implementation
}

run();
```

**Note:** `loadReviewInstructions` must be called before constructing `PipelineConfig` (it's async). So the actual flow in `index.ts` will create the Octokit instance, call `loadReviewInstructions`, then build the config object. The `loadSystemPrompt()` function is **removed** — system prompts now live in `perspectives.ts`.

### 3.5 `action.yml` — New inputs

Add the following inputs (see section 4 for full content):

```yaml
  ignore-patterns:
    description: "Comma-separated glob patterns for files to skip (e.g. *.g.dart,build/). Defaults to generated file patterns."
    required: false
    default: "*.g.dart,*.freezed.dart,*.mocks.dart,*.gen.dart,build/**,dist/**"
  max-batches:
    description: "Maximum number of batches (caps total LLM calls = batches × perspectives). 0 = no limit."
    required: false
    default: "0"
  context-window:
    description: "Context window size in tokens for the model. Used for token budget calculation."
    required: false
    default: "128000"
  perspectives:
    description: "Comma-separated review perspectives to run. Options: code-quality, security, performance, architecture, generalist."
    required: false
    default: "code-quality,security,performance,architecture,generalist"
```

### 3.6 `package.json` — New dependencies

```json
{
  "dependencies": {
    "@actions/core": "^1.11.0",
    "@actions/github": "^6.0.0",
    "@octokit/rest": "^21.0.0",
    "gpt-tokenizer": "^2.5.0"
  }
}
```

### 3.7 `prompts/` directory — New files

The current `prompts/review-system.md` is the generalist prompt. New files:

- `prompts/perspective-code-quality.md` — Code quality specialist prompt
- `prompts/perspective-security.md` — Security specialist prompt
- `prompts/perspective-performance.md` — Performance specialist prompt
- `prompts/perspective-architecture.md` — Architecture specialist prompt
- `prompts/perspective-generalist.md` — Generalist prompt (based on current `review-system.md`)

However, since the action is bundled with `ncc`, file reads at runtime are problematic. **Decision: embed prompts directly in `src/perspectives.ts` as string constants.** This avoids runtime file-path issues with ncc bundling. The `prompts/` directory files are kept for documentation/reference only.

---

## 4. New `action.yml` Inputs (Full File)

```yaml
name: "Livvie Code Review"
description: "AI code review with multi-perspective specialist reviewers, native GitHub suggestion blocks, and REQUEST_CHANGES support. Bring your own LLM key."
author: "4itworks"
branding:
  icon: "eye"
  color: "blue"

inputs:
  github-token:
    description: "GitHub token for posting PR reviews."
    required: true
    default: "${{ github.token }}"
  llm-api-key:
    description: "API key for your LLM provider. This is the only sensitive input — store it as a GitHub Secret."
    required: true
  llm-base-url:
    description: "Base URL for OpenAI-compatible API. Not sensitive — set as a plain string."
    required: false
    default: "https://openrouter.ai/api/v1"
  model:
    description: "Model name (e.g. z-ai/glm-5.2, anthropic/claude-sonnet-4). Not sensitive — set as a plain string."
    required: true
  review-instructions-file:
    description: "Repository file with extra review instructions."
    required: false
    default: ".github/code-reviewer.md"
  max-diff-size:
    description: "Maximum diff size in characters per file."
    required: false
    default: "50000"
  max-output-tokens:
    description: "Maximum tokens for the LLM response (includes reasoning tokens if reasoning is enabled)."
    required: false
    default: "16000"
  reasoning-effort:
    description: "Reasoning effort level for models that support it. Options: none, low, medium, high, max. Ignored by models that don't support reasoning."
    required: false
    default: "none"
  fallback-model:
    description: "Fallback model if the primary model fails after all retries. Set to empty to disable."
    required: false
    default: ""
  request-changes-on-high:
    description: "Post REQUEST_CHANGES when high-severity findings exist."
    required: false
    default: "true"
  max-comments:
    description: "Maximum inline comments to post."
    required: false
    default: "25"
  # ─── NEW INPUTS ──────────────────────────────────────────
  ignore-patterns:
    description: "Comma-separated glob patterns for files to skip (e.g. *.g.dart,build/). Defaults to generated file patterns."
    required: false
    default: "*.g.dart,*.freezed.dart,*.mocks.dart,*.gen.dart,build/**,dist/**"
  max-batches:
    description: "Maximum number of file batches. Each batch is reviewed by every perspective, so total LLM calls = batches × perspectives. 0 = no limit."
    required: false
    default: "0"
  context-window:
    description: "Context window size in tokens for the model. Used for token budget calculation. Override if your model has a different context window."
    required: false
    default: "128000"
  perspectives:
    description: "Comma-separated review perspectives to run. Options: code-quality, security, performance, architecture, generalist. Default runs all five."
    required: false
    default: "code-quality,security,performance,architecture,generalist"

runs:
  using: "node24"
  main: "dist/index.js"
```

---

## 5. Perspective Definitions (System Prompts)

Each perspective shares the **same JSON response format** and **same line-number/suggestion rules** as the current `review-system.md`. What differs is the **focus area** — what the perspective looks for. The shared rules (response format, severity, confidence, suggestion field, line numbers, what not to flag) are extracted into a `SHARED_REVIEW_RULES` constant and appended to every perspective prompt.

### 5.1 Code Quality Reviewer (`code-quality`)

**Focus:** Readability, naming, dead code, complexity, maintainability, DRY violations, proper error handling patterns.

```markdown
You are a **Code Quality Reviewer**. You review code for quality, readability, and maintainability.

## Your focus areas
- **Readability**: unclear variable names, cryptic abbreviations, misleading function names
- **Dead code**: unused imports, unreachable branches, commented-out code
- **Complexity**: overly nested conditionals, functions too long to understand, excessive parameter lists
- **DRY violations**: duplicated logic that should be extracted
- **Error handling**: swallowed exceptions, missing error context, catch-all handlers
- **Naming**: inconsistent naming conventions, names that don't describe what they do

## What you should NOT focus on
- Import ordering (leave that to linters)
- Performance optimization (the Performance Reviewer handles that)
- Security vulnerabilities (the Security Reviewer handles that)
- Architectural patterns (the Architecture Reviewer handles that)

Only flag issues that genuinely harm code quality. Don't nitpick style that matches existing patterns in the file.

${SHARED_REVIEW_RULES}
```

### 5.2 Security Reviewer (`security`)

**Focus:** Injection risks, secret leaks, authentication/authorization bypass, input validation, unsafe operations.

```markdown
You are a **Security Reviewer**. You review code for security vulnerabilities and risks.

## Your focus areas
- **Injection**: SQL injection, command injection, XSS, template injection, path traversal
- **Secrets**: hardcoded API keys, tokens, passwords, secrets in logs or error messages
- **Authentication/Authorization**: missing auth checks, privilege escalation, insecure token handling
- **Input validation**: missing sanitization, trusting user input, unsafe deserialization
- **Crypto**: weak hashing, insecure random, hardcoded IVs, ECB mode
- **Data exposure**: sensitive data in logs, error messages, or URLs
- **Dependencies**: known-vulnerable patterns, unsafe API usage

## What you should NOT focus on
- Code style or readability (Code Quality Reviewer handles that)
- Performance (Performance Reviewer handles that)
- Architectural concerns (Architecture Reviewer handles that)

Only flag genuine security risks. Don't flag theoretical issues that require specific attack conditions unless the attack vector is realistic for this code's context.

${SHARED_REVIEW_RULES}
```

### 5.3 Performance Reviewer (`performance`)

**Focus:** N+1 queries, unnecessary rebuilds, memory leaks, algorithmic complexity, resource management.

```markdown
You are a **Performance Reviewer**. You review code for performance issues and inefficiencies.

## Your focus areas
- **Database**: N+1 queries, missing indexes (if schema is visible), unnecessary queries in loops
- **Memory**: memory leaks, unnecessary allocations in hot paths, unbounded caches/growth
- **Rebuilds**: unnecessary widget rebuilds (Flutter), unnecessary re-renders (React), redundant computations
- **Algorithmic complexity**: O(n²) where O(n) is possible, redundant iterations, early-exit opportunities
- **Resource management**: unclosed streams/connections/controllers, missing dispose/cleanup
- **Caching**: missing cache opportunities, cache invalidation issues
- **Async**: unnecessary awaiting in loops (should use Future.wait), blocking async operations

## What you should NOT focus on
- Code style (Code Quality Reviewer handles that)
- Security (Security Reviewer handles that)
- Architecture (Architecture Reviewer handles that)

Only flag performance issues that would have a real impact. Don't flag micro-optimizations that don't matter in practice.

${SHARED_REVIEW_RULES}
```

### 5.4 Architecture Reviewer (`architecture`)

**Focus:** Separation of concerns, coupling, layering, dependency direction, SOLID principles, design patterns.

```markdown
You are an **Architecture Reviewer**. You review code for architectural soundness and design quality.

## Your focus areas
- **Separation of concerns**: business logic in UI, UI concerns in data layer, mixed responsibilities
- **Coupling**: tight coupling between modules, circular dependencies, unnecessary dependencies
- **Layering**: violations of layer boundaries (e.g., UI directly accessing database)
- **Dependency direction**: dependencies flowing in the wrong direction (e.g., domain depending on UI)
- **SOLID**: single responsibility violations, open/closed principle issues, interface segregation
- **Abstraction**: missing abstractions (primitive obsession), over-abstraction (YAGNI violations)
- **Design patterns**: missing pattern where it would significantly help, anti-patterns

## What you should NOT focus on
- Code style or naming (Code Quality Reviewer handles that)
- Security vulnerabilities (Security Reviewer handles that)
- Performance optimization (Performance Reviewer handles that)

Only flag architectural issues that would cause real maintenance problems. Don't suggest speculative abstractions or patterns "just in case."

${SHARED_REVIEW_RULES}
```

### 5.5 General Reviewer (`generalist`)

**Focus:** Cross-cutting concerns, style, documentation, edge cases, things specialists might miss.

```markdown
You are a **General Code Reviewer**. You review code for issues that span multiple concerns and for things that specialist reviewers might miss.

## Your focus areas
- **Cross-cutting concerns**: issues that don't fit neatly into one category (e.g., a bug that's both a performance and correctness issue)
- **Edge cases**: null/empty handling, boundary conditions, race conditions, off-by-one errors
- **Correctness**: logic errors, wrong variable references, incorrect conditions
- **Documentation**: missing doc comments for public APIs, misleading comments
- **Consistency**: inconsistent error handling within the same module, inconsistent patterns
- **Testing**: obviously untested code paths, testability issues
- **Anything else**: if you see a problem that the specialists wouldn't catch, flag it

## What you should NOT focus on
- Deep dives into security/performance/architecture/quality — the specialists handle those
- Import ordering, formatting (leave to linters)

Flag anything that a thorough senior developer would notice during a code review.

${SHARED_REVIEW_RULES}
```

### Shared Review Rules (`SHARED_REVIEW_RULES` constant)

This is the common suffix appended to every perspective prompt. It contains the JSON response format, severity definitions, confidence definitions, suggestion rules, line number rules, and "what not to flag" rules. This is essentially the content of the current `review-system.md` **minus** the "You are a senior code reviewer" opening (since each perspective has its own opening).

```markdown
## Response format

Return ONLY a JSON object with this exact shape:

{json format spec — same as current review-system.md}

## Rules

### Severity
{same severity rules}

### Confidence
{same confidence rules}

### Description field
{same description rules}

### Suggestion field
{same suggestion rules — INCLUDING the critical rule that `line` = LAST line of suggestion block}

### Line numbers
{same line number rules — CRITICAL: only flag lines marked with →}

### What not to flag
- Import ordering
- Style that matches existing patterns in the same file
- Suggestions to introduce new patterns or abstractions not in the codebase
```

---

## 6. New Dependencies

| Package | Version | Purpose |
|---|---|---|
| `gpt-tokenizer` | `^2.5.0` | Real token counting for bin-packing. GPT-compatible BPE tokenizer, works client-side, no native deps. |

**No other new dependencies.** The concurrency utilities, circuit breaker, glob matching, and everything else are implemented from scratch (they're small enough that a dependency isn't justified, and it keeps the bundle small for the GitHub Action).

Install command:
```bash
npm install gpt-tokenizer@^2.5.0
```

---

## 7. Implementation Order (Dependency Graph)

The implementation must follow this order because each step depends on the previous:

```
Step 1: types.ts (no deps)
   │
   ├──▶ Step 2: concurrency.ts (depends on types.ts)
   │
   ├──▶ Step 3: tokenizer.ts (depends on types.ts, + gpt-tokenizer package)
   │
   ├──▶ Step 4: ignore-patterns.ts (depends on types.ts)
   │
   ├──▶ Step 5: truncation.ts (depends on types.ts, tokenizer.ts)
   │       │
   │       └──▶ Step 6: diff.ts modifications (depends on types.ts, concurrency.ts, truncation.ts)
   │
   ├──▶ Step 7: cross-file.ts (depends on types.ts, tokenizer.ts)
   │
   ├──▶ Step 8: batcher.ts (depends on types.ts, tokenizer.ts, truncation.ts, cross-file.ts)
   │
   ├──▶ Step 9: circuit-breaker.ts (depends on types.ts)
   │
   ├──▶ Step 10: perspectives.ts (depends on types.ts)
   │
   ├──▶ Step 11: llm.ts refactor (depends on types.ts)
   │       │
   │       └──▶ Step 12: llm-batch.ts (depends on types.ts, llm.ts, circuit-breaker.ts, concurrency.ts, perspectives.ts)
   │
   ├──▶ Step 13: consolidation.ts (depends on types.ts, perspectives.ts)
   │
   ├──▶ Step 14: post.ts modifications (depends on types.ts, perspectives.ts)
   │
   └──▶ Step 15: pipeline.ts (depends on ALL above)
           │
           └──▶ Step 16: index.ts (depends on pipeline.ts, types.ts, ignore-patterns.ts, perspectives.ts)
                   │
                   └──▶ Step 17: action.yml + package.json
                           │
                           └──▶ Step 18: Build + verify (npm install, ncc build, typecheck)
```

### Detailed step-by-step:

1. **`src/types.ts`** — Replace with full new type definitions (section 1). No dependencies.
2. **`src/concurrency.ts`** — Create semaphore + mapWithConcurrency + withTimeout. Depends on types.
3. **Install `gpt-tokenizer`** — `npm install gpt-tokenizer`.
4. **`src/tokenizer.ts`** — Token counting + budget calculation. Depends on types + gpt-tokenizer.
5. **`src/ignore-patterns.ts`** — Pattern parsing + matching. Depends on types.
6. **`src/truncation.ts`** — File truncation + extractChangedLines (moved from diff.ts). Depends on types + tokenizer.
7. **`src/diff.ts`** — Refactor: remove formatDiffForPrompt, move extractChangedLines, add fetchFileContentsParallel + extractDiffHunks. Depends on types + concurrency + truncation.
8. **`src/cross-file.ts`** — Cross-file context builder. Depends on types + tokenizer.
9. **`src/batcher.ts`** — Bin-packing algorithm. Depends on types + tokenizer + truncation + cross-file.
10. **`src/circuit-breaker.ts`** — Circuit breaker + backoff. Depends on types.
11. **`src/perspectives.ts`** — Perspective registry + prompts. Depends on types.
12. **`src/llm.ts`** — Refactor: keep parseReview/extractJson/normalizeFinding/isValidFinding as exports, remove reviewWithLLM/buildUserMessage. Depends on types.
13. **`src/llm-batch.ts`** — New LLM caller with matrix support. Depends on types + llm + circuit-breaker + concurrency + perspectives.
14. **`src/consolidation.ts`** — Dedup/sort/cap/merge. Depends on types + perspectives.
15. **`src/post.ts`** — Modify: accept ConsolidatedReview, add perspective columns/attribution. Depends on types + perspectives.
16. **`src/pipeline.ts`** — Orchestrate 5 stages. Depends on ALL.
17. **`src/index.ts`** — Slim down to config + runPipeline. Depends on pipeline + types + ignore-patterns + perspectives.
18. **`action.yml` + `package.json`** — Add new inputs + dependency.
19. **Build + verify** — `npm install && ncc build src/index.ts -o dist --minify && tsc --noEmit`.

---

## 8. Cost / Latency Estimation

### Cost model

```
Total LLM calls = num_batches × num_perspectives
```

With defaults (5 perspectives, max-batches=0/unlimited):
- Small PR (5 files, 1 batch): 5 calls
- Medium PR (20 files, 3 batches): 15 calls
- Large PR (50 files, 8 batches): 40 calls
- Very large PR (100 files, 15 batches): 75 calls

With `max-batches=5` and 5 perspectives: always ≤ 25 calls.

### Token usage per call

Each LLM call uses:
- **Input**: system prompt (~800 tokens) + review instructions (variable, ~200 tokens) + batch file content (up to ~100K tokens for a 128K context window) + cross-file context (~2000 tokens)
- **Output**: up to `max-output-tokens` (default 16K, but typically 2-5K for a batch review)

**Estimated input tokens per call:** ~80% of context window (batch fills most of it)
**Estimated output tokens per call:** ~3K (typical batch review with 5-10 findings)

### Latency estimation

With `llmConcurrency=3` (3 concurrent LLM calls):

| PR Size | Files | Batches | Calls | Wall time (at 3 concurrent, ~15s/call) |
|---|---|---|---|---|
| Small | 5 | 1 | 5 | ~25s (2 waves of 3) |
| Medium | 20 | 3 | 15 | ~75s (5 waves of 3) |
| Large | 50 | 8 | 40 | ~200s (~14 waves) |
| Very large | 100 | 15 | 75 | ~375s (~25 waves) |

With `max-batches=5`:
| PR Size | Batches (capped) | Calls | Wall time |
|---|---|---|---|
| Small | 1 | 5 | ~25s |
| Medium | 3 | 15 | ~75s |
| Large | 5 | 25 | ~125s |
| Very large | 5 | 25 | ~125s |

### Cost estimation (OpenRouter pricing)

Assuming a mid-range model at ~$3/M input, ~$15/M output (e.g. Claude Sonnet tier):

| PR Size | Calls | Input tokens | Output tokens | Est. cost |
|---|---|---|---|---|
| Small (1 batch) | 5 | 5 × 80K = 400K | 5 × 3K = 15K | ~$1.43 |
| Medium (3 batches) | 15 | 15 × 80K = 1.2M | 15 × 3K = 45K | ~$4.28 |
| Large (8 batches) | 40 | 40 × 80K = 3.2M | 40 × 3K = 120K | ~$11.40 |
| Very large (15 batches) | 75 | 75 × 80K = 6M | 75 × 3K = 225K | ~$21.38 |

With `max-batches=5`: cost caps at ~$7.14 regardless of PR size.

**Recommendation:** Document `max-batches` prominently in the README as the primary cost control lever. Default `max-batches=0` (unlimited) is fine for most PRs; large repos should set `max-batches=5`.

---

## 9. Verification Strategy

### 9.1 Type checking

```bash
npx tsc --noEmit
```

Must pass with zero errors after all changes.

### 9.2 Build verification

```bash
npm install
npx ncc build src/index.ts -o dist --minify
```

Must produce a working `dist/index.js` bundle. Verify `gpt-tokenizer` is bundled correctly (ncc should handle this automatically).

### 9.3 Unit test scenarios (manual or scripted)

Since the project has no test framework set up, verification is done via a local test harness:

**Test 1: Token counting**
```typescript
import { countTokens } from "./src/tokenizer.js";
assert(countTokens("hello world") === 2);  // approximately
assert(countTokens("") === 0);
```

**Test 2: Semaphore**
```typescript
import { createSemaphore, mapWithConcurrency } from "./src/concurrency.js";
const sem = createSemaphore(2);
let active = 0, maxActive = 0;
const results = await mapWithConcurrency([1,2,3,4,5], async (i) => {
  const release = await sem.acquire();
  active++; maxActive = Math.max(maxActive, active);
  await sleep(100);
  active--;
  release();
  return i * 2;
}, 2);
assert(maxActive <= 2);
assert(results === [2,4,6,8,10]);
```

**Test 3: Ignore patterns**
```typescript
import { shouldIgnoreFile, parseIgnorePatterns } from "./src/ignore-patterns.js";
const patterns = parseIgnorePatterns("*.g.dart,build/**");
assert(shouldIgnoreFile("lib/user.g.dart", patterns));
assert(shouldIgnoreFile("build/output.js", patterns));
assert(!shouldIgnoreFile("lib/user.dart", patterns));
```

**Test 4: Batching**
```typescript
import { createBatches } from "./src/batcher.js";
// Create 10 mock files with known token counts
// Verify: batches don't exceed token budget, files are sorted, no file split across batches
```

**Test 5: Truncation**
```typescript
import { progressiveTruncate } from "./src/truncation.js";
// Create a large file (1000 lines) with a small patch
// Verify: 10-line window keeps ~20 lines, 5-line window keeps ~10 lines, diff-only returns just patch
```

**Test 6: Deduplication**
```typescript
import { deduplicateFindings, areFindingsDuplicate } from "./src/consolidation.js";
const findings = [
  { file: "a.ts", line: 10, severity: "high", confidence: "high", perspective: "security", ... },
  { file: "a.ts", line: 12, severity: "medium", confidence: "medium", perspective: "performance", ... },
  { file: "a.ts", line: 50, severity: "low", confidence: "low", perspective: "generalist", ... },
];
const deduped = deduplicateFindings(findings);
assert(deduped.length === 2);  // first two are duplicates (within ±3 lines), third is not
assert(deduped[0].perspective === "security");  // higher confidence kept
```

**Test 7: Circuit breaker**
```typescript
import { createCircuitBreaker } from "./src/circuit-breaker.js";
const cb = createCircuitBreaker(3);
assert(!cb.check());
cb.recordFailure(); cb.recordFailure();
assert(!cb.check());  // 2 failures, not yet open
cb.recordFailure();
assert(cb.check());  // 3 failures, now open
cb.recordSuccess();
assert(!cb.check());  // success closes circuit
```

### 9.4 Integration test (real PR)

1. Create a test PR with known issues:
   - A SQL injection vulnerability (security)
   - An N+1 query pattern (performance)
   - A function that's 200 lines long (code quality)
   - Business logic in a UI component (architecture)
   - A missing null check (generalist)
2. Run the action with all 5 perspectives.
3. Verify:
   - Each issue is found by the expected perspective.
   - Findings are tagged with the correct perspective name.
   - Review body shows perspective breakdown table.
   - Inline comments show "Found by: X Reviewer".
   - No duplicate findings (same issue found by multiple perspectives is deduplicated).
4. Run with `perspectives: "security"` only — verify only security findings appear.
5. Run with `max-batches: 1` on a large PR — verify only 1 batch is reviewed (5 calls max).

### 9.5 GitHub Action output verification

Check the GitHub Actions logs for:
- `[Stage 1: Fetch]` group with file counts and ignored files.
- `[Stage 2: Batching]` group with batch count and token counts per batch.
- `[Stage 3: Review (matrix)]` group with per-batch per-perspective progress logging:
  ```
  Reviewing batch 0 as Code Quality Reviewer...
  Reviewing batch 0 as Security Reviewer...
  Reviewing batch 1 as Code Quality Reviewer...
  ```
- `[Stage 4: Consolidation]` group with finding counts after dedup.
- `[Stage 5: Post]` group with review ID.
- Circuit breaker messages if any model failures occur.

---

## Appendix A: File Change Summary

| File | Action | Description |
|---|---|---|
| `src/types.ts` | **Replace** | Full new type system (section 1) |
| `src/concurrency.ts` | **Create** | Semaphore + mapWithConcurrency + withTimeout |
| `src/tokenizer.ts` | **Create** | Token counting + budget calculation |
| `src/ignore-patterns.ts` | **Create** | Generated file pattern matching |
| `src/truncation.ts` | **Create** | Progressive file truncation |
| `src/cross-file.ts` | **Create** | Cross-file diff hunk context |
| `src/batcher.ts` | **Create** | Bin-packing batching algorithm |
| `src/circuit-breaker.ts` | **Create** | Circuit breaker + exponential backoff |
| `src/perspectives.ts` | **Create** | Perspective definitions + prompts |
| `src/llm-batch.ts` | **Create** | Matrix LLM caller (batch × perspective) |
| `src/consolidation.ts` | **Create** | Dedup/sort/cap/merge findings |
| `src/pipeline.ts` | **Create** | 5-stage pipeline orchestrator |
| `src/diff.ts` | **Modify** | Add parallel fetch, remove formatDiffForPrompt, move extractChangedLines |
| `src/llm.ts` | **Modify** | Keep parsers, remove reviewWithLLM/buildUserMessage |
| `src/post.ts` | **Modify** | Accept ConsolidatedReview, add perspective columns |
| `src/index.ts` | **Modify** | Slim down to config + runPipeline |
| `action.yml` | **Modify** | Add 4 new inputs |
| `package.json` | **Modify** | Add gpt-tokenizer dependency |
| `prompts/perspective-*.md` | **Create** | Reference copies of perspective prompts (5 files) |

## Appendix B: Data Flow

```
GitHub API
    │
    ▼
[FETCH] DiffFile[] + Map<filename, content>
    │    (parallel, concurrency 5, ignore generated files)
    │
    ▼
[BATCHING] Batch[]
    │    (bin-pack by tokens, cross-file context assigned)
    │
    ▼
[REVIEW] BatchReviewResult[]
    │    (matrix: batches × perspectives, concurrency 3)
    │    Each cell = 1 LLM call with its own system prompt
    │    Findings tagged with perspective ID
    │
    ▼
[CONSOLIDATION] ConsolidatedReview
    │    (dedup ±3 lines, sort sev→conf→file, cap 100, merge summaries)
    │
    ▼
[POST] GitHub Review
    │    (single review, inline comments with perspective attribution,
    │     summary body with perspective breakdown table)
    │
    ▼
GitHub PR
```

## Appendix C: Prompt Token Budget Visualization

For a 128K context window model:

```
┌─────────────────────────────────────────────────────┐
│                Context Window (128K)                 │
├─────────────────────────────────────────────────────┤
│  System Prompt (perspective-specific)  ~800 tokens  │
├─────────────────────────────────────────────────────┤
│  Review Instructions                ~200 tokens     │
├─────────────────────────────────────────────────────┤
│  Cross-file Context (other batches) ~2000 tokens    │
├─────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────┐   │
│  │         FILE CONTENT BUDGET                 │   │
│  │         (~124K tokens)                      │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐      │   │
│  │  │ File 1  │ │ File 2  │ │ File 3  │      │   │
│  │  │ (trunc. │ │ (full)  │ │ (full)  │      │   │
│  │  │ if big) │ │         │ │         │      │   │
│  │  └─────────┘ └─────────┘ └─────────┘      │   │
│  └─────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────┤
│  Safety Margin                       500 tokens     │
├─────────────────────────────────────────────────────┤
│  Max Output (reserved)             16K tokens       │
└─────────────────────────────────────────────────────┘
```
