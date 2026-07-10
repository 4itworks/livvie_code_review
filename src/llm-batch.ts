import * as core from "@actions/core";
import type {
  Batch,
  Perspective,
  BatchReviewResult,
  Semaphore,
  StructuredReview,
} from "./types.js";
import { createCircuitBreaker, calculateBackoff, parseRetryAfter, sleep } from "./circuit-breaker.js";
import { parseReview } from "./llm.js";

export interface LLMCallConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  maxOutputTokens: number;
  reasoningEffort: string;
  reviewInstructions: string;
  semaphore: Semaphore;
  circuitBreaker: ReturnType<typeof createCircuitBreaker>;
  maxRetries: number;
}

export async function reviewBatchFromPerspective(
  batch: Batch,
  perspective: Perspective,
  config: LLMCallConfig
): Promise<BatchReviewResult> {
  const skipPrimary = config.circuitBreaker.check();
  const release = await config.semaphore.acquire();
  const startTime = Date.now();

  try {
    const userContent = buildBatchUserMessage(batch, config.reviewInstructions);
    let review: StructuredReview | null = null;
    let modelUsed = "";
    let usedFallback = false;
    let error: string | undefined;

    if (!skipPrimary) {
      try {
        const result = await callLLMWithRetry(
          config.apiKey,
          config.baseUrl,
          config.model,
          perspective.systemPrompt,
          userContent,
          config.maxOutputTokens,
          config.reasoningEffort,
          config.maxRetries,
          config.circuitBreaker
        );
        config.circuitBreaker.recordSuccess();
        review = parseReview(result.content, perspective.id);
        modelUsed = result.modelUsed;
        core.info(`Batch ${batch.index} / ${perspective.name}: primary model succeeded (${review.findings.length} findings)`);
      } catch (primaryError) {
        config.circuitBreaker.recordFailure();
        const msg = primaryError instanceof Error ? primaryError.message : String(primaryError);
        core.warning(`Batch ${batch.index} / ${perspective.name}: primary model failed — ${msg}`);
        error = `Primary model: ${msg}`;
      }
    } else {
      core.info(`Batch ${batch.index} / ${perspective.name}: circuit breaker open, skipping primary model`);
      error = "Circuit breaker open — primary model skipped";
    }

    if (review === null && config.fallbackModel) {
      try {
        const result = await callLLMWithRetry(
          config.apiKey,
          config.baseUrl,
          config.fallbackModel,
          perspective.systemPrompt,
          userContent,
          config.maxOutputTokens,
          "none",
          config.maxRetries,
          config.circuitBreaker
        );
        config.circuitBreaker.recordSuccess();
        review = parseReview(result.content, perspective.id);
        modelUsed = result.modelUsed;
        usedFallback = true;
        core.info(`Batch ${batch.index} / ${perspective.name}: fallback model succeeded (${review.findings.length} findings)`);
      } catch (fallbackError) {
        const msg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        core.warning(`Batch ${batch.index} / ${perspective.name}: fallback model also failed — ${msg}`);
        error = error ? `${error}; Fallback model: ${msg}` : `Fallback model: ${msg}`;
      }
    }

    const latencyMs = Date.now() - startTime;

    if (review === null) {
      return {
        batchIndex: batch.index,
        perspectiveId: perspective.id,
        perspectiveName: perspective.name,
        review: { summary: "", findings: [] },
        modelUsed: modelUsed || (skipPrimary ? config.fallbackModel : config.model),
        latencyMs,
        usedFallback: false,
        error,
      };
    }

    return {
      batchIndex: batch.index,
      perspectiveId: perspective.id,
      perspectiveName: perspective.name,
      review,
      modelUsed,
      latencyMs,
      usedFallback,
      error,
    };
  } finally {
    release();
  }
}

export function buildBatchUserMessage(
  batch: Batch,
  reviewInstructions: string
): string {
  const parts: string[] = [];

  if (reviewInstructions.trim()) {
    parts.push("## Project-specific review rules");
    parts.push(reviewInstructions);
    parts.push("");
  }

  if (batch.crossFileContext.trim()) {
    parts.push("## Cross-file context (context only — do NOT review these files)");
    parts.push(batch.crossFileContext);
    parts.push("");
  }

  parts.push("## Files to review");
  parts.push("");

  for (const file of batch.files) {
    parts.push(`### ${file.filename} (${file.additions}+, ${file.deletions}-)`);
    parts.push("Full file with line numbers. Lines marked with → were changed in this PR.");
    parts.push("");
    parts.push("```");
    parts.push(file.content);
    parts.push("```");
    parts.push("");
  }

  parts.push("Return your review as a JSON object. Only return JSON, no markdown.");

  return parts.join("\n");
}

export async function callLLMWithRetry(
  apiKey: string,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  maxOutputTokens: number,
  reasoningEffort: string,
  maxRetries: number,
  circuitBreaker: ReturnType<typeof createCircuitBreaker>
): Promise<{ content: string; modelUsed: string }> {
  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.1,
    max_tokens: maxOutputTokens,
    response_format: { type: "json_object" },
  };

  if (reasoningEffort !== "none") {
    requestBody.reasoning = { effort: reasoningEffort };
  }

  const body = JSON.stringify(requestBody);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": "https://github.com/4itworks/livvie_code_review",
            "X-Title": "livvie-code-review",
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errorText = await response.text();
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        if (retryAfter !== null && attempt < maxRetries) {
          core.warning(`LLM API ${response.status} (attempt ${attempt}/${maxRetries}). Retry-After: ${retryAfter}ms. Waiting...`);
          await sleep(retryAfter);
          continue;
        }
        const sanitizedError = errorText.replace(/Bearer\s+[\w-]+/gi, "Bearer [REDACTED]").slice(0, 500);
        throw new Error(`LLM API error ${response.status}: ${sanitizedError}`);
      }

      const responseText = await response.text();

      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error(
          `LLM returned truncated or invalid JSON response (${responseText.length} chars). ` +
          `Preview: ${responseText.slice(0, 200)}...`
        );
      }

      const content = data.choices?.[0]?.message?.content;
      const reasoningContent = data.choices?.[0]?.message?.reasoning_content;
      const finishReason = data.choices?.[0]?.finish_reason;

      if (!content || content.length < 20) {
        const detail = finishReason === "length"
          ? `Model hit token limit (finish_reason: length). Reasoning consumed all ${maxOutputTokens} tokens with none left for output. Increase max-output-tokens or reduce reasoning-effort.`
          : `content too short (${content?.length || 0} chars, finish_reason: ${finishReason || "unknown"})`;
        throw new Error(`LLM returned empty/short response: ${detail}`);
      }

      if (content.length < 100) {
        core.warning(`LLM response is suspiciously short (${content.length} chars): "${content}"`);
      }

      if (reasoningContent && process.env.LIVVIE_VERBOSE === "1") {
        core.info("=== Reasoning trace ===");
        const trace = reasoningContent.length > 2000
          ? reasoningContent.slice(0, 2000) + "...(truncated)"
          : reasoningContent;
        core.info(trace);
        core.info("=== End reasoning trace ===");
      }

      return { content, modelUsed: model };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const delay = calculateBackoff(attempt);
        core.warning(`LLM request failed (attempt ${attempt}/${maxRetries}): ${lastError.message}. Retrying in ${Math.round(delay / 1000)}s...`);
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error("LLM request failed after retries");
}
