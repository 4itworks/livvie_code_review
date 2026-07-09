# Livvie Code Review

AI code review GitHub Action with native GitHub suggestion blocks and REQUEST_CHANGES support.

## Why

Most AI code review tools post code fixes as generic code blocks. Livvie Code Review posts every fix as a GitHub `suggestion` block, so developers can apply fixes with one click — no copy-paste.

## Features

- **Suggestion blocks** — every code fix renders as an inline "Accept" button in the PR diff
- **REQUEST_CHANGES** — high-severity findings block the PR until resolved
- **Inline comments** — findings are posted on the exact line in the diff, not in the review body
- **Bring your own LLM** — works with OpenRouter, OpenAI, Groq, Ollama, or any OpenAI-compatible API
- **JSON mode** — the LLM returns structured JSON; the action wraps suggestions in the correct format
- **Deduplication** — stale reviews from previous runs are dismissed automatically

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
```

### 3. Add review instructions (optional)

Create `.github/code-reviewer.md` in your repo with project-specific review rules.

## How it works

1. Fetches the PR diff via GitHub API
2. Sends the diff + system prompt to the LLM, requesting a JSON response
3. For each finding, posts an inline comment on the exact diff line
4. Code fixes are wrapped in `suggestion` blocks — never generic code blocks
5. If any finding is high-severity, the review event is `REQUEST_CHANGES`; otherwise `COMMENT`
6. Stale reviews from previous runs are dismissed

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | yes | `${{ github.token }}` | GitHub token |
| `llm-api-key` | yes | — | LLM API key (secret) |
| `llm-base-url` | no | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL (plain string) |
| `model` | no | — | Model name (plain string, e.g. `z-ai/glm-5.2`) |
| `review-instructions-file` | no | `.github/code-reviewer.md` | Extra review instructions |
| `max-diff-size` | no | `50000` | Max diff chars sent to model |
| `max-output-tokens` | no | `16000` | Max response tokens |
| `request-changes-on-high` | no | `true` | Block PR on high-severity |
| `max-comments` | no | `25` | Max inline comments |

Only `llm-api-key` needs to be a GitHub Secret. The `model` and `llm-base-url` are plain strings — they are not sensitive values and can be set directly in the workflow.

## License

MIT
