/**
 * A Grep tool for aisdk sessions — a thin, deterministic wrapper over ripgrep.
 * `rg` is expected on PATH; if it is missing the tool returns a clear message
 * rather than throwing, so the model can fall back to `bash` + `grep`.
 */
import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

const DEFAULT_MAX = 200;
/** Wall-clock cap — a scan over `/` or a slow network mount otherwise stalls
 *  the whole model turn with no recovery (`bash` / `web_search` both bound theirs). */
const TIMEOUT_MS = 30_000;

export const runRipgrep = (
  opts: {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    maxResults?: number;
    /** Test seam: the ripgrep binary name (default `rg`). */
    bin?: string;
  },
  cwd: string,
): Promise<{ ok: boolean; output: string }> => {
  return new Promise((resolve) => {
    const args = ["--line-number", "--no-heading", "--color=never", "--max-columns", "400"];
    if (opts.ignoreCase) args.push("-i");
    if (opts.glob) args.push("--glob", opts.glob);
    args.push("--", opts.pattern, opts.path && opts.path !== "" ? opts.path : ".");

    const child = spawn(opts.bin ?? "rg", args, { cwd });
    let out = "";
    let err = "";
    let capped = false;
    let timedOut = false;
    const OUT_CAP = 4_000_000; // don't buffer an unbounded match-everything result
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (capped) return;
      out += d;
      if (out.length > OUT_CAP) {
        capped = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (d: string) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        output:
          e.code === "ENOENT"
            ? "ripgrep (rg) is not installed or not on PATH — use `bash` with `grep -rn` instead"
            : `failed to run rg: ${e.message}`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          output: `search timed out after ${TIMEOUT_MS / 1000}s — narrow the pattern or pass \`path\` / \`glob\``,
        });
        return;
      }
      if (code === 0 || capped) {
        const lines = out.split("\n").filter((l) => l !== "");
        const max = opts.maxResults ?? DEFAULT_MAX;
        const shown = lines.slice(0, max);
        const extra = lines.length - shown.length;
        let tail = "";
        if (capped) tail = "\n… output capped — narrow the pattern or pass `path` / `glob`";
        else if (extra > 0) tail = `\n… ${extra} more match(es)`;
        resolve({ ok: true, output: shown.join("\n") + tail });
      } else if (code === 1) {
        resolve({ ok: true, output: "(no matches)" });
      } else {
        resolve({ ok: false, output: err.trim() || `rg exited with code ${code}` });
      }
    });
  });
};

export const grepTool = (cwd: string) => {
  return tool({
    description:
      "Search file contents with ripgrep. Returns `path:line:match` lines. " +
      "`path` and `glob` narrow the search; it runs from the session's working directory.",
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression to search for."),
      path: z
        .string()
        .optional()
        .describe("File or directory to search (default: the whole worktree)."),
      glob: z.string().optional().describe("Only search files matching this glob, e.g. '*.ts'."),
      ignore_case: z.boolean().optional().describe("Case-insensitive search."),
      max_results: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Cap on lines returned (default ${DEFAULT_MAX}).`),
    }),
    execute: async ({ pattern, path, glob, ignore_case, max_results }) => {
      const r = await runRipgrep(
        {
          pattern,
          ...(path ? { path } : {}),
          ...(glob ? { glob } : {}),
          ...(ignore_case ? { ignoreCase: ignore_case } : {}),
          ...(max_results ? { maxResults: max_results } : {}),
        },
        cwd,
      );
      if (!r.ok) throw new Error(r.output);
      return { matches: r.output };
    },
  });
};
