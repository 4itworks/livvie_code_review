import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@actions/core");
vi.mock("./llm.js");

import { buildBatchUserMessage, reviewBatchFromPerspective } from "./llm-batch.js";
import { parseReview } from "./llm.js";
import type { LLMCallConfig } from "./llm-batch.js";
import type { Batch, Perspective, PreparedFile, Semaphore } from "./types.js";
import { createCircuitBreaker } from "./circuit-breaker.js";

function makePreparedFile(filename: string, overrides: Partial<PreparedFile> = {}): PreparedFile {
  return {
    filename,
    patch: "@@ -1,3 +1,4 @@\n+new line",
    additions: 1,
    deletions: 0,
    content: "1: existing\n2: → new line",
    tokenCount: 50,
    truncated: false,
    directory: ".",
    ...overrides,
  };
}

function makeBatch(index: number, filenames: string[], overrides: Partial<Batch> = {}): Batch {
  return {
    index,
    files: filenames.map((name) => makePreparedFile(name)),
    tokenCount: 50 * filenames.length,
    crossFileContext: "",
    totalTokenCount: 50 * filenames.length + 100,
    ...overrides,
  };
}

function makePerspective(id: string, name?: string): Perspective {
  return {
    id,
    name: name ?? `${id} Reviewer`,
    systemPrompt: `You are a ${id} code reviewer.`,
    focus: id,
  };
}

function makeSemaphore(): Semaphore {
  return {
    acquire: vi.fn<() => Promise<() => void>>().mockResolvedValue(() => {}),
    available: 10,
    waiting: 0,
  };
}

function makeLLMConfig(overrides: Partial<LLMCallConfig> = {}): LLMCallConfig {
  return {
    apiKey: "test-api-key",
    baseUrl: "https://api.test.com",
    model: "primary-model",
    fallbackModel: "fallback-model",
    maxOutputTokens: 4096,
    reasoningEffort: "medium",
    reviewInstructions: "Review carefully",
    semaphore: makeSemaphore(),
    circuitBreaker: createCircuitBreaker(3),
    maxRetries: 1,
    ...overrides,
  };
}

function makeSuccessResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () =>
      Promise.resolve(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: "stop" }],
        }),
      ),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe("buildBatchUserMessage", () => {
  it("includes reviewInstructions when present", () => {
    const batch = makeBatch(0, ["lib/main.dart"]);
    const message = buildBatchUserMessage(batch, "Check for null safety");
    expect(message).toContain("## Project-specific review rules");
    expect(message).toContain("Check for null safety");
  });

  it("omits reviewInstructions when empty", () => {
    const batch = makeBatch(0, ["lib/main.dart"]);
    const message = buildBatchUserMessage(batch, "");
    expect(message).not.toContain("## Project-specific review rules");
  });

  it("omits reviewInstructions when whitespace only", () => {
    const batch = makeBatch(0, ["lib/main.dart"]);
    const message = buildBatchUserMessage(batch, "   ");
    expect(message).not.toContain("## Project-specific review rules");
  });

  it("includes crossFileContext when present", () => {
    const batch = makeBatch(0, ["lib/main.dart"], {
      crossFileContext: "lib/utils.dart defines helper used here",
    });
    const message = buildBatchUserMessage(batch, "");
    expect(message).toContain("## Cross-file context");
    expect(message).toContain("lib/utils.dart defines helper used here");
  });

  it("omits crossFileContext when empty", () => {
    const batch = makeBatch(0, ["lib/main.dart"], {
      crossFileContext: "",
    });
    const message = buildBatchUserMessage(batch, "");
    expect(message).not.toContain("## Cross-file context");
  });

  it("formats file headers with filename, additions, deletions", () => {
    const batch = makeBatch(0, ["lib/main.dart"], {});
    batch.files[0] = makePreparedFile("lib/main.dart", {
      additions: 5,
      deletions: 3,
    });
    const message = buildBatchUserMessage(batch, "");
    expect(message).toContain("### lib/main.dart (5+, 3-)");
  });

  it("includes all file contents", () => {
    const batch = makeBatch(0, ["lib/a.dart", "lib/b.dart"]);
    batch.files[0] = makePreparedFile("lib/a.dart", {
      content: "1: file A content",
    });
    batch.files[1] = makePreparedFile("lib/b.dart", {
      content: "1: file B content",
    });
    const message = buildBatchUserMessage(batch, "");
    expect(message).toContain("1: file A content");
    expect(message).toContain("1: file B content");
  });

  it("includes JSON instruction at the end", () => {
    const batch = makeBatch(0, ["lib/main.dart"]);
    const message = buildBatchUserMessage(batch, "");
    expect(message).toContain(
      "Return your review as a JSON object. Only return JSON, no markdown.",
    );
  });
});

describe("reviewBatchFromPerspective", () => {
  const validReviewJson = JSON.stringify({
    summary: "No issues found",
    findings: [],
  });

  it("returns successful result on primary model success", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse(validReviewJson));
    globalThis.fetch = mockFetch;

    vi.mocked(parseReview).mockReturnValue({
      summary: "No issues found",
      findings: [],
    });

    const batch = makeBatch(0, ["lib/main.dart"]);
    const perspective = makePerspective("generalist");
    const config = makeLLMConfig();

    const result = await reviewBatchFromPerspective(batch, perspective, config);

    expect(result.batchIndex).toBe(0);
    expect(result.perspectiveId).toBe("generalist");
    expect(result.perspectiveName).toBe("generalist Reviewer");
    expect(result.usedFallback).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.modelUsed).toBe("primary-model");
  });

  it("sends temperatureOverride in request body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse(validReviewJson));
    globalThis.fetch = mockFetch;

    vi.mocked(parseReview).mockReturnValue({
      summary: "No issues found",
      findings: [],
    });

    const batch = makeBatch(0, ["lib/main.dart"]);
    const perspective = makePerspective("generalist");
    const config = makeLLMConfig();

    await reviewBatchFromPerspective(batch, perspective, config, undefined, 0.7);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.temperature).toBe(0.7);
  });

  it("defaults temperature to 0.1 when no override", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse(validReviewJson));
    globalThis.fetch = mockFetch;

    vi.mocked(parseReview).mockReturnValue({
      summary: "No issues found",
      findings: [],
    });

    const batch = makeBatch(0, ["lib/main.dart"]);
    const perspective = makePerspective("generalist");
    const config = makeLLMConfig();

    await reviewBatchFromPerspective(batch, perspective, config);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.temperature).toBe(0.1);
  });

  it("uses modelOverride when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse(validReviewJson));
    globalThis.fetch = mockFetch;

    vi.mocked(parseReview).mockReturnValue({
      summary: "No issues found",
      findings: [],
    });

    const batch = makeBatch(0, ["lib/main.dart"]);
    const perspective = makePerspective("security");
    const config = makeLLMConfig();

    await reviewBatchFromPerspective(batch, perspective, config, "security-specialist-v2");

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.model).toBe("security-specialist-v2");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to fallbackModel on primary failure", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeErrorResponse(500, "Server error"))
      .mockResolvedValueOnce(makeSuccessResponse(validReviewJson));
    globalThis.fetch = mockFetch;

    vi.mocked(parseReview).mockReturnValue({
      summary: "No issues found",
      findings: [],
    });

    const batch = makeBatch(0, ["lib/main.dart"]);
    const perspective = makePerspective("generalist");
    const config = makeLLMConfig({ maxRetries: 1 });

    const result = await reviewBatchFromPerspective(batch, perspective, config);

    expect(result.usedFallback).toBe(true);
    expect(result.modelUsed).toBe("fallback-model");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(secondCallBody.model).toBe("fallback-model");
  });

  it("returns error result when both models fail", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeErrorResponse(500, "Server error"));
    globalThis.fetch = mockFetch;

    const batch = makeBatch(0, ["lib/main.dart"]);
    const perspective = makePerspective("generalist");
    const config = makeLLMConfig({ maxRetries: 1 });

    const result = await reviewBatchFromPerspective(batch, perspective, config);

    expect(result.error).toBeDefined();
    expect(result.error).toContain("Primary model:");
    expect(result.error).toContain("Fallback model:");
    expect(result.review.findings).toEqual([]);
  });

  it("skips primary when circuit breaker is open", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse(validReviewJson));
    globalThis.fetch = mockFetch;

    vi.mocked(parseReview).mockReturnValue({
      summary: "No issues found",
      findings: [],
    });

    const circuitBreaker = createCircuitBreaker(1);
    circuitBreaker.recordFailure();

    const batch = makeBatch(0, ["lib/main.dart"]);
    const perspective = makePerspective("generalist");
    const config = makeLLMConfig({ circuitBreaker });

    const result = await reviewBatchFromPerspective(batch, perspective, config);

    expect(result.usedFallback).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.model).toBe("fallback-model");
  });

  it("includes reasoning config when reasoningEffort is not none", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse(validReviewJson));
    globalThis.fetch = mockFetch;

    vi.mocked(parseReview).mockReturnValue({
      summary: "OK",
      findings: [],
    });

    const batch = makeBatch(0, ["lib/main.dart"]);
    const perspective = makePerspective("generalist");
    const config = makeLLMConfig({ reasoningEffort: "high" });

    await reviewBatchFromPerspective(batch, perspective, config);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.reasoning).toEqual({ effort: "high" });
  });

  it("omits reasoning config when reasoningEffort is none", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse(validReviewJson));
    globalThis.fetch = mockFetch;

    vi.mocked(parseReview).mockReturnValue({
      summary: "OK",
      findings: [],
    });

    const batch = makeBatch(0, ["lib/main.dart"]);
    const perspective = makePerspective("generalist");
    const config = makeLLMConfig({ reasoningEffort: "none" });

    await reviewBatchFromPerspective(batch, perspective, config);

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.reasoning).toBeUndefined();
  });
});
