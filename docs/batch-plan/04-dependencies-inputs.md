# Section 4: Dependencies + Action Inputs

## New Dependencies

### package.json — add to `dependencies`:

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

**`gpt-tokenizer`** — Pure JS tokenizer for GPT-4 (cl100k_base encoding). Used for accurate token counting. Works for all major LLMs (Claude, GPT, GLM, DeepSeek) as a universal approximation.

**No other new dependencies.** All other new code uses pure TypeScript + existing deps.

---

## action.yml — Full Updated Content

```yaml
name: "Livvie Code Review"
description: "AI code review with batched LLM calls, native GitHub suggestion blocks and REQUEST_CHANGES support. Bring your own LLM key."
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
    description: "Maximum diff size in characters per file sent to the model."
    required: false
    default: "50000"
  max-output-tokens:
    description: "Maximum tokens for the LLM response (includes reasoning tokens if reasoning is enabled)."
    required: false
    default: "16000"
  reasoning-effort:
    description: "Reasoning effort level for models that support it (e.g. kimi-k2, deepseek-r1, glm-4.5). Options: none, low, medium, high, max. 'max' uses the maximum reasoning the model offers. Ignored by models that don't support reasoning."
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
    description: "Maximum inline comments to post. Capped at 100 by GitHub."
    required: false
    default: "25"
  ignore-patterns:
    description: "Comma-separated glob patterns for files to skip (e.g. '*.g.dart,*.freezed.dart,*.mocks.dart,build/**,dist/**'). Merged with built-in defaults."
    required: false
    default: ""
  max-batches:
    description: "Maximum number of LLM batch calls (0 = unlimited). Use to cap cost on large PRs."
    required: false
    default: "0"
  context-window:
    description: "Override the model's context window size in tokens (0 = use default 128000). Use for models with non-standard windows."
    required: false
    default: "0"

runs:
  using: "node24"
  main: "dist/index.js"
```

### New inputs summary

| Input | Type | Default | Purpose |
|---|---|---|---|
| `ignore-patterns` | string (comma-sep) | `""` | Glob patterns for generated files to skip. Merged with defaults: `*.g.dart, *.freezed.dart, *.mocks.dart, build/**, dist/**` |
| `max-batches` | int | `0` | Cap LLM calls for cost control. 0 = unlimited. |
| `context-window` | int | `0` | Override model context window. 0 = use default (128000). |

---

## Model Default Context Windows

When `context-window` input is `0`, use these defaults based on model name:

```typescript
const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4": 8192,
  // Anthropic (via OpenRouter)
  "anthropic/claude-sonnet-4": 200000,
  "anthropic/claude-opus-4": 200000,
  // Z.AI
  "z-ai/glm-5.2": 128000,
  // Default fallback
  "default": 128000,
};

function getDefaultContextWindow(model: string): number {
  for (const [key, value] of Object.entries(DEFAULT_CONTEXT_WINDOWS)) {
    if (model.includes(key)) return value;
  }
  return DEFAULT_CONTEXT_WINDOWS["default"];
}
```

This function lives in `src/tokenizer.ts` or `src/pipeline.ts`.
