import type { DiffFile } from "./types.js";

export function parseIgnorePatterns(input: string): string[] {
  if (!input || !input.trim()) return [];
  return input
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") {
          i++;
        }
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (char === ".") {
      regex += "\\.";
      i++;
    } else if (char === "/") {
      regex += "/";
      i++;
    } else if ("\\^$+?()[]{}".includes(char)) {
      regex += "\\" + char;
      i++;
    } else {
      regex += char;
      i++;
    }
  }
  return new RegExp("^" + regex + "$");
}

export function shouldIgnoreFile(filename: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const regex = globToRegex(pattern);
    if (regex.test(filename)) {
      return true;
    }

    // Patterns without a slash match the basename anywhere in the tree
    // (e.g., "*.g.dart" matches both "foo.g.dart" and "lib/foo.g.dart").
    if (!pattern.includes("/")) {
      const basename = filename.split("/").pop() ?? filename;
      if (regex.test(basename)) {
        return true;
      }
    }
  }
  return false;
}

export function filterIgnoredFiles(
  files: DiffFile[],
  patterns: string[],
): { kept: DiffFile[]; ignored: DiffFile[] } {
  const kept: DiffFile[] = [];
  const ignored: DiffFile[] = [];
  for (const file of files) {
    if (shouldIgnoreFile(file.filename, patterns)) {
      ignored.push(file);
    } else {
      kept.push(file);
    }
  }
  return { kept, ignored };
}
