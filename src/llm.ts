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
  maxOutputTokens: number
): Promise<StructuredReview> {
  const userContent = buildUserMessage(diffText, reviewInstructions);

  core.info(`Sending review request to ${model}...`);
  core.info(`Diff size: ${diffText.length} chars`);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/4itworks/livvie-code-review",
      "X-Title": "livvie-code-review",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
      max_tokens: maxOutputTokens,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LLM returned empty response");
  }

  core.info("Received LLM response, parsing...");

  return parseReview(content);
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

function parseReview(content: string): StructuredReview {
  const jsonText = extractJson(content);

  if (!jsonText) {
    core.warning("Could not extract JSON from LLM response, treating as raw summary");
    return { summary: content, findings: [] };
  }

  try {
    const parsed = JSON.parse(jsonText) as LLMResponse;
    return {
      summary: parsed.summary || "",
      findings: (parsed.findings || []).map(normalizeFinding).filter(isValidFinding),
    };
  } catch (error) {
    core.warning(`Failed to parse JSON review: ${error}`);
    return { summary: content, findings: [] };
  }
}

function extractJson(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  return content.slice(start, end + 1).trim();
}

function normalizeFinding(raw: any): ReviewFinding {
  return {
    severity: raw.severity === "high" || raw.severity === "medium" || raw.severity === "low"
      ? raw.severity
      : "low",
    file: String(raw.file || "").trim(),
    line: Number(raw.line) || 0,
    description: String(raw.description || "").trim(),
    suggestion: raw.suggestion ? String(raw.suggestion).trim() : null,
  };
}

function isValidFinding(f: ReviewFinding): boolean {
  return f.file.length > 0 && f.line > 0 && f.description.length > 0;
}
