import * as core from "@actions/core";
import type { StructuredReview, ReviewFinding } from "./types.js";

interface LLMResponse {
  summary: string;
  findings: ReviewFinding[];
}

export async function reviewWithLLM(
  apiKey: string,
  baseUrl: string,
  model: string,
  systemPrompt: string,
  diffText: string,
  reviewInstructions: string,
  maxOutputTokens: number,
  reasoningEffort: string
): Promise<StructuredReview> {
  const userContent = buildUserMessage(diffText, reviewInstructions);

  core.info(`Sending review request to ${model}...`);
  core.info(`Diff size: ${diffText.length} chars`);
  if (reasoningEffort !== "none") {
    core.info(`Reasoning effort: ${reasoningEffort}`);
    if (reasoningEffort === "max" && maxOutputTokens < 64000) {
      core.warning(
        `reasoning-effort=max with max-output-tokens=${maxOutputTokens} — ` +
        `reasoning tokens count toward the output limit. ` +
        `Consider increasing max-output-tokens to 64000+ to avoid truncated reviews.`
      );
    }
  }

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

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://github.com/4itworks/livvie_code_review",
          "X-Title": "livvie-code-review",
        },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API error ${response.status}: ${errorText}`);
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

      if (!content) {
        const detail = finishReason === "length"
          ? `Model hit token limit (finish_reason: length). Reasoning consumed all ${maxOutputTokens} tokens with none left for output. Increase max-output-tokens or reduce reasoning-effort.`
          : `content was null/empty (finish_reason: ${finishReason || "unknown"})`;
        throw new Error(`LLM returned empty response: ${detail}`);
      }

      if (reasoningContent) {
        core.info("=== Reasoning trace ===");
        const trace = reasoningContent.length > 2000
          ? reasoningContent.slice(0, 2000) + "...(truncated)"
          : reasoningContent;
        core.info(trace);
        core.info("=== End reasoning trace ===");
      }

      core.info("Received LLM response, parsing...");

      return parseReview(content, "generalist");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const delay = attempt * 5;
        core.warning(`LLM request failed (attempt ${attempt}/${maxRetries}): ${lastError.message}. Retrying in ${delay}s...`);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  }

  throw lastError ?? new Error("LLM request failed after retries");
}

function buildUserMessage(diffText: string, reviewInstructions: string): string {
  const parts: string[] = [];

  if (reviewInstructions.trim()) {
    parts.push("## Project-specific review rules");
    parts.push(reviewInstructions);
    parts.push("");
  }

  parts.push("## Pull request diff");
  parts.push(diffText);
  parts.push("");
  parts.push("Return your review as a JSON object. Only return JSON, no markdown.");

  return parts.join("\n");
}

export function parseReview(content: string, perspectiveId: string): StructuredReview {
  const jsonText = extractJson(content);

  if (!jsonText) {
    core.warning(`Could not extract JSON from LLM response (${content.length} chars). Attempting repair...`);
    const repaired = attemptJsonRepair(content);
    if (repaired) {
      core.info("Successfully repaired JSON from raw text response.");
      try {
        const parsed = JSON.parse(repaired) as LLMResponse;
        return {
          summary: parsed.summary || content.slice(0, 200),
          findings: (parsed.findings || []).map((f: any) => normalizeFinding(f, perspectiveId)).filter(isValidFinding),
        };
      } catch (error) {
        core.warning(`Repaired JSON parse failed: ${error}`);
      }
    }
    return { summary: content.slice(0, 500), findings: [] };
  }

  try {
    const parsed = JSON.parse(jsonText) as LLMResponse;
    return {
      summary: parsed.summary || "",
      findings: (parsed.findings || []).map((f: any) => normalizeFinding(f, perspectiveId)).filter(isValidFinding),
    };
  } catch (error) {
    core.warning(`Failed to parse JSON review: ${error}`);
    return { summary: content.slice(0, 500), findings: [] };
  }
}

function attemptJsonRepair(content: string): string | null {
  const patterns = [
    /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i,
    /(\{[\s\S]*\})/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      var candidate = match[1].trim();
      candidate = fixTrailingCommas(candidate);
      candidate = fixUnclosedBraces(candidate);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  var start = content.indexOf("{");
  var end = content.lastIndexOf("}");
  if (start !== -1 && end > start) {
    var candidate2 = content.slice(start, end + 1).trim();
    candidate2 = fixTrailingCommas(candidate2);
    candidate2 = fixUnclosedBraces(candidate2);
    try {
      JSON.parse(candidate2);
      return candidate2;
    } catch {
      return null;
    }
  }

  return null;
}

function fixTrailingCommas(json: string): string {
  return json.replace(/,\s*([}\]])/g, "$1");
}

function fixUnclosedBraces(json: string): string {
  var opens = (json.match(/{/g) || []).length;
  var closes = (json.match(/}/g) || []).length;
  if (opens > closes) {
    json += "}".repeat(opens - closes);
  }
  var openBrackets = (json.match(/\[/g) || []).length;
  var closeBrackets = (json.match(/\]/g) || []).length;
  if (openBrackets > closeBrackets) {
    json += "]".repeat(openBrackets - closeBrackets);
  }
  return json;
}

export function extractJson(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  return content.slice(start, end + 1).trim();
}

export function normalizeFinding(raw: any, perspectiveId: string): ReviewFinding {
  const hasSuggestion = raw.suggestion && String(raw.suggestion).trim().length > 0;
  const line = Number(raw.line) || 0;
  const suggestionStartLine = Number(raw.suggestion_start_line) || null;

  return {
    severity: raw.severity === "high" || raw.severity === "medium" || raw.severity === "low"
      ? raw.severity
      : "low",
    confidence: raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low"
      ? raw.confidence
      : "medium",
    file: String(raw.file || "").trim(),
    line,
    description: String(raw.description || "").trim(),
    suggestion: hasSuggestion ? String(raw.suggestion).trim() : null,
    suggestionStartLine: hasSuggestion && suggestionStartLine && suggestionStartLine > 0 && suggestionStartLine < line
      ? suggestionStartLine
      : null,
    perspective: perspectiveId,
    foundBy: [perspectiveId],
  };
}

export function isValidFinding(f: ReviewFinding): boolean {
  return f.file.length > 0 && f.line > 0 && f.description.length > 0;
}
