/**
 * The first-party tool suite for aisdk sessions: a persistent-shell Bash, a
 * string-replacement Edit, and a ripgrep-backed Grep. These fill the gap left
 * by not having Claude Code's built-ins; official MCP servers (filesystem,
 * fetch, git) cover the rest. All three go through the same permission gate as
 * every other tool.
 */
import type { ToolSet } from "ai";
import { BashShell, bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { grepTool } from "./grep.ts";
import { searchTool, type SearchConfig } from "./search.ts";

export class BuiltinTools {
  readonly #shell: BashShell;
  readonly tools: ToolSet;

  constructor(cwd: string, search?: SearchConfig) {
    this.#shell = new BashShell(cwd);
    this.tools = {
      bash: bashTool(this.#shell),
      edit: editTool(cwd),
      grep: grepTool(cwd),
      ...(search ? { web_search: searchTool(search) } : {}),
    } as ToolSet;
  }

  close(): void {
    this.#shell.close();
  }
}
