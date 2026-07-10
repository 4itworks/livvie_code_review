# Section 2: New Files with Function Signatures

## src/tokenizer.ts

```typescript
import { encode } from "gpt-tokenizer";

/** Count tokens in a string using cl100k_base encoding (GPT-4 family) */
export function countTokens(text: string): number;

/** Count tokens for a formatted file (line-numbered, with markers) */
export function countFileTokens(formattedContent: string): number;

/**
 * Compute the token budget available for file content in a batch.
 * Formula: context_window - max_output - system_prompt - review_instructions
 *         - cross_file_hunks - safety_margin(500)
 */
export function computeTokenBudget(params: {
  contextWindow: number;
  maxOutput: number;
  systemPrompt: string;
  reviewInstructions: string;
  crossFileHunks: string;
  safetyMargin: number;
}): TokenBudget;
```

**Implementation details:**
- Use `gpt-tokenizer` with `model: "gpt-4"` (cl100k_base) — it's the closest universal approximation for all models (Claude, GPT, GLM, etc.)
- `countTokens` calls `encode(text).length`
- Memoize/cache results for repeated strings (system prompt, review instructions)
- `computeTokenBudget` returns the `TokenBudget` type with `availableForFiles` pre-computed

---

## src/concurrency.ts

```typescript
/** Simple counting semaphore for concurrency limiting */
export class Semaphore {
  constructor(maxConcurrency: number);
  /** Acquire a permit, blocks until one is available */
  async acquire(): Promise<void>;
  /** Release a permit */
  release(): void;
  /** Run a function with concurrency limit */
  async runWith<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Map over items with limited concurrency.
 * @param items Array to process
 * @param mapper Async function for each item
 * @param concurrency Max concurrent operations
 * @returns Array of results in same order as input
 */
export async function pMap<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]>;

/**
 * Map over items with limited concurrency, catching errors.
 * Failed items get `null` in result array + error logged.
 */
export async function pMapSafe<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<Array<R | null>>;
```

**Implementation details:**
- `Semaphore` uses a Promise-based queue internally
- `pMap` spawns up to `concurrency` promises at a time, collects results
- `pMapSafe` wraps each call in try/catch, logs errors via `core.warning`, returns `null` on failure
- No external dependencies — pure TypeScript

---

## src/ignore-patterns.ts

```typescript
/**
 * Check if a filename matches any ignore pattern.
 * Supports glob-style patterns: *.g.dart, build/**, dist/**
 */
export function shouldIgnoreFile(filename: string, patterns: string[]): boolean;

/** Default ignore patterns for generated files */
export const DEFAULT_IGNORE_PATTERNS: string[];
```

**Default patterns:**
```typescript
export const DEFAULT_IGNORE_PATTERNS = [
  "*.g.dart",
  "*.freezed.dart",
  "*.mocks.dart",
  "build/**",
  "dist/**",
];
```

**Matching logic:**
- Convert glob to regex: `*.g.dart` → `^.*\.g\.dart$`, `build/**` → `^build/.*$`
- Support `*` (any chars except `/`) and `**` (any chars including `/`)
- Match against full filename path

---

## src/truncation.ts

```typescript
import type { FileForReview } from "./types.js";

/**
 * Truncate a file's content to a window around diff hunks.
 * Preserves original line numbers via truncation markers.
 *
 * @param content Full file content with line numbers (e.g. "42: → code")
 * @param patch Diff patch for this file
 * @param windowSize Lines of context around each hunk (10, 5, or 0 for diff-only)
 * @returns Truncated content with markers like:
 *          "42: → code\n... (lines 43-100 truncated) ...\n101: → code"
 */
export function truncateFileToWindow(
  content: string,
  patch: string,
  windowSize: number
): string;

/**
 * Try progressively smaller windows until the file fits the token budget.
 * Order: 10-line window → 5-line window → diff-only (window=0)
 *
 * @param file The file to truncate
 * @param tokenBudget Maximum tokens available for this file
 * @returns Truncated content that fits within budget, or null if even diff-only exceeds
 */
export function truncateToBudget(
  file: FileForReview,
  tokenBudget: number
): string | null;

/** Extract the set of line numbers that are part of diff hunks (new file side) */
export function extractChangedLines(patch: string): Set<number>;
```

**Truncation marker format:**
```
278: →     if (location.id == null) {
279:         DSSnackBar.show(
... (lines 280-285 truncated, 6 lines omitted) ...
286:       return;
287:     }
```

- Markers preserve the exact original line numbers so LLM references are accurate
- `windowSize=0` means diff-only: just the changed lines + immediate context (0 extra lines)

---

## src/cross-file.ts

```typescript
import type { DiffHunk, FileForReview } from "./types.js";

/**
 * Extract individual diff hunks from a patch string.
 * @returns Array of DiffHunk objects
 */
export function extractDiffHunks(patch: string, filename: string): DiffHunk[];

/**
 * Build the cross-file context string for a batch.
 * Contains diff hunks of files in OTHER batches, prefixed with:
 * "## Context (do not review these files — for cross-file understanding only)"
 *
 * @param currentBatchFiles Filenames in the current batch
 * @param allFiles All files being reviewed
 * @returns Formatted string of diff hunks from other batches' files
 */
export function buildCrossFileContext(
  currentBatchFiles: string[],
  allFiles: FileForReview[]
): string;

/**
 * Compute token count of cross-file context for a batch.
 * Used in token budget calculation.
 */
export function countCrossFileTokens(
  currentBatchFiles: string[],
  allFiles: FileForReview[]
): number;
```

**Output format:**
```markdown
## Context (do not review these files — for cross-file understanding only)

### src/other-file.ts
```diff
@@ -10,5 +12,7 @@
-old code
+new code
```

### lib/utils.ts
```diff
@@ -1,3 +1,4 @@
+import { foo } from 'bar';
```
```

---

## src/batcher.ts

```typescript
import type { Batch, FileForReview, TokenBudget } from "./types.js";

/**
 * Create batches using bin-packing algorithm.
 *
 * Algorithm:
 * 1. Sort files alphabetically by filename (deterministic)
 * 2. Group by directory preferentially
 * 3. Bin-pack into batches respecting token budget
 * 4. Never split a single file across batches
 * 5. If file alone exceeds budget, use truncation (progressive window reduction)
 * 6. Add cross-file diff hunk context to each batch
 * 7. Cap at maxBatches if specified
 *
 * @param files Files to batch (already had ignore-patterns applied)
 * @param budget Token budget per batch
 * @param maxBatches Maximum number of batches (0 = unlimited)
 * @returns Array of Batch objects
 */
export function createBatches(
  files: FileForReview[],
  budget: TokenBudget,
  maxBatches: number
): Batch[];
```

**Algorithm details (pseudocode):**
```
1. Sort files alphabetically: files.sort((a,b) => a.filename.localeCompare(b.filename))
2. Group by directory: Map<string, FileForReview[]>
3. Flatten groups back to a list (preserving directory grouping)
4. Initialize: currentBatch = [], currentTokens = 0, batches = []
5. For each file:
   a. fileTokens = file.tokenCount (or truncated tokenCount if file > availableForFiles)
   b. If file alone > availableForFiles:
      - Truncate: 10-line window → 5-line → diff-only
      - Recalculate fileTokens after truncation
   c. If currentTokens + fileTokens > availableForFiles AND currentBatch not empty:
      - Push currentBatch to batches
      - Start new batch with this file
   d. Else:
      - Add file to currentBatch, currentTokens += fileTokens
6. Push final batch if not empty
7. If maxBatches > 0 AND batches.length > maxBatches:
   - Re-bin with larger budget (reclcolculate: availableForFiles = availableForFiles * batches.length / maxBatches)
   - OR merge batches until we hit maxBatches (warn about potential token overflow)
8. For each batch, compute crossFileContext from files in other batches
9. Return batches
```

**Max-batches handling:**
- If `maxBatches > 0` and natural batching produces more than `maxBatches`:
  - Redistribute: compute budget = totalFileTokens / maxBatches, re-bin with that budget
  - If individual files still exceed the redistributed budget, they get truncated
  - Log a warning: "Forced into {maxBatches} batches — some files may be truncated"
