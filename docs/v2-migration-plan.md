# Livvie Code Review v2 — Migration & Backward Compatibility Plan

## Table of Contents

- [Executive Summary](#executive-summary)
- [1. action.yml Input Changes](#1-actionyml-input-changes)
- [2. Architecture: How Agent Files Replace the Registry](#2-architecture-how-agent-files-replace-the-registry)
- [3. Default Behavior Decision Tree](#3-default-behavior-decision-tree)
- [4. Deprecation Strategy](#4-deprecation-strategy)
- [5. v1 → v2 Migration Guide](#5-v1--v2-migration-guide)
- [6. Hybrid Mode (Backward Compatibility)](#6-hybrid-mode-backward-compatibility)
- [7. Versioning Strategy](#7-versioning-strategy)
- [8. README v2 Outline](#8-readme-v2-outline)
- [9. action.yml Diff](#9-actionyml-diff)
- [10. Implementation Checklist](#10-implementation-checklist)

---

## Executive Summary

v2 replaces the **hardcoded 5-perspective registry** (`src/perspectives.ts: PERSPECTIVE_REGISTRY`) with **user-defined `.md` agent files** in `.github/livvie_code_review_agents/`. The migration is **non-breaking for existing v1 users** — they can continue using v1 (frozen tag) or upgrade to v2 which defaults to the same built-in `generalist` behavior when no agent directory exists.

**Key decisions:**
- The `perspectives` input is **kept but deprecated** in v2 as a fallback
- A new `agents-dir` input specifies the agent file directory
- If no agent files exist, v2 uses the **same 5 built-in perspectives** as v1 (not a failure)
- v1 tag stays frozen; v2 gets its own floating tag (`v2`)
- No hybrid mode — either you use agent files OR the legacy `perspectives` input, not both simultaneously

---

## 1. action.yml Input Changes

### Inputs that CHANGE

| Input | v1 | v2 | Notes |
|-------|----|----|-------|
| `perspectives` | `default: "generalist"` | `default: ""` (empty) | **Deprecated.** Only used as fallback when no agent files are found AND `perspectives` is explicitly set by user. |
| `review-instructions-file` | `default: ".github/code-reviewer.md"` | `default: ".github/code-reviewer.md"` | **Kept as-is.** This file provides *project-level context* (tech stack, coding standards) that is orthogonal to agent definitions. Agent .md files define *how* to review; this file defines *what the project is*. Both are injected into the system prompt. |

### Inputs that are NEW

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `agents-dir` | no | `.github/livvie_code_review_agents` | Path to directory containing agent `.md` files. Each `.md` file defines one review perspective. If the directory doesn't exist or is empty, falls back to built-in defaults. |

### Inputs that are UNCHANGED

All other inputs (`github-token`, `llm-api-key`, `llm-base-url`, `model`, `max-diff-size`, `max-output-tokens`, `reasoning-effort`, `fallback-model`, `request-changes-on-high`, `max-comments`, `ignore-patterns`, `max-batches`, `context-window`, `verbose`) remain identical.

### Relationship between `agents-dir` and `review-instructions-file`

These serve **different purposes** and coexist:

```
┌─────────────────────────────────┐
│  Agent .md file (per-reviewer)  │  ← Defines WHO reviews and HOW
│  "You are a Security Reviewer"  │     (system prompt, focus areas)
│  "Focus on: injection, secrets" │
└─────────────────────────────────┘
         +
┌─────────────────────────────────┐
│  review-instructions-file       │  ← Defines WHAT to review
│  "This is a Flutter app using"  │     (project context, tech stack)
│  "Riverpod, targeting iOS"      │
└─────────────────────────────────┘
         ↓
   Combined into final system prompt
```

**Decision: Keep both.** They answer different questions. The `review-instructions-file` is appended to every agent's system prompt as project context, exactly as v1 does today.

---

## 2. Architecture: How Agent Files Replace the Registry

### Current v1 flow

```
action.yml: perspectives: "security,performance"
    ↓
parsePerspectivesInput() → ["security", "performance"]
    ↓
getPerspectives(["security", "performance"])
    ↓
PERSPECTIVE_REGISTRY["security"] → { id, name, systemPrompt, focus }
PERSPECTIVE_REGISTRY["performance"] → { id, name, systemPrompt, focus }
    ↓
pipeline.ts: reviewBatchFromPerspective(batch, perspective, llmConfig)
```

### Proposed v2 flow

```
action.yml: agents-dir: ".github/livvie_code_review_agents"
    ↓
loadAgentFiles(".github/livvie_code_review_agents/")
    ↓
Read each .md file → parse YAML frontmatter + markdown body
    ↓
Construct Perspective[] from file contents
    ↓
pipeline.ts: reviewBatchFromPerspective(batch, perspective, llmConfig)
    ↓  (unchanged from here down)
```

### Agent .md file format

```markdown
---
name: Security Reviewer
id: security
focus: "injection risks, secret leaks, auth bypass, input validation"
---

You are a **Security Reviewer**. You review code for security vulnerabilities and risks.

## Your focus areas
- **Injection**: SQL injection, command injection, XSS, template injection, path traversal
- **Secrets**: hardcoded API keys, tokens, passwords, secrets in logs or error messages
...
```

The **YAML frontmatter** provides metadata (`name`, `id`, `focus`). The **markdown body** becomes the `systemPrompt`. The `SHARED_REVIEW_RULES` (response format, severity definitions, suggestion rules) are still appended automatically by the code — users do NOT need to include them in their agent files.

### Code changes needed

| File | Change |
|------|--------|
| `src/perspectives.ts` | Keep `PERSPECTIVE_REGISTRY` as built-in defaults. Add `loadAgentFiles(dir): Perspective[]` function. Refactor `getPerspectives()` to accept either registry IDs or loaded perspectives. |
| `src/index.ts` | Read `agents-dir` input. Call `loadAgentFiles()` if directory exists. Emit deprecation warning if `perspectives` input is explicitly set. |
| `src/types.ts` | No changes to `Perspective` interface — it's already clean. |
| `action.yml` | Add `agents-dir` input, deprecate `perspectives` input description. |
| `src/perspectives.test.ts` | Add tests for `loadAgentFiles()`, fallback behavior, deprecation warnings. |

---

## 3. Default Behavior Decision Tree

```
Does .github/livvie_code_review_agents/ exist?
├── NO
│   ├── Is `perspectives` input explicitly set (non-empty)?
│   │   ├── YES → Use legacy perspective registry (v1 behavior)
│   │   │         + Print deprecation warning
│   │   └── NO  → Use built-in default: generalist only
│   │             (same as v1 default)
│   └── Done
│
└── YES
    ├── Does it contain any .md files?
    │   ├── NO (empty directory)
    │   │   ├── Is `perspectives` input explicitly set?
    │   │   │   ├── YES → Use legacy perspective registry + deprecation warning
    │   │   │   └── NO  → Use built-in default: generalist only
    │   │   └── Done
    │   │
    │   └── YES (has .md files)
    │       ├── Load all .md files as perspectives
    │       ├── Is `perspectives` input ALSO set?
    │       │   └── YES → Print warning: "Both agents-dir and perspectives 
    │       │             are set. Using agent files. The 'perspectives' 
    │       │             input is deprecated — remove it."
    │       └── Done (use agent files only)
    │
    └── Done
```

### Rationale for "no agent files → built-in defaults" (not failure)

1. **Zero-friction adoption**: New v2 users get the same behavior as v1 without needing to create agent files
2. **Progressive enhancement**: Users can start with v2 defaults and gradually customize by adding agent files
3. **README examples**: Ship 5 example agent .md files in the README that exactly match the current hardcoded perspectives — users can copy-paste to customize

---

## 4. Deprecation Strategy

### Deprecation warnings (runtime)

When v2 detects usage of deprecated features, it emits GitHub Actions warnings:

```typescript
// In index.ts, after reading inputs:
const perspectivesInput = core.getInput("perspectives");
const agentsDir = core.getInput("agents-dir");

if (perspectivesInput && perspectivesInput.trim() !== "") {
  core.warning(
    "⚠️ The 'perspectives' input is deprecated in v2 and will be removed in v3. " +
    "Migrate to agent .md files in '" + agentsDir + '/'. " +
    "See: https://github.com/4itworks/livvie_code_review#migrating-from-v1"
  );
}
```

### Deprecation timeline

| Version | Status | `perspectives` input | Agent files |
|---------|--------|---------------------|-------------|
| v1.x | **Frozen** | Active, only option | Not supported |
| v2.0 | **Current** | Deprecated (warning) | Primary mechanism |
| v2.x | Maintenance | Deprecated (warning) | Primary mechanism |
| v3.0 | Future | **Removed** | Only mechanism |

### Breaking changes in v2

**Technically none for existing users.** Here's why:

| User scenario | v1 config | What happens on v2 |
|---------------|-----------|-------------------|
| Uses `perspectives: "generalist"` | Explicit | Works, prints deprecation warning |
| Uses `perspectives: "security,performance"` | Explicit | Works, prints deprecation warning |
| Doesn't set `perspectives` at all | Relies on default | Works identically (generalist) |
| Has `.github/code-reviewer.md` | `review-instructions-file` | Works identically |

The only scenario where behavior *changes* is if a user has BOTH a `perspectives` input AND agent files — in that case v2 prefers agent files with a warning. This is an intentional behavior change, not a break.

---

## 5. v1 → v2 Migration Guide

### Minimal migration (zero changes needed)

If you're happy with the default `generalist` perspective, **no changes are required**. Just update your tag:

```yaml
# Before (v1)
- uses: 4itworks/livvie_code_review@v1

# After (v2) — identical behavior, no config changes
- uses: 4itworks/livvie_code_review@v2
```

### Migrating custom perspectives

If you used `perspectives: "security,performance"` in v1:

**Step 1:** Create the agents directory and add agent files:

```bash
mkdir -p .github/livvie_code_review_agents
```

**Step 2:** Create `security.md`:

```markdown
---
name: Security Reviewer
id: security
focus: "injection risks, secret leaks, auth bypass, input validation"
---

You are a **Security Reviewer**. You review code for security vulnerabilities and risks.

## Your focus areas
- **Injection**: SQL injection, command injection, XSS, template injection, path traversal
- **Secrets**: hardcoded API keys, tokens, passwords, secrets in logs or error messages
- **Authentication/Authorization**: missing auth checks, privilege escalation, insecure token handling
- **Input validation**: missing sanitization, trusting user input, unsafe deserialization
- **Crypto**: weak hashing, insecure random, hardcoded IVs, ECB mode
- **Data exposure**: sensitive data in logs, error messages, or URLs
- **Dependencies**: known-vulnerable patterns, unsafe API usage

Only flag genuine security risks. Don't flag theoretical issues that require specific attack conditions unless the attack vector is realistic for this code's context.
```

**Step 3:** Create `performance.md`:

```markdown
---
name: Performance Reviewer
id: performance
focus: "N+1 queries, unnecessary rebuilds, memory leaks, algorithmic complexity"
---

You are a **Performance Reviewer**. You review code for performance issues and inefficiencies.

## Your focus areas
- **Database**: N+1 queries, missing indexes, unnecessary queries in loops
- **Memory**: memory leaks, unnecessary allocations in hot paths, unbounded caches
- **Rebuilds**: unnecessary widget rebuilds (Flutter), unnecessary re-renders (React)
- **Algorithmic complexity**: O(n²) where O(n) is possible, redundant iterations
- **Resource management**: unclosed streams/connections/controllers, missing dispose
- **Caching**: missing cache opportunities, cache invalidation issues
- **Async**: unnecessary awaiting in loops, blocking async operations

Only flag performance issues that would have a real impact. Don't flag micro-optimizations.
```

**Step 4:** Update your workflow:

```yaml
# Before
- uses: 4itworks/livvie_code_review@v1
  with:
    perspectives: "security,performance"

# After
- uses: 4itworks/livvie_code_review@v2
  with:
    # Remove 'perspectives' — agent files are loaded automatically
    agents-dir: ".github/livvie_code_review_agents"
```

**Step 5:** Commit the agent files and updated workflow together.

### Customizing an existing perspective

The power of v2: you can **modify** the built-in perspectives instead of being locked into the hardcoded prompts. For example, to make the Security Reviewer also check for Flutter-specific issues:

```markdown
---
name: Security Reviewer
id: security
focus: "injection risks, secret leaks, auth bypass, input validation, Flutter security"
---

You are a **Security Reviewer**. You review code for security vulnerabilities and risks.

## Your focus areas
- **Injection**: SQL injection, command injection, XSS, template injection, path traversal
- **Secrets**: hardcoded API keys, tokens, passwords, secrets in logs or error messages
- **Authentication/Authorization**: missing auth checks, privilege escalation
- **Input validation**: missing sanitization, trusting user input, unsafe deserialization
- **Flutter-specific**: insecure shared storage, missing platform channel validation,
  debug mode flags left enabled, insecure deep link handling

Only flag genuine security risks.
```

---

## 6. Hybrid Mode (Backward Compatibility)

### Decision: No hybrid mode

**Rationale:** Supporting both `perspectives` input AND agent files simultaneously creates ambiguity:
- Which takes precedence?
- What if they overlap (e.g., `perspectives: "security"` AND `security.md` exists)?
- How do you merge them?

Instead, v2 uses a **strict priority**:

1. **Agent files exist AND directory has .md files** → Use agent files (ignore `perspectives` input, warn if set)
2. **No agent files OR empty directory** → Fall back to `perspectives` input (if set) or built-in default

This is simpler to implement, test, and document.

### Edge case: partial overlap

If a user has `perspectives: "security,performance"` AND agent files in the directory:

```
.github/livvie_code_review_agents/
├── security.md     ← exists
└── architecture.md ← exists
```

**Behavior:** v2 loads `security.md` and `architecture.md` from the directory. The `perspectives` input is **ignored** with a warning. The user explicitly chose agent files by placing them in the directory.

---

## 7. Versioning Strategy

### Git tags

| Tag | Points to | Mutable? | Description |
|-----|-----------|----------|-------------|
| `v1` | Last v1.x commit | **No** (force-move once to freeze) | Frozen v1. No new features. Security patches only via v1.1, v1.2 etc. |
| `v1.x.x` | Specific commits | **No** | Semver tags for v1 line |
| `v2` | Latest v2.x commit | **Yes** (floating) | Current major version |
| `v2.0.0`, `v2.1.0` | Specific commits | **No** | Semver tags for v2 line |

### Branch strategy

```
main                ← v2 development
├── v1              ← frozen branch (security patches only)
└── tags:
    ├── v1.0.0, v1.1.0, ...  ← frozen
    ├── v2.0.0, v2.1.0, ...  ← semver
    └── v1, v2               ← floating major tags
```

### User-facing tag convention

Users reference the **floating major tag** in their workflows:

```yaml
# Recommended: always get latest v2.x
- uses: 4itworks/livvie_code_review@v2

# Pin to exact version
- uses: 4itworks/livvie_code_review@v2.0.0

# Legacy (still works, frozen at v1.x)
- uses: 4itworks/livvie_code_review@v1
```

### Freezing v1

1. Create a `v1` branch from the last v1.x commit
2. Move the `v1` tag to point to this branch HEAD
3. Update v1 README with a banner: "v1 is frozen. Upgrade to v2 for new features."
4. Only accept security patches to v1 branch (v1.0.1, v1.0.2, etc.)

---

## 8. README v2 Outline

### Sections to ADD

```
## What's New in v2
- User-defined review agents via .md files
- Custom perspectives without code changes
- Same defaults as v1 — zero-friction upgrade

## Agent Files
### File format
### Built-in defaults (templates)
### Custom agents
### Combining with review-instructions-file

## Migrating from v1
### Minimal migration (zero changes)
### Migrating custom perspectives
### FAQ

## Agent File Examples
### security.md
### performance.md
### code-quality.md
### architecture.md
### generalist.md
### Custom: flutter-specific.md
### Custom: api-design.md
```

### Sections to UPDATE

```
## Review Perspectives → ## Review Perspectives (Legacy / v1)
  - Add deprecation note
  - Link to Agent Files section

## Inputs
  - Add `agents-dir`
  - Mark `perspectives` as deprecated

## Setup
  - Update workflow example to use v2
  - Add agent file setup step

## Cost Control
  - Update to reference agent files instead of perspectives input
```

### Sections UNCHANGED

- Why, Architecture, Outputs, Supported Providers, Development, Branch Protection, License

---

## 9. action.yml Diff

```yaml
# BEFORE (v1)
inputs:
  # ... other inputs unchanged ...
  perspectives:
    description: "Comma-separated review perspectives to run. Options: code-quality, security, performance, architecture, generalist. Default runs generalist only."
    required: false
    default: "generalist"
  # ... other inputs unchanged ...

# AFTER (v2)
inputs:
  # ... other inputs unchanged ...
  agents-dir:
    description: "Path to directory containing agent .md files that define review perspectives. Each .md file = one reviewer. Falls back to built-in defaults if directory doesn't exist or is empty. See README for file format and examples."
    required: false
    default: ".github/livvie_code_review_agents"
  perspectives:
    description: "[DEPRECATED — use agents-dir instead] Comma-separated review perspectives to run. Only used when no agent files are found. Will be removed in v3."
    required: false
    default: ""
  # ... other inputs unchanged ...
```

### Specific field changes in `perspectives`:

| Field | v1 | v2 |
|-------|----|----|
| `description` | `"Comma-separated review perspectives..."` | `"[DEPRECATED — use agents-dir instead] Comma-separated..."` |
| `default` | `"generalist"` | `""` (empty string) |
| `required` | `false` | `false` (unchanged) |

---

## 10. Implementation Checklist

### Phase 1: Core agent file loading
- [ ] Add `loadAgentFiles(dir: string): Perspective[]` to `src/perspectives.ts`
- [ ] Parse YAML frontmatter (`gray-matter` or manual parser)
- [ ] Append `SHARED_REVIEW_RULES` to parsed systemPrompt
- [ ] Validate required fields (`name`, `id`) — skip malformed files with warning
- [ ] Add `agents-dir` input to `action.yml`
- [ ] Update `src/index.ts` to read `agents-dir` and call `loadAgentFiles()`
- [ ] Wire fallback logic (decision tree above)

### Phase 2: Deprecation
- [ ] Change `perspectives` default from `"generalist"` to `""` in `action.yml`
- [ ] Add deprecation warning in `src/index.ts`
- [ ] Update `perspectives` description with `[DEPRECATED]` tag

### Phase 3: Tests
- [ ] Test: empty agents dir → falls back to built-in default (generalist)
- [ ] Test: agents dir with valid .md files → uses agent files
- [ ] Test: agents dir with malformed .md → skips with warning
- [ ] Test: agents dir + `perspectives` set → uses agents, warns about perspectives
- [ ] Test: no agents dir + `perspectives` set → uses legacy registry with warning
- [ ] Test: no agents dir + no perspectives → uses built-in default
- [ ] Test: agent file without frontmatter → uses filename as id, full body as prompt
- [ ] Test: agent file with frontmatter missing `name` → uses filename as name
- [ ] Test: custom agent file extends SHARED_REVIEW_RULES correctly

### Phase 4: Documentation
- [ ] Create 5 example agent .md files (matching current built-in perspectives)
- [ ] Update README: add "Agent Files" section
- [ ] Update README: add "Migrating from v1" section
- [ ] Update README: deprecate "Review Perspectives" section
- [ ] Update README: Inputs table with `agents-dir`
- [ ] Update README: Setup workflow example

### Phase 5: Release
- [ ] Create `v1` branch, freeze
- [ ] Merge v2 to `main`
- [ ] Tag `v2.0.0`
- [ ] Move `v2` floating tag
- [ ] Update GitHub Marketplace listing

---

## Appendix A: Example Agent .md Files

### `.github/livvie_code_review_agents/generalist.md`

```markdown
---
name: General Reviewer
id: generalist
focus: "style, documentation, error handling, edge cases, cross-cutting concerns"
---

You are a **General Code Reviewer**. You review code for issues that span multiple concerns and for things that specialist reviewers might miss.

## Your focus areas
- **Cross-cutting concerns**: issues that don't fit neatly into one category
- **Edge cases**: null/empty handling, boundary conditions, race conditions
- **Correctness**: logic errors, wrong variable references, incorrect conditions
- **Documentation**: missing doc comments for public APIs, misleading comments
- **Consistency**: inconsistent error handling, inconsistent patterns
- **Testing**: obviously untested code paths, testability issues

Flag anything that a thorough senior developer would notice during a code review.
```

*(Similar files for `code-quality.md`, `security.md`, `performance.md`, `architecture.md` — each mirroring the corresponding hardcoded prompt from `perspectives.ts`.)*

---

## Appendix B: New Code Sketch — `loadAgentFiles()`

```typescript
import * as fs from "fs";
import * as path from "path";

interface AgentFrontmatter {
  name?: string;
  id?: string;
  focus?: string;
}

export function loadAgentFiles(dir: string): Perspective[] | null {
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  if (files.length === 0) return null;

  const perspectives: Perspective[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const raw = fs.readFileSync(filePath, "utf-8");

    const { frontmatter, body } = parseFrontmatter(raw);
    const fileId = path.basename(file, ".md");

    const perspective: Perspective = {
      id: frontmatter.id || fileId,
      name: frontmatter.name || fileId,
      focus: frontmatter.focus || "",
      systemPrompt: body + "\n\n" + SHARED_REVIEW_RULES,
    };

    perspectives.push(perspective);
    core.info(`Loaded agent: ${perspective.name} (${perspective.id}) from ${file}`);
  }

  return perspectives;
}
```

---

## Appendix C: Decision Matrix — What Users See

| User has `perspectives` set? | User has agent files? | v1 behavior | v2 behavior | Migration needed? |
|---|---|---|---|---|
| ❌ No | ❌ No | generalist only | generalist only | **No** |
| ✅ Yes | ❌ No | Uses perspectives | Uses perspectives + deprecation warning | **No** (but recommended) |
| ❌ No | ✅ Yes | N/A (v1 has no agent support) | Uses agent files | **N/A** |
| ✅ Yes | ✅ Yes | N/A | Uses agent files + warns to remove perspectives | **Yes** (remove `perspectives`) |
