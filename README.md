# Livvie Code Review

AI code review GitHub Action with multi-perspective specialist reviewers, native GitHub suggestion blocks, and REQUEST_CHANGES support.

## Why

Most AI code review tools post code fixes as generic code blocks. Livvie Code Review posts every fix as a GitHub `suggestion` block, so developers can apply fixes with one click — no copy-paste.

## Features

- **Multi-perspective specialist reviewers** — choose from 5 specialized review angles: code-quality, security, performance, architecture, and generalist
- **Batching for large PRs** — files are bin-packed by token budget, so even 100-file PRs get reviewed without context truncation
- **Suggestion blocks** — every code fix renders as an inline "Accept" button in the PR diff
- **REQUEST_CHANGES** — high-severity findings block the PR until resolved
- **Inline comments** — findings are posted on the exact line in the diff, not in the review body
- **Perspective attribution** — each finding shows which specialist reviewer found it
- **Deduplication** — findings from multiple perspectives on the same line are merged
- **Bring your own LLM** — works with OpenRouter, OpenAI, Groq, Ollama, or any OpenAI-compatible API
- **Cost control** — `max-batches` caps total LLM calls; `perspectives` controls how many reviewers run
- **Stale review dismissal** — previous reviews from past runs are dismissed automatically

## Architecture

```
┌─────────┐    ┌──────────┐    ┌─────────────────────────────┐    ┌────────────────┐    ┌──────┐
│  FETCH  │───▶│ BATCHING │───▶│ REVIEW (matrix: B × P)      │───▶│ CONSOLIDATION  │───▶│ POST │
│ parallel│    │ bin-pack │    │ batches × perspectives      │    │ dedup + merge  │    │      │
│ conc=5  │    │ tokens   │    │ single semaphore, conc=3    │    │ cap 100        │    │      │
└─────────┘    └──────────┘    └─────────────────────────────┘    └────────────────┘    └──────┘
```

1. **FETCH** — diff and file contents fetched in parallel (concurrency 5), generated files filtered out
2. **BATCHING** — files bin-packed into batches by token budget, with cross-file context assigned
3. **REVIEW** — each batch × each perspective = one LLM call (concurrency 3, circuit breaker protected)
4. **CONSOLIDATION** — findings deduplicated (±3 lines), sorted by severity, capped at 100
5. **POST** — single consolidated review with inline comments, perspective breakdown, and stats

### Cost model

```
Total LLM calls = num_batches × num_perspectives
```

| PR Size | Files | Batches | Calls (5 perspectives) |
|---------|-------|---------|------------------------|
| Small   | 5     | 1       | 5                      |
| Medium  | 20    | 3       | 15                     |
| Large   | 50    | 8       | 40                     |

With `max-batches=5` and 1 perspective: always ≤ 5 calls. See section [Inputs](#inputs) for cost control.

## Setup

### 1. Add secret

Only the API key needs to be a secret:

| Secret | Value |
|--------|-------|
| `LLM_API_KEY` | Your LLM API key |

### 2. Add workflow

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, ready_for_review]
    paths:
      - "**.dart"
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: 4itworks/livvie_code_review@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          llm-base-url: "https://openrouter.ai/api/v1"
          model: "z-ai/glm-5.2"
          review-instructions-file: ".github/code-reviewer.md"
          perspectives: "generalist"
          max-batches: "0"
          context-window: "128000"
          ignore-patterns: "*.g.dart,*.freezed.dart,*.mocks.dart,*.gen.dart,build/**,dist/**"
```

### 3. Add review instructions (optional)

Create `.github/code-reviewer.md` in your repo with project-specific review rules.

## Review Perspectives

Five specialist reviewers are available. By default, only `generalist` runs to keep costs low. Add more perspectives for thorough multi-angle reviews.

| Perspective | ID | Focus |
|-------------|----|-------|
| Code Quality Reviewer | `code-quality` | Readability, naming, dead code, complexity, DRY, error handling |
| Security Reviewer | `security` | Injection risks, secret leaks, auth bypass, input validation, crypto |
| Performance Reviewer | `performance` | N+1 queries, memory leaks, unnecessary rebuilds, algorithmic complexity |
| Architecture Reviewer | `architecture` | Separation of concerns, coupling, layering, SOLID, design patterns |
| General Reviewer | `generalist` | Cross-cutting concerns, edge cases, correctness, documentation, consistency |

### Perspective examples

Run all five specialists for a thorough review:
```yaml
perspectives: "code-quality,security,performance,architecture,generalist"
```

Run only security review for a security-focused repo:
```yaml
perspectives: "security"
```

Run code-quality + performance for a balanced but cost-conscious review:
```yaml
perspectives: "code-quality,performance"
```

## How it works

1. Fetches the PR diff and full file contents via GitHub API (parallel, concurrency 5)
2. Filters out generated files (`.g.dart`, `build/**`, etc.) using `ignore-patterns`
3. Bin-packs files into batches by token budget (each batch fits in the model's context window)
4. For each batch × perspective, makes one LLM call with a perspective-specific system prompt
5. Deduplicates findings (same file + ±3 lines = merged, keeping highest confidence)
6. Posts a single review with inline comments, perspective breakdown table, and pipeline stats
7. Each inline comment shows which perspective found the issue
8. If any finding is high-severity, the review event is `REQUEST_CHANGES`; otherwise `COMMENT`
9. Stale reviews from previous runs are dismissed

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | yes | `${{ github.token }}` | GitHub token |
| `llm-api-key` | yes | — | LLM API key (secret) |
| `llm-base-url` | no | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL (plain string) |
| `model` | yes | — | Model name (plain string, e.g. `z-ai/glm-5.2`) |
| `review-instructions-file` | no | `.github/code-reviewer.md` | Extra review instructions |
| `max-diff-size` | no | `50000` | Max diff chars per file |
| `max-output-tokens` | no | `16000` | Max response tokens |
| `reasoning-effort` | no | `none` | Reasoning effort (none, low, medium, high, max) |
| `fallback-model` | no | `""` | Fallback model if primary fails |
| `request-changes-on-high` | no | `true` | Block PR on high-severity |
| `max-comments` | no | `25` | Max inline comments |
| `ignore-patterns` | no | `*.g.dart,*.freezed.dart,*.mocks.dart,*.gen.dart,build/**,dist/**` | Glob patterns for files to skip |
| `max-batches` | no | `0` | Max batches (caps LLM calls = batches × perspectives). 0 = unlimited |
| `context-window` | no | `128000` | Model context window in tokens (for budget calculation) |
| `perspectives` | no | `generalist` | Comma-separated review perspectives to run |

Only `llm-api-key` needs to be a GitHub Secret. The `model` and `llm-base-url` are plain strings — they are not sensitive values and can be set directly in the workflow.

### Cost control

The two primary cost control levers:

- **`perspectives`** — controls how many specialist reviewers run. Default is `generalist` (1 call per batch). Adding all 5 perspectives multiplies cost by 5×.
- **`max-batches`** — caps the number of file batches. Total LLM calls = `min(batches, max-batches) × len(perspectives)`. Set `max-batches: "5"` to cap costs on large PRs.

Example: `max-batches: "3"` + `perspectives: "security,generalist"` = at most 6 LLM calls regardless of PR size.

## License

MIT
