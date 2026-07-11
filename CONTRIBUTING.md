# Contributing to Livvie Code Review

Thanks for your interest in contributing! This guide will help you get started.

## Quick Start

```bash
# 1. Fork and clone
git clone https://github.com/<your-username>/livvie_code_review.git
cd livvie_code_review

# 2. Install dependencies
npm ci

# 3. Run the full check suite
npm run format && npm run lint && npm run typecheck && npm test && npm run build
```

## Development Workflow

### Branch naming

Use conventional prefixes:

```
feat/add-ollama-streaming
fix/circuit-breaker-race-condition
docs/update-readme-examples
refactor/extract-hunk-parser
test/add-post-integration-tests
```

### Making changes

1. Create a branch from `main`
2. Make your changes
3. Run the full check suite before committing
4. Open a PR against `main`

```bash
git checkout -b feat/your-feature

# Edit files...

# Format and lint
npm run format
npm run lint:fix

# Verify everything passes
npm run typecheck && npm test && npm run build

# Commit (use conventional commits)
git add -A
git commit -m "feat: add your feature description"
git push origin feat/your-feature
```

### Conventional Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/). All PR titles must follow this format:

| Prefix | When to use |
|--------|-------------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `style:` | Formatting, missing semicolons (no code change) |
| `refactor:` | Code change that neither fixes a bug nor adds a feature |
| `test:` | Adding or updating tests |
| `chore:` | Build process, dependencies, CI config |
| `perf:` | Performance improvement |

Examples:
```
feat: add support for custom LLM headers
fix: prevent circuit breaker from getting stuck in half-open
test: add integration tests for post.ts
docs: clarify max-batches cost model
```

## CI Checks

Every PR must pass all 5 checks before merge:

| Check | What it runs | Tool |
|-------|-------------|------|
| `format` | Code formatting | Prettier |
| `lint` | Static analysis | ESLint |
| `typecheck` | Type safety | TypeScript |
| `test` | Unit tests | Vitest |
| `build-check` | Build + dist/ freshness | ncc |

These run automatically on every push. You can run them locally:

```bash
npm run format:check   # Check formatting
npm run lint           # Lint check
npm run typecheck      # Type check
npm test               # Run all tests
npm run build          # Build dist/index.js
```

## Project Structure

```
src/
  index.ts           # Entry point — reads action inputs, runs pipeline
  pipeline.ts         # Orchestrator — fetch → batch → review → consolidate → post
  types.ts            # All TypeScript interfaces
  llm.ts              # JSON parsing, finding normalization
  llm-batch.ts        # LLM HTTP calls, retry, circuit breaker integration
  post.ts             # GitHub review posting, stale review cleanup
  suggestion.ts       # Bracket balance validation for suggestions
  diff.ts             # PR diff fetching, line-in-diff detection
  batcher.ts          # File bin-packing by token budget
  concurrency.ts      # Semaphore, mapWithConcurrency
  circuit-breaker.ts  # Circuit breaker with half-open recovery
  consolidation.ts    # Finding dedup, sort, cap, summary merging
  cross-file.ts       # Cross-batch context building
  tokenizer.ts        # Token counting, budget calculation
  truncation.ts       # Progressive file truncation
  perspectives.ts     # Review perspective definitions and prompts
  ignore-patterns.ts  # Glob pattern matching for file filtering
```

### Key concepts

- **Perspectives**: Each review angle (code-quality, security, etc.) is a separate LLM call with its own system prompt
- **Batching**: Files are bin-packed by token budget to fit within the model's context window
- **Circuit breaker**: After 3 consecutive LLM failures, the primary model is skipped for 30s before retrying
- **Deduplication**: Findings from different perspectives on the same file within ±3 lines are merged if descriptions are similar

## Adding a New Perspective

1. Open `src/perspectives.ts`
2. Add a new prompt constant (follow the existing pattern):
   ```typescript
   const TESTING_PROMPT = `You are a **Testing Reviewer**...
   ## Your focus areas
   - ...
   ${SHARED_REVIEW_RULES}`;
   ```
3. Register it in `PERSPECTIVE_REGISTRY`:
   ```typescript
   "testing": {
     id: "testing",
     name: "Testing Reviewer",
     focus: "test coverage, test quality, edge cases",
     systemPrompt: TESTING_PROMPT,
   },
   ```
4. Add tests in `src/perspectives.test.ts`
5. Update the `action.yml` `perspectives` input description
6. Update the README perspectives table

## Adding Tests

Tests live alongside source files: `src/foo.ts` → `src/foo.test.ts`.

```typescript
import { describe, it, expect } from "vitest";
import { myFunction } from "./my-module.js";

describe("myFunction", () => {
  it("handles normal input", () => {
    expect(myFunction("input")).toBe("expected");
  });

  it("handles edge case", () => {
    expect(myFunction("")).toBeNull();
  });
});
```

Run a single test file:
```bash
npx vitest run src/my-module.test.ts
```

Run with coverage:
```bash
npm run test:coverage
```

### What to test

- **Pure functions**: Always test input/output (suggestion.ts, consolidation.ts, tokenizer.ts, etc.)
- **State machines**: Test all state transitions (circuit-breaker.ts)
- **Parsers**: Test valid input, invalid input, edge cases (llm.ts, ignore-patterns.ts)
- **Integration**: Functions that call external APIs (pipeline.ts, post.ts) need mocks — skip if complex

## Code Style

- **No comments** — code should be self-documenting
- **No single-letter variables** — use descriptive names
- **No magic numbers** — extract to named constants
- **Double quotes** — enforced by Prettier
- **Trailing commas** — enforced by Prettier
- **100 char line width** — enforced by Prettier
- **`const` over `let`** — enforced by ESLint (`prefer-const`)
- **Prefix unused params with `_`** — e.g., `_unused`

## Releasing

Releases are done by maintainers:

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Commit: `git commit -m "chore: release vX.Y.Z"`
4. Tag: `git tag vX.Y.Z`
5. Update floating tag: `git tag -f vX`
6. Push: `git push origin main vX --force`
7. Create release: `gh release create vX.Y.Z --notes-file CHANGELOG.md`

Users reference the floating tag (`@v1`) for automatic non-breaking updates.

## Questions?

Open a [GitHub Discussion](https://github.com/4itworks/livvie_code_review/discussions) or check the existing [Issues](https://github.com/4itworks/livvie_code_review/issues).
