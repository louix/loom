/**
 * The first-party tool suite for aisdk sessions: a stateless Bash, a
 * string-replacement Edit, a ripgrep-backed Grep, and background-task tools. These fill the gap left
 * by not having Claude Code's built-ins; official MCP servers (filesystem,
 * fetch, git) cover the rest — and win name collisions: a configured server
 * offering `grep` (fff) replaces the Grep here, since the session builds MCP
 * tools first and only adds builtins for unclaimed names. Web search comes from
 * a search MCP server. All tools go through the same permission gate as every other tool.
 */
import type { ToolSet } from "ai";
import { BackgroundTasks, backgroundTools } from "./background.ts";
import { BashShell, bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { grepTool } from "./grep.ts";

export class BuiltinTools {
  readonly #shell: BashShell;
  readonly background: BackgroundTasks;
  readonly tools: ToolSet;

  constructor(cwd: string) {
    this.#shell = new BashShell(cwd);
    this.background = new BackgroundTasks(cwd);
    this.tools = {
      bash: bashTool(this.#shell),
      edit: editTool(cwd),
      grep: grepTool(cwd),
      ...backgroundTools(this.background),
    } as ToolSet;
  }

  close(): void {
    this.#shell.close();
    this.background.close();
  }

  interrupt(): Promise<void> {
    return this.background.stopAll(true);
  }
}
