# Section 1: New Types

All new types go in `src/types.ts` (existing file, modified).

## Existing types (unchanged)

```typescript
export interface ReviewFinding {
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  file: string;
  line: number;
  description: string;
  suggestion: string | null;
}

export interface DiffFile {
  filename: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
}
```

## New types

```typescript
/** A file with its full content and diff metadata, ready for batching */
export interface FileForReview {
  filename: string;
  patch: string;              // raw diff patch
  additions: number;
  deletions: number;
  fullContent: string | null; // null if file deleted/binary/inaccessible
  tokenCount: number;         // pre-computed token count of formatted content
  directory: string;          // e.g. "src/lib" derived from filename
}

/** A single batch of files to review in one LLM call */
export interface Batch {
  id: number;                 // 0-indexed batch number
  files: FileForReview[];     // files in this batch
  tokenCount: number;         // sum of file token counts + overhead
  crossFileContext: string;   // diff hunks of files in OTHER batches
}

/** Result of a single batch LLM review */
export interface BatchResult {
  batchId: number;
  review: StructuredReview;   // parsed LLM response
  model: string;              // which model produced this
  success: boolean;
  error?: string;              // if success=false
  reviewedFiles: string[];    // filenames that were in the batch
}

/** Configuration for the pipeline, derived from action.yml inputs */
export interface PipelineConfig {
  githubToken: string;
  llmApiKey: string;
  llmBaseUrl: string;
  model: string;
  fallbackModel: string;
  systemPrompt: string;
  reviewInstructions: string;
  maxOutputTokens: number;
  reasoningEffort: string;
  requestChangesOnHigh: boolean;
  maxComments: number;
  maxDiffSize: number;
  ignorePatterns: string[];      // NEW
  maxBatches: number;            // NEW — 0 = unlimited
  contextWindow: number;          // NEW — 0 = use model default
  fetchConcurrency: number;      // default 5
  reviewConcurrency: number;     // default 3
  safetyMargin: number;          // default 500
}

/** Token budget calculation for a batch */
export interface TokenBudget {
  contextWindow: number;
  maxOutput: number;
  systemPromptTokens: number;
  reviewInstructionsTokens: number;
  crossFileHunksTokens: number;
  safetyMargin: number;
  availableForFiles: number;  // contextWindow - maxOutput - systemPrompt - reviewInstructions - crossFileHunks - safetyMargin
}

/** Circuit breaker state */
export interface CircuitBreakerState {
  consecutiveFailures: number;
  tripped: boolean;
  threshold: number;  // default 3
}

/** Consolidated review after merging all batch results */
export interface ConsolidatedReview {
  summary: string;           // programmatically merged
  findings: ReviewFinding[]; // deduplicated + sorted + capped
  unreviewedFiles: string[]; // files from failed batches
  stats: {
    totalBatches: number;
    successfulBatches: number;
    failedBatches: number;
    totalFiles: number;
    reviewedFiles: number;
  };
}

/** Updated StructuredReview — add whatChanged for programmatic summary merge */
export interface StructuredReview {
  summary: string;
  findings: ReviewFinding[];
}
```

## DiffHunk type (for cross-file context)

```typescript
/** A single diff hunk extracted from a patch */
export interface DiffHunk {
  filename: string;
  hunkHeader: string;   // e.g. "@@ -10,5 +12,7 @@"
  hunkContent: string;  // the actual diff lines
  startLine: number;    // new-file start line
}
```
