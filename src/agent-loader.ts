import * as core from "@actions/core";
import type { Octokit } from "@octokit/rest";
import type { Perspective, AgentModelOverrides } from "./types.js";
import { SHARED_REVIEW_RULES } from "./shared-rules.js";

const AGENT_COUNT_WARNING_THRESHOLD = 10;
const MAX_TEMPERATURE = 2;
const DEFAULT_TEMPERATURE = 0.1;

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface AgentFile {
  filename: string;
  content: string;
}

interface ParsedAgent {
  perspective: Perspective;
  enabled: boolean;
  override: AgentModelOverrides | null;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlBlock = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  for (const line of yamlBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();

    if (!key) continue;

    if (rawValue === "" || rawValue === '""' || rawValue === "''") {
      frontmatter[key] = "";
    } else if (rawValue.toLowerCase() === "true") {
      frontmatter[key] = true;
    } else if (rawValue.toLowerCase() === "false") {
      frontmatter[key] = false;
    } else if (rawValue.toLowerCase() === "null" || rawValue.toLowerCase() === "~") {
      frontmatter[key] = null;
    } else {
      const num = Number(rawValue);
      if (!isNaN(num) && rawValue !== "") {
        frontmatter[key] = num;
      } else {
        if (
          (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
          (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ) {
          frontmatter[key] = rawValue.slice(1, -1);
        } else {
          frontmatter[key] = rawValue;
        }
      }
    }
  }

  return { frontmatter, body };
}

function decodeBase64Content(content: string): string {
  return Buffer.from(content, "base64").toString("utf-8");
}

function parseAgentFile(file: AgentFile, seenNames: Set<string>): ParsedAgent {
  const stem = file.filename.replace(/\.md$/i, "").toLowerCase();
  const { frontmatter, body } = parseFrontmatter(file.content);

  const name = (frontmatter.name as string)?.trim() || stem;
  if (!name) {
    throw new Error(`Agent file "${file.filename}" has no name`);
  }

  const trimmedBody = body.trim();
  if (!trimmedBody) {
    throw new Error(`Agent file "${file.filename}" has an empty body`);
  }

  if (seenNames.has(name.toLowerCase())) {
    throw new Error(`Duplicate agent name: "${name}"`);
  }
  seenNames.add(name.toLowerCase());

  const enabled = frontmatter.enabled !== false;

  const systemPrompt = trimmedBody + "\n\n" + SHARED_REVIEW_RULES;

  const focus = ((frontmatter.focus as string) || "").trim();

  let override: AgentModelOverrides | null = null;
  const hasModel = "model" in frontmatter;
  const hasTemperature = "temperature" in frontmatter;

  if (hasModel || hasTemperature) {
    const model = hasModel ? (frontmatter.model as string | null) : null;
    let temperature = hasTemperature ? (frontmatter.temperature as number) : undefined;

    if (temperature !== undefined) {
      if (temperature < 0 || temperature > MAX_TEMPERATURE) {
        core.warning(
          `Agent "${name}" temperature ${temperature} out of range; clamped to [0, ${MAX_TEMPERATURE}]`,
        );
      }
      temperature = Math.max(0, Math.min(MAX_TEMPERATURE, temperature));
    }

    if (model || temperature !== undefined) {
      override = { model: model ?? null, temperature: temperature ?? DEFAULT_TEMPERATURE };
    }
  }

  return {
    perspective: { id: stem, name, systemPrompt, focus },
    enabled,
    override,
  };
}

export async function loadAgents(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  agentsDir: string,
): Promise<{
  perspectives: Perspective[];
  agentModelOverrides: Map<string, AgentModelOverrides>;
}> {
  let dirContents;
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: agentsDir,
      ref,
    });

    if (!Array.isArray(response.data)) {
      throw new Error(`"${agentsDir}" is not a directory`);
    }

    dirContents = response.data;
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    if (err.status === 404) {
      throw new Error(`Agents directory not found: "${agentsDir}"`, { cause: error });
    }
    throw error;
  }

  const mdFiles = dirContents.filter(
    (item) => item.type === "file" && item.name.toLowerCase().endsWith(".md"),
  );

  if (mdFiles.length === 0) {
    throw new Error(`No agent files found in "${agentsDir}"`);
  }

  const nonMdFiles = dirContents.filter(
    (item) => item.type === "file" && !item.name.toLowerCase().endsWith(".md"),
  );
  if (nonMdFiles.length > 0) {
    core.info(`Ignoring ${nonMdFiles.length} non-.md file(s) in "${agentsDir}"`);
  }

  const agentFiles: AgentFile[] = await Promise.all(
    mdFiles.map(async (file) => {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: file.path,
        ref,
      });

      const data = response.data as { content?: string };
      const content = data.content ? decodeBase64Content(data.content) : "";

      return {
        filename: file.name,
        content,
      };
    }),
  );

  agentFiles.sort((a, b) => a.filename.localeCompare(b.filename));

  const seenNames = new Set<string>();
  const perspectives: Perspective[] = [];
  const agentModelOverrides = new Map<string, AgentModelOverrides>();

  for (const file of agentFiles) {
    const parsed = parseAgentFile(file, seenNames);

    if (!parsed.enabled) {
      core.info(`Skipping disabled agent: "${parsed.perspective.name}"`);
      continue;
    }

    perspectives.push(parsed.perspective);

    if (parsed.override) {
      agentModelOverrides.set(parsed.perspective.id, parsed.override);
    }

    core.info(`Loaded agent: "${parsed.perspective.name}" (${parsed.perspective.id})`);
  }

  if (perspectives.length === 0) {
    throw new Error(`All agents in "${agentsDir}" are disabled`);
  }

  if (perspectives.length > AGENT_COUNT_WARNING_THRESHOLD) {
    core.warning(
      `Loaded ${perspectives.length} agents — consider reducing to <= ${AGENT_COUNT_WARNING_THRESHOLD} for performance`,
    );
  }

  return { perspectives, agentModelOverrides };
}
