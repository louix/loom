/**
 * The first-party tool suite for aisdk sessions: a persistent-shell Bash, a
 * string-replacement Edit, a ripgrep-backed Grep, and background-task tools. These fill the gap left
 * by not having Claude Code's built-ins; official MCP servers (filesystem,
 * fetch, git) cover the rest — and win name collisions: a configured server
 * offering `grep` (fff) replaces the Grep here, since the session builds MCP
 * tools first and only adds builtins for unclaimed names. `[search]` adds
 * `web_search` when a backend is configured, and `web_fetch` (page → markdown)
 * alongside it on the kagi backend. All of them go through the same permission
 * gate as every other tool.
 */
import type { ToolSet } from "ai";
import type { SearchConfig } from "@loom/core/connector";
import { BackgroundTasks, backgroundTools } from "./background.ts";
import { BashShell, bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { grepTool } from "./grep.ts";
import { fetchTool } from "./kagi.ts";
import { searchTool } from "./search.ts";

export class BuiltinTools {
  readonly #shell: BashShell;
  readonly #background: BackgroundTasks;
  readonly tools: ToolSet;

  constructor(cwd: string, search?: SearchConfig) {
    this.#shell = new BashShell(cwd);
    this.#background = new BackgroundTasks(cwd);
    this.tools = {
      bash: bashTool(this.#shell),
      edit: editTool(cwd),
      grep: grepTool(cwd),
      ...backgroundTools(this.#background),
      ...(search ? { web_search: searchTool(search) } : {}),
      ...(search?.backend === "kagi" ? { web_fetch: fetchTool(search) } : {}),
    } as ToolSet;
  }

  close(): void {
    this.#shell.close();
    this.#background.close();
  }
}
