/**
 * A string-replacement Edit tool for aisdk sessions — the OpenAI-compatible
 * counterpart to Claude Code's built-in Edit. Match tiers, tried in order:
 *
 *   1. exact substring        (supports `replace_all`)
 *   2. per-line trailing-whitespace-insensitive   (must be unique)
 *   3. dedented + trailing-insensitive            (must be unique)
 *
 * When a fuzzy tier matches, the *original* file text in that span is what gets
 * replaced; `new_string` is inserted verbatim, so its indentation is the
 * caller's responsibility.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";

export interface EditOutcome {
  ok: boolean;
  message: string;
  replacements: number;
  tier?: "exact" | "trailing-insensitive" | "dedented";
}

export function applyEdit(
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditOutcome {
  if (oldString === newString) {
    return { ok: false, message: "old_string and new_string are identical", replacements: 0 };
  }
  if (oldString === "") {
    // The fuzzy tiers can "match" an empty needle against the phantom trailing
    // line of a newline-terminated file and silently append. Require a target.
    return { ok: false, message: "old_string must not be empty", replacements: 0 };
  }

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, message: `cannot read ${path}: ${(err as Error).message}`, replacements: 0 };
  }

  // Tier 1 — exact.
  const exact = allIndexesOf(content, oldString);
  if (exact.length > 0) {
    if (exact.length > 1 && !replaceAll) {
      return {
        ok: false,
        message: `old_string occurs ${exact.length} times — pass replace_all or add surrounding context to make it unique`,
        replacements: 0,
      };
    }
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.slice(0, exact[0]) + newString + content.slice(exact[0]! + oldString.length);
    writeFileSync(path, updated);
    return { ok: true, message: `edited ${path}`, replacements: replaceAll ? exact.length : 1, tier: "exact" };
  }

  if (replaceAll) {
    return { ok: false, message: `old_string not found in ${path}`, replacements: 0 };
  }

  // Tiers 2 & 3 — line-window matching, must be unique.
  for (const [tier, normalize] of [
    ["trailing-insensitive", (l: string) => l.replace(/\s+$/, "")],
    ["dedented", (l: string) => l.replace(/\s+$/, "")],
  ] as const) {
    const dedent = tier === "dedented";
    const spans = windowMatches(content, oldString, normalize, dedent);
    if (spans.length === 1) {
      const [start, end] = spans[0]!;
      writeFileSync(path, content.slice(0, start) + newString + content.slice(end));
      return { ok: true, message: `edited ${path} (${tier} match)`, replacements: 1, tier };
    }
    if (spans.length > 1) {
      return {
        ok: false,
        message: `old_string matches ${spans.length} places under ${tier} matching — add surrounding context`,
        replacements: 0,
      };
    }
  }

  return { ok: false, message: `old_string not found in ${path} (tried exact and whitespace-insensitive matching)`, replacements: 0 };
}

function allIndexesOf(haystack: string, needle: string): number[] {
  if (needle === "") return [];
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

/** Char spans in `content` whose line-window matches `needle` after normalization. */
function windowMatches(
  content: string,
  needle: string,
  normalize: (line: string) => string,
  dedent: boolean,
): Array<[start: number, end: number]> {
  const fileLines = content.split("\n");
  const needleLines = needle.split("\n");
  const n = needleLines.length;
  if (n === 0 || n > fileLines.length) return [];

  const want = keyOf(needleLines, normalize, dedent);
  const spans: Array<[number, number]> = [];

  // Precompute char offset of the start of each file line.
  const lineStart: number[] = [0];
  for (let i = 0; i < fileLines.length; i++) lineStart.push(lineStart[i]! + fileLines[i]!.length + 1);

  for (let i = 0; i + n <= fileLines.length; i++) {
    const window = fileLines.slice(i, i + n);
    if (keyOf(window, normalize, dedent) === want) {
      const start = lineStart[i]!;
      const end = start + window.join("\n").length;
      spans.push([start, end]);
    }
  }
  return spans;
}

function keyOf(lines: string[], normalize: (l: string) => string, dedent: boolean): string {
  let ls = lines;
  if (dedent) {
    const indents = ls
      .filter((l) => l.trim() !== "")
      .map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0);
    const common = indents.length ? Math.min(...indents) : 0;
    ls = ls.map((l) => l.slice(common));
  }
  return ls.map(normalize).join("\n");
}

export function editTool(cwd: string) {
  return tool({
    description:
      "Replace a string in a file. `old_string` must match the file exactly, " +
      "including indentation; if an exact match fails, whitespace-insensitive " +
      "matching is tried and must be unique. `new_string` is inserted verbatim. " +
      "Paths may be absolute or relative to the session's working directory.",
    inputSchema: z.object({
      path: z.string().describe("File to edit."),
      old_string: z.string().describe("Text to replace. Include enough context to be unique."),
      new_string: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional().describe("Replace every exact occurrence (default false)."),
    }),
    execute: async ({ path, old_string, new_string, replace_all }) => {
      const abs = path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
      const r = applyEdit(abs, old_string, new_string, replace_all ?? false);
      if (!r.ok) throw new Error(r.message);
      return { ok: true, message: r.message, replacements: r.replacements };
    },
  });
}
