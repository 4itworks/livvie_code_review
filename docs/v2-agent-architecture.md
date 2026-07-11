# Livvie Code Review v2 Architecture: User-Defined Agent Files

**Status:** Design  
**Date:** 2026-07-11  
**Breaking change:** Yes (v2)

---

## 1. Problem Statement

v1 hardcodes 5 review perspectives in `src/perspectives.ts` as `PERSPECTIVE_REGISTRY`. Users can only pick from these 5 via the `perspectives` action input. They cannot customize prompts, add domain-specific reviewers, or change LLM parameters per reviewer.

v2 replaces this with user-defined agent files in `.github/livvie_code_review_agents/*.md`. Each `.md` file = one review agent. The action scans that folder, parses each file, and runs all enabled agents.

---

## 2. Agent File Schema

### 2.1 File Location

```
.github/livvie_code_review_agents/
  security.md
  performance.md
  generalist.md
  my-custom-agent.md
```

### 2.2 File Format

Each file is a Markdown document with YAML frontmatter (delimited by `---`). The body is the agent's system prompt.

```markdown
---
name: Security Reviewer
description: Reviews code for security vulnerabilities and risks
enabled: true
model: null
temperature: 0.1
weight: 1
---

You are a **Security Reviewer**. You review code for security vulnerabilities.

## Your focus areas
- Injection: SQL injection, command injection, XSS
- Secrets: hardcoded API keys, tokens, passwords
- Authentication: missing auth checks, privilege escalation
...
```

### 2.3 Frontmatter Fields

| Field         | Type    | Required | Default    | Description |
|---------------|---------|----------|------------|-------------|
| `name`        | string  | **yes**  | —          | Human-readable name shown in PR comments and summaries. Must be unique across agents. |
| `description` | string  | no       | `""`       | Short description (informational, logged at startup). |
| `enabled`     | boolean | no       | `true`     | If `false`, the agent is skipped. Allows keeping agent files without running them. |
| `model`       | string  | no       | `null`     | Override the global `model` for this agent only. `null` = use global. |
| `temperature` | number  | no       | `0.1`     | LLM temperature override for this agent. |
| `weight`      | number  | no       | `1`        | Reserved for future use (e.g., finding score weighting). Must be > 0. |

**Intentionally omitted (YAGNI):**
- `max-output-tokens` override — rare need, global is fine
- `reasoning-effort` override — rare need
- `fallback-model` override — global is fine
- `priority` / ordering — agents run in parallel, order is irrelevant
- `focus` — derived from the body (the system prompt describes the focus)

### 2.4 Body (System Prompt)

Everything after the closing `---` of the frontmatter is the agent's system prompt. It is the full prompt sent to the LLM as the `system` message. The action automatically appends `SHARED_REVIEW_RULES` (the JSON format spec, severity/confidence definitions, suggestion rules, etc.) — the user does NOT need to include it.

This means the user writes their persona/focus description, and the action handles the output format contract.

### 2.5 Example: Minimal Agent File

```markdown
---
name: General Reviewer
---

You are a **General Code Reviewer**. You review code for issues that span multiple concerns.

## Your focus areas
- Edge cases: null handling, boundary conditions, race conditions
- Correctness: logic errors, wrong variable references
- Anything else a senior developer would notice
```

### 2.6 Example: Full Agent File

```markdown
---
name: Flutter Widget Reviewer
description: Specialized reviewer for Flutter widget tree issues
model: anthropic/claude-sonnet-4
temperature: 0.2
---

You are a **Flutter Widget Reviewer** specializing in widget tree correctness.

## Your focus areas
- Unnecessary rebuilds: widgets that rebuild when they shouldn't
- Missing const constructors
- Incorrect use of StatefulWidget vs StatelessWidget
- Key usage: missing keys in lists, wrong key types
- BuildContext misuse: using context after async gaps

## What you should NOT focus on
- General code quality (other reviewers handle that)
- Security issues (other reviewers handle that)
```

---

## 3. Agent Loader Module (`src/agent-loader.ts`)

### 3.1 Responsibilities

1. Discover `.md` files in `.github/livvie_code_review_agents/` via the GitHub API (same pattern as `loadReviewInstructions` in `index.ts`)
2. Parse YAML frontmatter + body from each file
3. Validate each parsed agent
4. Convert each agent into a `Perspective` object (the internal contract)
5. Handle edge cases: malformed files, empty folder, duplicate names

### 3.2 Frontmatter Parsing

**Decision: Custom regex parser (no new dependency).**

The frontmatter format is trivially simple — only 6 fields, all scalar. A regex-based parser is ~30 lines. Adding `gray-matter` (70+ transitive deps) violates the "no new dependencies unless absolutely necessary" constraint.

```typescript
interface RawAgentFrontmatter {
  name?: unknown;
  description?: unknown;
  enabled?: unknown;
  model?: unknown;
  temperature?: unknown;
  weight?: unknown;
}

function parseFrontmatter(content: string): {
  frontmatter: RawAgentFrontmatter;
  body: string;
} {
  // Match: --- at start, YAML content, --- delimiter, rest is body
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const yamlBlock = match[1];
  const body = match[2].trim();
  const frontmatter: RawAgentFrontmatter = {};
  
  for (const line of yamlBlock.split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      const key = kv[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // camelCase
      let value: unknown = kv[2].trim();
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (value === 'null' || value === '') value = null;
      else if (!isNaN(Number(value))) value = Number(value);
      frontmatter[key as keyof RawAgentFrontmatter] = value;
    }
  }
  return { frontmatter, body };
}
```

### 3.3 API Discovery

The action runs in GitHub Actions where it reads the repo via Octokit. The agent files live in the PR's base branch (same as `review-instructions-file`). Discovery uses `octokit.rest.repos.getContent` on the directory path.

```typescript
export async function loadAgents(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  agentsDir: string, // '.github/livvie_code_review_agents'
): Promise<Perspective[]>
```

**Flow:**
1. `repos.getContent({ path: agentsDir, ref })` — returns directory listing
2. Filter to `*.md` files
3. Fetch each file's content via `repos.getContent({ path: file.path, ref })`
4. Parse frontmatter + body for each
5. Validate and convert to `Perspective[]`

### 3.4 Validation Rules

| Condition | Behavior |
|-----------|----------|
| `name` missing or empty | **Fail-fast** with error naming the file. Name is required for attribution in PR comments. |
| `name` duplicates another agent | **Fail-fast** with error listing both files. Names must be unique (used as `foundBy` keys). |
| `enabled: false` | Skip silently. Log at debug level. |
| `model` is non-null string | Accept as model override (stored in new `Agent` interface, passed through to LLM). |
| `temperature` outside 0-2 | Warn and clamp to 0.1. |
| `weight` <= 0 | Warn and set to 1. |
| Body is empty | **Fail-fast**. An agent with no system prompt is useless. |
| No frontmatter at all | Treat the entire file as the body. Derive `name` from filename (e.g., `security.md` → `"security"`). This enables ultra-minimal agent files. |
| File is not `.md` | Skip silently. |

### 3.5 Empty Folder Behavior

| Scenario | Behavior |
|----------|----------|
| Folder doesn't exist | **Fail-fast** with message: "No agent files found at .github/livvie_code_review_agents/. Create at least one agent .md file. See docs for examples." |
| Folder exists but is empty | Same as above. |
| All agents have `enabled: false` | **Fail-fast** with message: "All agents are disabled." |
| All agents fail validation | **Fail-fast** with aggregated error. |

**No built-in defaults.** v2 makes agents explicit. If the user has no agent files, the action fails. This is intentional — it forces conscious configuration and avoids silent "it does nothing" bugs.

### 3.6 SHARED_REVIEW_RULES Handling

`SHARED_REVIEW_RULES` stays hardcoded in the source (moved to a dedicated `src/shared-rules.ts` module). It is **automatically appended** to every agent's body to form the complete `systemPrompt`. The user does NOT write format rules in their agent files.

```typescript
const systemPrompt = agentBody + '\n\n' + SHARED_REVIEW_RULES;
```

This is the right call because:
- The JSON output format contract is an implementation detail of the action
- Users would copy-paste it wrong if it were their responsibility
- It lets us evolve the format rules without touching every agent file

---

## 4. Changes to Types (`src/types.ts`)

### 4.1 New Interface: `AgentDefinition`

The raw parsed agent before it becomes a `Perspective`. This carries the optional model/temperature overrides that `Perspective` doesn't have.

```typescript
export interface AgentDefinition {
  name: string;
  description: string;
  enabled: boolean;
  model: string | null;
  temperature: number;
  weight: number;
  systemPrompt: string; // body + SHARED_REVIEW_RULES already appended
  sourceFile: string;   // e.g., 'security.md' — for error messages
}
```

### 4.2 Perspective Interface — No Changes

`Perspective` remains the internal contract. It is unchanged:

```typescript
export interface Perspective {
  id: string;        // derived from filename (e.g., 'security' from 'security.md')
  name: string;      // from frontmatter
  systemPrompt: string;
  focus: string;     // derived from description or first heading in body
}
```

The pipeline, consolidation, and post modules continue to work with `Perspective[]`. The agent loader converts `AgentDefinition → Perspective`.

### 4.3 PipelineConfig Changes

```typescript
export interface PipelineConfig {
  // ... existing fields unchanged ...
  
  // REMOVED:
  // perspectives: string[];   // no longer needed
  
  // ADDED:
  agentsDir: string;           // '.github/livvie_code_review_agents' (configurable)
  
  // For per-agent model overrides, we need a lookup:
  agentModelOverrides: Map<string, { model: string | null; temperature: number }>;
}
```

**Alternative (simpler):** Instead of a separate map, pass `AgentDefinition[]` alongside `Perspective[]` through the pipeline. But this leaks the agent concept into pipeline stages that only care about `Perspective`. The map approach keeps the pipeline clean — only `llm-batch.ts` needs the overrides.

### 4.4 BatchReviewResult — No Changes

The `BatchReviewResult` already has `modelUsed` and `usedFallback`. No changes needed.

### 4.5 Changes Summary

| Type | Change |
|------|--------|
| `Perspective` | **No change** |
| `PipelineConfig` | Remove `perspectives: string[]`, add `agentsDir: string`, add `agentModelOverrides` |
| `BatchReviewResult` | **No change** |
| `ReviewFinding` | **No change** (`.perspective` and `.foundBy` still use string IDs) |
| `ConsolidatedReview` | **No change** |
| `PerspectiveSummary` | **No change** |
| New: `AgentDefinition` | **New** — intermediate type between raw .md and `Perspective` |

---

## 5. Changes to Pipeline Stages

### 5.1 Stage 2: Batching

**Current code (pipeline.ts:61-62):**
```typescript
const perspectives = getPerspectives(config.perspectives);
const maxSystemPromptTokens = Math.max(...perspectives.map(p => countTokens(p.systemPrompt)));
```

**v2 code:**
```typescript
const perspectives = await loadAgents(octokit, config.owner, config.repo, config.prBaseRef, config.agentsDir);
const maxSystemPromptTokens = Math.max(...perspectives.map(p => countTokens(p.systemPrompt)));
```

The only change is the source of `perspectives`. The token budget calculation is identical — `max(systemPromptTokens)` across all agents. This works because agents with different model overrides still share the same context window (the batching is about fitting files into context, not about model-specific limits).

**Edge case:** If a per-agent model has a *smaller* context window than the global `context-window` config, batches could be too large for that model. This is a known limitation documented as "set `context-window` to the smallest model you use." Solving this properly (per-agent batching) is over-engineering for v2.

### 5.2 Stage 3: Review (Matrix)

**Current code (pipeline.ts:95-112):**
```typescript
const matrixCalls: Array<{ batch: Batch; perspective: Perspective }> = [];
for (const batch of batches) {
  for (const perspective of perspectives) {
    matrixCalls.push({ batch, perspective });
  }
}
// ... mapWithConcurrency calls reviewBatchFromPerspective(batch, perspective, llmConfig)
```

**v2 changes:**

The matrix pattern stays the same. The only change is that `reviewBatchFromPerspective` needs access to per-agent model/temperature overrides.

**Option A (chosen): Pass overrides through LLMCallConfig**

```typescript
// In pipeline.ts, when building the matrix:
const llmConfig: LLMCallConfig = {
  // ... existing fields ...
};

// When calling reviewBatchFromPerspective, merge agent overrides:
for (const { batch, perspective } of matrixCalls) {
  const overrides = config.agentModelOverrides.get(perspective.id);
  const effectiveConfig = overrides
    ? { ...llmConfig, model: overrides.model ?? llmConfig.model, temperature: overrides.temperature }
    : llmConfig;
  // use effectiveConfig
}
```

**Simpler approach (chosen for v2):** Add `model` and `temperature` as optional fields to the matrix call tuple:

```typescript
const matrixCalls: Array<{
  batch: Batch;
  perspective: Perspective;
  modelOverride?: string;
  temperatureOverride?: number;
}> = [];
```

This keeps `LLMCallConfig` unchanged and makes the override flow explicit.

### 5.3 Stage 4: Consolidation — No Changes

`consolidateReviews(matrixResult, perspectives)` works with `Perspective[]`. No changes.

### 5.4 Stage 5: Post — See Section 6

---

## 6. Changes to `post.ts`

### 6.1 The Problem

`post.ts` imports `PERSPECTIVE_REGISTRY` to resolve perspective IDs to names:

```typescript
// Line 4, 148, 240, 257:
import { PERSPECTIVE_REGISTRY } from "./perspectives.js";
const perspectiveNames = finding.foundBy.map(id => PERSPECTIVE_REGISTRY[id]?.name ?? id);
```

With user-defined agents, `PERSPECTIVE_REGISTRY` no longer exists. The agent names must come from somewhere.

### 6.2 Solution: Pass a Name Lookup Map

`postReview()` already receives `consolidated: ConsolidatedReview`. Add a `perspectiveNameMap: Map<string, string>` parameter:

```typescript
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  consolidated: ConsolidatedReview,
  files: DiffFile[],
  requestChangesOnHigh: boolean,
  maxComments: number,
  perspectiveNameMap: Map<string, string>,  // NEW
): Promise<number>
```

Built from the loaded agents in `pipeline.ts`:

```typescript
const perspectiveNameMap = new Map(perspectives.map(p => [p.id, p.name]));
```

Used in `formatCommentBody` and `buildReviewBody`:

```typescript
// Before (post.ts:148):
const perspectiveNames = finding.foundBy.map(id => PERSPECTIVE_REGISTRY[id]?.name ?? id);

// After:
const perspectiveNames = finding.foundBy.map(id => perspectiveNameMap.get(id) ?? id);
```

This replaces 4 occurrences of `PERSPECTIVE_REGISTRY` lookups in `post.ts`.

### 6.3 "Perspective Breakdown" Section Header

The PR comment body says "### 🏷️ Perspective Breakdown". This becomes "### 🏷️ Agent Breakdown" for consistency with the new terminology. The `PerspectiveSummary` type name stays unchanged internally (YAGNI rename).

---

## 7. Changes to `action.yml`

### 7.1 Removed Input

```yaml
# REMOVED:
perspectives:
  description: "Comma-separated review perspectives to run..."
  required: false
  default: "generalist"
```

### 7.2 New Input

```yaml
# ADDED:
agents-dir:
  description: "Directory containing agent .md files (relative to repo root)."
  required: false
  default: ".github/livvie_code_review_agents"
```

### 7.3 Migration Note

Users who had `perspectives: security,performance` must now create corresponding `.md` files in the agents directory. The old `perspectives` input is silently ignored (not a hard error) for smoother migration — but a warning is logged if it's set.

---

## 8. Changes to `index.ts`

### 8.1 Agent Loading Moves to index.ts

Currently, `index.ts` calls `parsePerspectivesInput()` and passes `config.perspectives: string[]` to the pipeline, which then calls `getPerspectives()` in Stage 2.

In v2, `index.ts` loads the agents early (after creating the Octokit client) and passes the resolved `Perspective[]` + overrides directly to the pipeline:

```typescript
// In index.ts:
const agentsDir = core.getInput('agents-dir') || '.github/livvie_code_review_agents';

// Warn about deprecated input
const legacyPerspectives = core.getInput('perspectives');
if (legacyPerspectives && legacyPerspectives !== 'generalist') {
  core.warning(
    'The "perspectives" input is deprecated in v2. ' +
    'Create agent .md files in ' + agentsDir + ' instead.'
  );
}

const { perspectives, agentModelOverrides } = await loadAgents(
  octokit, owner, repo, prBaseRef, agentsDir
);

const config: PipelineConfig = {
  // ... existing fields ...
  // perspectives: [] REMOVED
  agentsDir,
  agentModelOverrides,
};
```

### 8.2 Pipeline Signature Change

```typescript
// Before:
export async function runPipeline(config: PipelineConfig): Promise<...>

// After:
export async function runPipeline(
  config: PipelineConfig,
  perspectives: Perspective[],  // resolved agents passed in
): Promise<{ reviewId: number; findingCount: number }>
```

This is cleaner because the pipeline doesn't need to know about agent discovery. It receives ready-to-use `Perspective[]` objects.

---

## 9. New File: `src/shared-rules.ts`

Extract `SHARED_REVIEW_RULES` from `perspectives.ts` into its own module. It's ~140 lines of the JSON format contract and is the only part of the old perspectives system that survives.

```typescript
// src/shared-rules.ts
export const SHARED_REVIEW_RULES = `## Response format
... (existing content, unchanged) ...
`;
```

Imported by `agent-loader.ts` to append to each agent's body.

---

## 10. File-by-File Change Summary

| File | Action | Summary |
|------|--------|---------|
| `src/agent-loader.ts` | **NEW** | Agent discovery, frontmatter parsing, validation, Perspective conversion |
| `src/shared-rules.ts` | **NEW** | Extracted `SHARED_REVIEW_RULES` constant |
| `src/types.ts` | **MODIFY** | Add `AgentDefinition` interface. Remove `perspectives` from `PipelineConfig`, add `agentsDir` and `agentModelOverrides`. |
| `src/perspectives.ts` | **DELETE** | Entire file removed. No more `PERSPECTIVE_REGISTRY`, `getPerspectives`, `parsePerspectivesInput`. |
| `src/perspectives.test.ts` | **DELETE** | Tests for deleted module. Replace with `agent-loader.test.ts`. |
| `src/index.ts` | **MODIFY** | Import `loadAgents` instead of `parsePerspectivesInput`. Load agents early, pass to `runPipeline`. Add `agents-dir` input reading. Log deprecation warning for `perspectives` input. |
| `src/pipeline.ts` | **MODIFY** | Accept `perspectives: Perspective[]` as parameter instead of calling `getPerspectives(config.perspectives)`. Pass model overrides to LLM calls. |
| `src/llm-batch.ts` | **MODIFY** | Accept optional `model` and `temperature` overrides in `reviewBatchFromPerspective` (or via `LLMCallConfig`). |
| `src/post.ts` | **MODIFY** | Accept `perspectiveNameMap: Map<string, string>` parameter. Replace all `PERSPECTIVE_REGISTRY` lookups. Change "Perspective Breakdown" to "Agent Breakdown". |
| `src/consolidation.ts` | **NO CHANGE** | Already works with `Perspective[]` parameter. |
| `src/tokenizer.ts` | **NO CHANGE** | |
| `src/diff.ts` | **NO CHANGE** | |
| `src/batcher.ts` | **NO CHANGE** | |
| `src/llm.ts` | **NO CHANGE** | |
| `src/concurrency.ts` | **NO CHANGE** | |
| `src/circuit-breaker.ts` | **NO CHANGE** | |
| `src/suggestion.ts` | **NO CHANGE** | |
| `src/ignore-patterns.ts` | **NO CHANGE** | |
| `action.yml` | **MODIFY** | Remove `perspectives` input, add `agents-dir` input. |

---

## 11. Migration Strategy

### 11.1 For Users

Users upgrading from v1 to v2 need to:

1. Create `.github/livvie_code_review_agents/` directory
2. Add one or more `.md` agent files
3. Remove the `perspectives` input from their workflow YAML (or leave it — it's ignored with a warning)

**Provided migration assets:**
- Example agent files for all 5 v1 perspectives (code-quality.md, security.md, performance.md, architecture.md, generalist.md) shipped in the repo's `examples/` directory or docs
- These are exact ports of the hardcoded prompts from v1's `perspectives.ts`

### 11.2 Breaking Changes

| v1 Behavior | v2 Behavior | Migration |
|-------------|-------------|-----------|
| `perspectives: security,performance` | No such input | Create `security.md` and `performance.md` in agents dir |
| Default `perspectives: generalist` | No agents dir → fail | Create at least `generalist.md` |
| `PERSPECTIVE_REGISTRY` for name lookup | `perspectiveNameMap` from loaded agents | Automatic (internal) |

### 11.3 Deprecation Path

v2 is a clean break. The `perspectives` input is not functional but logs a deprecation warning if set. This is not a "soft migration where both work" — it's "new system, old input ignored."

---

## 12. Edge Cases

| Edge Case | Behavior |
|-----------|----------|
| Agent file has no frontmatter (`---` delimiters) | Entire file is the body. Name derived from filename. |
| Agent file has frontmatter but no body | **Fail-fast**: "Agent 'foo' in foo.md has no system prompt body." |
| Two agents with the same `name` | **Fail-fast**: "Duplicate agent name 'Security Reviewer' in security.md and security-v2.md." |
| Agent file name conflicts (e.g., `Security.md` vs `security.md`) | Case-sensitive on Linux, case-insensitive on Windows/macOS. Agents are keyed by filename stem (lowercased). Warn if collision detected. |
| Agent `model` points to a model that doesn't exist | Normal LLM failure handling (retry → fallback → error). No special validation. |
| 0 agents pass validation | **Fail-fast** at load time. |
| 100+ agent files | Works, but 100 agents × N batches = many LLM calls. Log a warning if > 10 agents. |
| Agent body contains `---` | The parser splits on the *first* `---` pair at the start. Subsequent `---` in the body are preserved. |
| Agent body contains YAML-like content | Only the first block between `---` delimiters is parsed as YAML. The rest is body. |
| `agents-dir` points to a non-existent path | **Fail-fast** with clear message. |
| File extension is `.MD` (uppercase) | Accept `.md` and `.MD` (case-insensitive filter). |

---

## 13. LLM Call Flow with Per-Agent Overrides

```
                    ┌─────────────────────────┐
                    │  .github/livvie_code_   │
                    │  review_agents/*.md      │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │     agent-loader.ts      │
                    │  parse → validate →      │
                    │  → Perspective[] +       │
                    │    agentModelOverrides   │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │       index.ts           │
                    │  builds PipelineConfig   │
                    │  passes perspectives to  │
                    │  runPipeline()           │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │      pipeline.ts         │
                    │  Stage 2: token budget   │
                    │  Stage 3: matrix calls   │
                    │  Stage 4: consolidation  │
                    │  Stage 5: post           │
                    └───────────┬─────────────┘
                                │
                    ┌───────────▼─────────────┐
                    │     llm-batch.ts         │
                    │  For each (batch, agent):│
                    │  1. Check agent model    │
                    │     override             │
                    │  2. Build system prompt  │
                    │     (body + SHARED_RULES)│
                    │  3. Call LLM with        │
                    │     effective model/temp  │
                    └─────────────────────────┘
```

---

## 14. Testing Strategy

| Test | Module |
|------|--------|
| Frontmatter parsing: valid, missing name, no frontmatter, body-only | `agent-loader.test.ts` |
| Validation: duplicate names, empty body, disabled agents | `agent-loader.test.ts` |
| Directory discovery: empty dir, missing dir, mixed files | `agent-loader.test.ts` |
| `SHARED_REVIEW_RULES` appended to body | `agent-loader.test.ts` |
| Model/temperature overrides flow to LLM call | `llm-batch.test.ts` (integration) |
| `perspectiveNameMap` resolves names in PR comments | `post.test.ts` (new tests) |
| Pipeline accepts perspectives parameter | `pipeline.test.ts` (updated) |
| Deprecation warning for `perspectives` input | `index.test.ts` (new) |

---

## 15. Dependency Decision

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| `gray-matter` | Robust YAML parsing, handles edge cases | 70+ transitive deps, overkill for 6 scalar fields | **Rejected** |
| `yaml` (js-yaml) | Good YAML parser | New dependency for trivial use | **Rejected** |
| Custom regex parser | Zero deps, ~30 lines, fits our simple schema | Won't handle multi-line YAML values | **Chosen** — all fields are single-line scalars |

If a future v3 needs complex YAML (lists, nested objects), we can swap in `gray-matter` behind the same `parseFrontmatter()` interface.

---

## 16. Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| Should agents support file-level include (`@include base.md`)? | **No.** YAGNI. Users can copy-paste shared rules. |
| Should there be a `tags` field for selective running? | **No.** YAGNI. Use `enabled: false` to disable agents. |
| Should agent IDs be the filename or the name? | **Filename** (slug). The `name` is for display, the filename is the stable identifier. `security.md` → id `security`. |
| Should we support `.yaml` frontmatter files alongside `.md`? | **No.** Markdown-only. The body IS the prompt. |
| Should the `perspectives` input be a hard error if set? | **No.** Warning only. Smoother migration. |
