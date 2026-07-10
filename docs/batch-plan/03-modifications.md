# Section 3: File Modifications

## src/types.ts

**Add** all types from `01-types.md`: `FileForReview`, `Batch`, `BatchResult`, `PipelineConfig`, `TokenBudget`, `CircuitBreakerState`, `ConsolidatedReview`, `DiffHunk`.

**Existing types unchanged:** `ReviewFinding`, `StructuredReview`, `DiffFile`, `ReviewComment`.

---

## src/diff.ts

### Keep (unchanged)
- `fetchDiff()` — still fetches the list of changed files from GitHub API
- `isLineInDiff()` — still used by `post.ts` to validate comment lines

### Modify `fetchFileContents` → `fetchFileContentsParallel`

**Current:** Sequential `for` loop over files, calling `octokit.rest.repos.getContent` one at a time.

**New:**
```typescript
export async function fetchFileContentsParallel(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  files: DiffFile[],
  concurrency: number,
  ignorePatterns: string[]
): Promise<Map<string, string>>;
```

**Changes:**
1. Use `pMapSafe` from `concurrency.ts` to fetch files in parallel (concurrency=5)
2. Filter out files matching `ignorePatterns` BEFORE fetching (saves API calls)
3. Keep the same line-numbering + `→` marker logic
4. Returns `Map<string, string>` as before

### Remove
- `formatDiffForPrompt()` — replaced by `prompt-builder.ts:formatFileForPrompt()`
- The separate diff patch section in the formatted output

### Add
```typescript
/** Extract changed lines from a patch (moved from internal to exported) */
export function extractChangedLines(patch: string): Set<number>;
```
(This is already in the file but not exported — export it for use by `truncation.ts`)

---

## src/llm.ts

### Keep
- `parseReview()` — JSON extraction + finding normalization
- `extractJson()` — fenced code block extraction
- `normalizeFinding()` — finding validation
- `isValidFinding()` — finding validation

### Modify `reviewWithLLM`

**Current signature:**
```typescript
export async function reviewWithLLM(
  apiKey: string,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  diffText: string,
  reviewInstructions: string,
  maxOutputTokens: number,
  reasoningEffort: string
): Promise<StructuredReview>
```

**New signature:**
```typescript
export async function reviewWithLLM(
  apiKey: string,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userMessage: string,          // pre-built by prompt-builder.ts
  maxOutputTokens: number,
  reasoningEffort: string
): Promise<StructuredReview>
```

**Changes:**
1. Remove `buildUserMessage()` from this file — prompt building moves to `prompt-builder.ts`
2. Accept pre-built `userMessage` instead of `diffText` + `reviewInstructions`
3. Replace linear backoff (`attempt * 5` seconds) with:
   - Exponential backoff with jitter from `circuit-breaker.ts`
   - Parse `Retry-After` header from error response
   - Use `max(computedBackoff, retryAfterMs)` for delay
4. Log token estimates: `core.info("Estimated input tokens: ~N")`

### Remove
- `buildUserMessage()` — moved to `prompt-builder.ts`

### Add
```typescript
/**
 * Review a single batch with the LLM, including retry + circuit breaker logic.
 * This is the wrapper that pipeline.ts calls.
 */
export async function reviewBatch(
  apiKey: string,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxOutputTokens: number,
  reasoningEffort: string,
  semaphore: Semaphore,
  circuitBreaker: CircuitBreakerState,
  fallbackModel: string,
  batchId: number,
  totalBatches: number
): Promise<BatchResult>;
```

This function:
1. Acquires semaphore
2. If circuit breaker tripped → skip to fallback model
3. Calls `reviewWithLLM` with retry loop
4. On primary failure → try fallback (if configured)
5. Returns `BatchResult` with success/failure status
6. Releases semaphore in `finally`

---

## src/post.ts

### Keep (mostly unchanged)
- `formatCommentBody()` — comment formatting
- `calculateStartLine()` — suggestion line range
- `shouldRetryWithoutInline()` — error detection
- `dismissStaleReviews()` — cleanup
- `buildReviewBody()` — review body formatting (with modifications below)

### Modify `postReview`

**Current signature:**
```typescript
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  review: StructuredReview,
  files: DiffFile[],
  requestChangesOnHigh: boolean,
  maxComments: number
): Promise<void>
```

**New signature:**
```typescript
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  review: ConsolidatedReview,    // NEW type
  files: DiffFile[],
  requestChangesOnHigh: boolean,
  maxComments: number
): Promise<void>
```

**Changes:**
1. Accept `ConsolidatedReview` instead of `StructuredReview`
2. Cap at 100 inline comments (GitHub hard limit) — even if `maxComments` > 100
3. Add unreviewed files section to review body if `review.unreviewedFiles.length > 0`

### Modify `buildReviewBody`

Add section for unreviewed files:
```markdown
### ⚠️ Files not reviewed

The following files could not be reviewed due to errors:
- `src/failed-file.ts`
- `lib/other.ts`
```

This section appears after the summary, before the posted findings table.

### Modify `buildComments`

Change `maxComments` cap to: `Math.min(maxComments, 100)` — GitHub's hard limit is 100 inline comments.

---

## src/index.ts

**Current:** ~133 lines of inline pipeline logic.

**New:** Slim entry point that reads inputs and delegates to `pipeline.ts`.

```typescript
import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import { Octokit } from "@octokit/rest";
import { runPipeline } from "./pipeline.js";
import type { PipelineConfig } from "./types.js";

async function run(): Promise<void> {
  try {
    const config = readConfig();
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

    core.info(`Reviewing PR #${pullNumber} in ${owner}/${repo}`);
    const octokit = new Octokit({ auth: config.githubToken });
    await runPipeline(octokit, owner, repo, pullNumber, config);
    core.info("Done");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

function readConfig(): PipelineConfig {
  // Read ALL inputs (existing + new) and return PipelineConfig
}

function loadSystemPrompt(): string {
  const promptPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "prompts",
    "review-batch-system.md"   // NEW prompt file
  );
  return fs.readFileSync(promptPath, "utf8");
}

run();
```

**`readConfig()` reads:**
- All existing inputs (github-token, llm-api-key, llm-base-url, model, etc.)
- New inputs:
  - `ignore-patterns` → parse comma-separated → array (merge with defaults)
  - `max-batches` → parseInt, default 0
  - `context-window` → parseInt, default 0 (0 = use model default)
- Returns `PipelineConfig` object

**`loadReviewInstructions()`** moves to `pipeline.ts` or `index.ts` — still uses `octokit.rest.repos.getContent` to fetch from the repo.

---

## prompts/review-batch-system.md (NEW — replaces review-system.md)

Updated system prompt. Key changes from current `review-system.md`:

1. **Add batch context note:** "You are reviewing a BATCH of files from a larger PR. Other files' diffs are provided as context only — do NOT review those files."

2. **Clarify → markers:** "Lines marked with `→` after the line number are changed lines in this PR. Only flag findings on marked lines."

3. **Remove diff patch references:** "The full file with → markers is provided. There is no separate diff patch — the markers indicate what changed."

4. **Keep everything else** — JSON format, severity levels, confidence levels, description format, suggestion format, line number rules, summary format.

---

## action.yml

Add new inputs (see `04-dependencies-inputs.md` for full content).

---

## package.json

Add dependency (see `04-dependencies-inputs.md`).
