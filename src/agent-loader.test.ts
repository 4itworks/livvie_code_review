import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

import * as core from "@actions/core";
import { parseFrontmatter, loadAgents } from "./agent-loader.js";
import { SHARED_REVIEW_RULES } from "./shared-rules.js";

function makeOctokitMock(getContentImpl: (...args: unknown[]) => unknown) {
  return {
    rest: {
      repos: {
        getContent: vi.fn().mockImplementation(getContentImpl),
      },
    },
  } as never;
}

describe("parseFrontmatter", () => {
  it("parses valid frontmatter with key-value pairs", () => {
    const content = `---
name: Security Reviewer
focus: injection risks
enabled: true
temperature: 0.5
model: gpt-4
---

Body content here.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({
      name: "Security Reviewer",
      focus: "injection risks",
      enabled: true,
      temperature: 0.5,
      model: "gpt-4",
    });
    expect(result.body.trim()).toBe("Body content here.");
  });

  it("returns empty frontmatter and full body when no frontmatter present", () => {
    const content = "Just some body content without frontmatter.";
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it("handles Windows-style line endings (\\r\\n)", () => {
    const content = "---\r\nname: Test\r\n---\r\nBody.";
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe("Test");
    expect(result.body).toBe("Body.");
  });

  it("coerces true/false booleans (case-insensitive)", () => {
    const content = `---
a: true
b: True
c: TRUE
d: false
e: False
f: FALSE
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.a).toBe(true);
    expect(result.frontmatter.b).toBe(true);
    expect(result.frontmatter.c).toBe(true);
    expect(result.frontmatter.d).toBe(false);
    expect(result.frontmatter.e).toBe(false);
    expect(result.frontmatter.f).toBe(false);
  });

  it("coerces numbers", () => {
    const content = `---
temperature: 0.7
count: 42
negative: -5
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.temperature).toBe(0.7);
    expect(result.frontmatter.count).toBe(42);
    expect(result.frontmatter.negative).toBe(-5);
  });

  it("coerces null and ~ to null", () => {
    const content = `---
a: null
b: Null
c: ~
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.a).toBeNull();
    expect(result.frontmatter.b).toBeNull();
    expect(result.frontmatter.c).toBeNull();
  });

  it("coerces empty string / quoted empty string to empty string", () => {
    const content = `---
a:
b: ""
c: ''
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.a).toBe("");
    expect(result.frontmatter.b).toBe("");
    expect(result.frontmatter.c).toBe("");
  });

  it("strips surrounding quotes from string values", () => {
    const content = `---
name: "Quoted Name"
desc: 'Single Quoted'
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe("Quoted Name");
    expect(result.frontmatter.desc).toBe("Single Quoted");
  });

  it("handles multi-line body content", () => {
    const content = `---
name: Test
---

Line 1
Line 2
Line 3`;
    const result = parseFrontmatter(content);
    expect(result.body.trim()).toBe("Line 1\nLine 2\nLine 3");
  });

  it("handles empty body after frontmatter", () => {
    const content = `---
name: Test
---
`;
    const result = parseFrontmatter(content);
    expect(result.body.trim()).toBe("");
  });

  it("ignores malformed YAML lines without colons", () => {
    const content = `---
name: Valid
this is not yaml
another bad line
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe("Valid");
    expect(Object.keys(result.frontmatter)).toHaveLength(1);
  });

  it("handles values with colons inside them", () => {
    const content = `---
url: https://example.com:8080
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.url).toBe("https://example.com:8080");
  });
});

describe("loadAgents", () => {
  beforeEach(() => {
    vi.mocked(core.info).mockClear();
    vi.mocked(core.warning).mockClear();
  });

  function fileResponse(name: string, content: string, path?: string) {
    return {
      type: "file",
      name,
      path: path ?? `agents/${name}`,
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    };
  }

  function dirResponse(...files: ReturnType<typeof fileResponse>[]) {
    return { data: files };
  }

  it("throws when directory not found (404)", async () => {
    const octokit = makeOctokitMock(() => {
      const error = new Error("Not Found") as Error & { status: number };
      error.status = 404;
      throw error;
    });

    await expect(loadAgents(octokit, "owner", "repo", "main", "agents")).rejects.toThrow(
      'Agents directory not found: "agents"',
    );
  });

  it("throws when path is not a directory", async () => {
    const octokit = makeOctokitMock(() => ({
      data: { type: "file", name: "agents" },
    }));

    await expect(loadAgents(octokit, "owner", "repo", "main", "agents")).rejects.toThrow(
      '"agents" is not a directory',
    );
  });

  it("throws on empty directory (no .md files)", async () => {
    const octokit = makeOctokitMock(() => dirResponse());

    await expect(loadAgents(octokit, "owner", "repo", "main", "agents")).rejects.toThrow(
      'No agent files found in "agents"',
    );
  });

  it("throws when directory has only non-.md files", async () => {
    const octokit = makeOctokitMock(() =>
      dirResponse({
        type: "file",
        name: "README.txt",
        path: "agents/README.txt",
        content: Buffer.from("text").toString("base64"),
        encoding: "base64",
      }),
    );

    await expect(loadAgents(octokit, "owner", "repo", "main", "agents")).rejects.toThrow(
      'No agent files found in "agents"',
    );
  });

  it("loads a single valid agent file", async () => {
    const agentContent = `---
name: Security Reviewer
focus: injection risks
---

Review for security vulnerabilities.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("security.md", agentContent));
      }
      return { data: fileResponse("security.md", agentContent) };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.perspectives).toHaveLength(1);
    expect(result.perspectives[0].id).toBe("security");
    expect(result.perspectives[0].name).toBe("Security Reviewer");
    expect(result.perspectives[0].focus).toBe("injection risks");
    expect(result.perspectives[0].systemPrompt).toContain("Review for security vulnerabilities.");
    expect(result.perspectives[0].systemPrompt).toContain(SHARED_REVIEW_RULES);
  });

  it("loads multiple files sorted alphabetically", async () => {
    const securityContent = `---
name: Security Reviewer
focus: injection risks
---
Security body.`;
    const qualityContent = `---
name: Code Quality
focus: readability
---
Quality body.`;
    const perfContent = `---
name: Performance
focus: speed
---
Perf body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(
          fileResponse("security.md", securityContent),
          fileResponse("code-quality.md", qualityContent),
          fileResponse("performance.md", perfContent),
        );
      }
      const files: Record<string, string> = {
        "agents/security.md": securityContent,
        "agents/code-quality.md": qualityContent,
        "agents/performance.md": perfContent,
      };
      const content = files[args.path];
      return {
        data: fileResponse(args.path.split("/").pop()!, content ?? "", args.path),
      };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.perspectives).toHaveLength(3);
    expect(result.perspectives[0].id).toBe("code-quality");
    expect(result.perspectives[1].id).toBe("performance");
    expect(result.perspectives[2].id).toBe("security");
  });

  it("ignores non-.md files", async () => {
    const agentContent = `---
name: Security
---
Body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(
          fileResponse("security.md", agentContent),
          {
            type: "file",
            name: "README.txt",
            path: "agents/README.txt",
            content: Buffer.from("readme").toString("base64"),
            encoding: "base64",
          },
          {
            type: "file",
            name: "config.json",
            path: "agents/config.json",
            content: Buffer.from("{}").toString("base64"),
            encoding: "base64",
          },
        );
      }
      return { data: fileResponse("security.md", agentContent) };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.perspectives).toHaveLength(1);
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("Ignoring 2 non-.md file(s)"));
  });

  it("throws on duplicate agent names", async () => {
    const content = `---
name: Security
---
Body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(
          fileResponse("security.md", content),
          fileResponse("security-review.md", content),
        );
      }
      return { data: fileResponse("dummy.md", content) };
    });

    await expect(loadAgents(octokit, "owner", "repo", "main", "agents")).rejects.toThrow(
      'Duplicate agent name: "Security"',
    );
  });

  it("throws on empty body", async () => {
    const content = `---
name: Security
---
`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("security.md", content));
      }
      return { data: fileResponse("security.md", content) };
    });

    await expect(loadAgents(octokit, "owner", "repo", "main", "agents")).rejects.toThrow(
      'Agent file "security.md" has an empty body',
    );
  });

  it("skips agents with enabled=false", async () => {
    const enabledContent = `---
name: Active Agent
---
Active body.`;
    const disabledContent = `---
name: Disabled Agent
enabled: false
---
Disabled body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(
          fileResponse("active.md", enabledContent),
          fileResponse("disabled.md", disabledContent),
        );
      }
      const files: Record<string, string> = {
        "agents/active.md": enabledContent,
        "agents/disabled.md": disabledContent,
      };
      return {
        data: fileResponse(args.path.split("/").pop()!, files[args.path] ?? "", args.path),
      };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.perspectives).toHaveLength(1);
    expect(result.perspectives[0].name).toBe("Active Agent");
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("Skipping disabled agent"));
  });

  it("throws when all agents are disabled", async () => {
    const disabledContent = `---
name: Disabled
enabled: false
---
Body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("disabled.md", disabledContent));
      }
      return { data: fileResponse("disabled.md", disabledContent) };
    });

    await expect(loadAgents(octokit, "owner", "repo", "main", "agents")).rejects.toThrow(
      'All agents in "agents" are disabled',
    );
  });

  it("collects agent model overrides", async () => {
    const content = `---
name: Custom Agent
model: gpt-4o
temperature: 0.7
focus: custom
---
Body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("custom.md", content));
      }
      return { data: fileResponse("custom.md", content) };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.agentModelOverrides.size).toBe(1);
    expect(result.agentModelOverrides.get("custom")).toEqual({
      model: "gpt-4o",
      temperature: 0.7,
    });
  });

  it("clamps temperature to [0, 2]", async () => {
    const highTemp = `---
name: High Temp
temperature: 5
---
Body.`;
    const lowTemp = `---
name: Low Temp
temperature: -1
---
Body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("high.md", highTemp), fileResponse("low.md", lowTemp));
      }
      const files: Record<string, string> = {
        "agents/high.md": highTemp,
        "agents/low.md": lowTemp,
      };
      return {
        data: fileResponse(args.path.split("/").pop()!, files[args.path] ?? "", args.path),
      };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.agentModelOverrides.get("high")!.temperature).toBe(2);
    expect(result.agentModelOverrides.get("low")!.temperature).toBe(0);
  });

  it("no frontmatter fallback: name derived from filename stem", async () => {
    const content = "Just a plain body with no frontmatter at all.";

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("security.md", content));
      }
      return { data: fileResponse("security.md", content) };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.perspectives).toHaveLength(1);
    expect(result.perspectives[0].id).toBe("security");
    expect(result.perspectives[0].name).toBe("security");
    expect(result.perspectives[0].systemPrompt).toContain(content);
    expect(result.perspectives[0].systemPrompt).toContain(SHARED_REVIEW_RULES);
  });

  it("uses filename stem as id even with frontmatter name", async () => {
    const content = `---
name: My Custom Reviewer
---
Body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("custom-review.md", content));
      }
      return { data: fileResponse("custom-review.md", content) };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.perspectives[0].id).toBe("custom-review");
    expect(result.perspectives[0].name).toBe("My Custom Reviewer");
  });

  it("warns when > 10 agents loaded", async () => {
    const files: ReturnType<typeof fileResponse>[] = [];
    for (let i = 0; i < 11; i++) {
      const name = `Agent ${i}`;
      const filename = `agent-${i}.md`;
      const content = `---\nname: ${name}\n---\nBody ${i}.`;
      files.push(fileResponse(filename, content));
    }

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(...files);
      }
      const filename = args.path.split("/").pop()!;
      const idx = parseInt(filename.replace("agent-", "").replace(".md", ""));
      return {
        data: fileResponse(filename, `---\nname: Agent ${idx}\n---\nBody ${idx}.`),
      };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.perspectives).toHaveLength(11);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Loaded 11 agents"));
  });

  it("systemPrompt contains body + SHARED_REVIEW_RULES", async () => {
    const bodyText = "Custom review instructions here.";
    const content = `---
name: Test
---
${bodyText}`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("test.md", content));
      }
      return { data: fileResponse("test.md", content) };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.perspectives[0].systemPrompt).toContain(bodyText);
    expect(result.perspectives[0].systemPrompt).toContain(SHARED_REVIEW_RULES);
    expect(result.perspectives[0].systemPrompt).toMatch(
      new RegExp(bodyText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n\\n"),
    );
  });

  it("logs each loaded agent via core.info", async () => {
    const content = `---
name: Security Reviewer
---
Body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("security.md", content));
      }
      return { data: fileResponse("security.md", content) };
    });

    await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(core.info).toHaveBeenCalledWith('Loaded agent: "Security Reviewer" (security)');
  });

  it("does not collect override when no model/temperature in frontmatter", async () => {
    const content = `---
name: Plain Agent
focus: general
---
Body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("plain.md", content));
      }
      return { data: fileResponse("plain.md", content) };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.agentModelOverrides.size).toBe(0);
  });

  it("collects override with only temperature (no model)", async () => {
    const content = `---
name: Temp Only
temperature: 0.3
---
Body.`;

    const octokit = makeOctokitMock((args: Record<string, string>) => {
      if (args.path === "agents") {
        return dirResponse(fileResponse("temp.md", content));
      }
      return { data: fileResponse("temp.md", content) };
    });

    const result = await loadAgents(octokit, "owner", "repo", "main", "agents");

    expect(result.agentModelOverrides.get("temp")).toEqual({
      model: null,
      temperature: 0.3,
    });
  });
});
