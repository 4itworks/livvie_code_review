import * as core from "@actions/core";
import type { StructuredReview, ReviewFinding } from "./types.js";
import { validateSuggestion } from "./suggestion.js";

interface LLMResponse {
  summary: string;
  findings: ReviewFinding[];
}

export function parseReview(content: string, perspectiveId: string): StructuredReview {
  const jsonText = extractJson(content);

  if (!jsonText) {
    core.warning(
      `Could not extract JSON from LLM response (${content.length} chars). Attempting repair...`,
    );
    const repaired = attemptJsonRepair(content);
    if (repaired) {
      core.info("Successfully repaired JSON from raw text response.");
      try {
        const parsed = JSON.parse(repaired) as LLMResponse;
        return {
          summary: parsed.summary || content.slice(0, 200),
          findings: (parsed.findings || [])
            .map((f: any) => normalizeFinding(f, perspectiveId))
            .filter(isValidFinding),
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
      findings: (parsed.findings || [])
        .map((f: any) => normalizeFinding(f, perspectiveId))
        .filter(isValidFinding),
    };
  } catch (error) {
    core.warning(`Failed to parse JSON review: ${error}`);
    return { summary: content.slice(0, 500), findings: [] };
  }
}

function attemptJsonRepair(content: string): string | null {
  const patterns = [/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i, /(\{[\s\S]*\})/];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      let candidate = match[1].trim();
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

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start !== -1 && end > start) {
    let candidate2 = content.slice(start, end + 1).trim();
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
  const opens = (json.match(/{/g) || []).length;
  const closes = (json.match(/}/g) || []).length;
  if (opens > closes) {
    json += "}".repeat(opens - closes);
  }
  const openBrackets = (json.match(/\[/g) || []).length;
  const closeBrackets = (json.match(/]/g) || []).length;
  if (openBrackets > closeBrackets) {
    json += "]".repeat(openBrackets - closeBrackets);
  }
  return json;
}

function extractJson(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  return content.slice(start, end + 1).trim();
}

export function normalizeFinding(
  raw: Record<string, unknown>,
  perspectiveId: string,
): ReviewFinding {
  const hasSuggestion = raw.suggestion && String(raw.suggestion).trim().length > 0;
  const line = Number(raw.line) || 0;
  const suggestionStartLine = Number(raw.suggestion_start_line) || null;

  const normalized: ReviewFinding = {
    severity:
      raw.severity === "high" || raw.severity === "medium" || raw.severity === "low"
        ? raw.severity
        : "low",
    confidence:
      raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low"
        ? raw.confidence
        : "medium",
    file: String(raw.file || "").trim(),
    line,
    description: String(raw.description || "").trim(),
    suggestion: hasSuggestion ? String(raw.suggestion).trim() : null,
    suggestionStartLine:
      hasSuggestion && suggestionStartLine && suggestionStartLine > 0 && suggestionStartLine < line
        ? suggestionStartLine
        : null,
    perspective: perspectiveId,
    foundBy: [perspectiveId],
  };

  return validateSuggestion(normalized);
}

export function isValidFinding(f: ReviewFinding): boolean {
  return f.file.length > 0 && f.line > 0 && f.description.length > 0;
}
