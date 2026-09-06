/**
 * Thin JSONL client for `codex app-server`.
 *
 * The app server deliberately owns the Code Mode host; Loom owns the process,
 * its per-session MCP configuration, and the human approval surface. The wire
 * protocol itself (deadlines, diagnostics, cleanup) lives in `./rpc.ts`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AsyncChannel } from "@loom/core/channel";
import type { HarnessEvent, TokenUsage } from "@loom/core/events";
import type { SearchConfig } from "@loom/core/connector";
import { stateIdle, stateRunning } from "@loom/core/session-state";
import { commitInWorktree } from "@loom/core/commit";
import { statusInWorktree } from "@loom/core/status";
import { COMMIT_DESC, STATUS_DESC } from "@loom/runtime/loom-tools";
import type {
  AdapterSnapshot,
  AgentSession,
  CreateSessionOptions,
  EffortLevel,
  McpServerHandle,
  PermissionDecision,
  PlanDecision,
  SessionMode,
  SessionRef,
} from "@loom/core/types";
import { CodexRpcClient } from "./rpc.ts";
import { verifyChatGptAccount } from "./account.ts";
import type { CodexHome } from "./codex-home.ts";

const zeroUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const now = (): number => Date.now();

const KAGI_TOKEN_ENV = "LOOM_CODEX_KAGI_API_KEY";

/** Serialize Loom's MCP mounts as a TOML inline table for `codex -c`. */
export const mcpConfig = (servers: McpServerHandle[], search?: SearchConfig): string => {
  const value = (v: string): string => JSON.stringify(v); // JSON strings are TOML basic strings.
  const table = (entries: Record<string, string>): string =>
    `{ ${Object.entries(entries)
      .map(([key, val]) => `${value(key)} = ${value(val)}`)
      .join(", ")} }`;
  const entries = new Map(
    servers.map((s) => {
      if (s.spec.transport === "stdio") {
        const spec = s.spec as Extract<McpServerHandle["spec"], { transport: "stdio" }>;
        const fields = [
          `command = ${value(spec.command)}`,
          ...(spec.args?.length ? [`args = [${spec.args.map(value).join(", ")}]`] : []),
          ...(spec.env ? [`env = ${table(spec.env)}`] : []),
        ];
        return [s.name, `{ ${fields.join(", ")} }`] as const;
      }
      const spec = s.spec as Extract<McpServerHandle["spec"], { transport: "http" }>;
      const fields = [
        `url = ${value(spec.url)}`,
        ...(spec.headers ? [`http_headers = ${table(spec.headers)}`] : []),
      ];
      return [s.name, `{ ${fields.join(", ")} }`] as const;
    }),
  );
  if (search?.backend === "kagi") {
    const base = (search.apiBase || "https://mcp.kagi.com").replace(/\/$/, "");
    entries.set(
      "kagi",
      `{ url = ${value(`${base}/mcp`)}, bearer_token_env_var = ${value(KAGI_TOKEN_ENV)} }`,
    );
  }
  return `{ ${[...entries.entries()].map(([name, config]) => `${value(name)} = ${config}`).join(", ")} }`;
};

/** Every spawn always gets an explicit, full environment — the current process
 *  env plus `CODEX_HOME` (so it reads the exact directory Loom resolved) and,
 *  when configured, Kagi's bearer token. Never partial: a merge starting from
 *  `undefined` would silently drop inherited `PATH` et al. */
const launchOptions = (
  servers: McpServerHandle[],
  search: SearchConfig | undefined,
  builtinWebSearch: boolean,
  codexHome: CodexHome,
): { args: string[]; env: NodeJS.ProcessEnv } => ({
  args: [
    "app-server",
    "-c",
    // Pin file-based credential storage so this process reads the same
    // auth.json the REST catalog does, regardless of what a keyring/auto
    // `cli_auth_credentials_store` setting in the user's own config.toml
    // would otherwise select — the two credential paths must agree.
    'cli_auth_credentials_store="file"',
    "-c",
    `mcp_servers=${mcpConfig(servers, search)}`,
    // Loom's Kagi server is the configured search source for Code Mode too.
    ...(builtinWebSearch ? [] : ["-c", 'web_search = "disabled"']),
  ],
  env: {
    ...Deno.env.toObject(),
    CODEX_HOME: codexHome.dir,
    ...(search?.backend === "kagi" ? { [KAGI_TOKEN_ENV]: search.apiKey } : {}),
  },
});

/**
 * Loom's own tools (`commit`, `status`), mounted as Codex dynamic tools
 * (`thread/start`/`thread/resume`'s `dynamicTools`) rather than a separate
 * stdio MCP server — Codex calls them directly via a server-initiated
 * `item/tool/call` request (`#toolCall` below). `ask_user` isn't mounted yet:
 * `answerQuestion` below still throws "not yet supported" (Phase 5).
 */
const loomDynamicTools = (): Record<string, unknown>[] => [
  {
    type: "function",
    name: "commit",
    description: COMMIT_DESC,
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Commit message. First line is the subject; keep it under ~72 chars.",
        },
        stage_all: {
          type: "boolean",
          description:
            "Stage all changes first (git add -A). Default true; set false to commit only what is already staged.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "status",
    description: STATUS_DESC,
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "boolean",
          description:
            "Include the working diff against HEAD (clamped; untracked files are not included).",
        },
      },
      additionalProperties: false,
    },
  },
];

const policyFor = (mode: SessionMode): "untrusted" | "on-request" =>
  mode === "default" || mode === "plan" ? "untrusted" : "on-request";

const sandboxFor = (mode: SessionMode): "read-only" | "workspace-write" =>
  mode === "plan" ? "read-only" : "workspace-write";

export const approvalsReviewerFor = (mode: SessionMode): "user" | "auto_review" =>
  mode === "auto" ? "auto_review" : "user";

export class CodexAppServerSession implements AgentSession {
  readonly id: string;
  readonly #rpc: CodexRpcClient;
  #events = new AsyncChannel<HarnessEvent>();
  #permissions = new Map<string, { rpcId: number | string; kind: "command" | "file" | "legacy" }>();
  #threadId: string | null = null;
  #turnId: string | null = null;
  #model: string;
  #effort: EffortLevel | null;
  #mode: SessionMode;
  #cwd: string;
  readonly #base: string | undefined;
  #closing = false;
  #status = stateRunning;
  #usage = zeroUsage();
  #contextUsed = 0;
  #contextLimit = 0;
  #turns = 0;

  private constructor(
    opts: CreateSessionOptions,
    proc: ChildProcessWithoutNullStreams,
    base: string | undefined,
  ) {
    this.id = opts.sessionId;
    this.#model = opts.model ?? "";
    this.#effort = opts.effort ?? null;
    this.#mode = opts.mode;
    this.#cwd = opts.cwd;
    this.#base = base;
    this.#rpc = new CodexRpcClient(proc);
    this.#rpc.onServerRequest((method, params, id) => this.#serverRequest(method, params, id));
    this.#rpc.onNotification((method, params) => this.#notification(method, params));
    this.#rpc.onClose((err) => {
      if (!this.#closing)
        this.#events.push({
          type: "error",
          sessionId: this.id,
          ts: now(),
          message: err.message,
          fatal: true,
        });
      this.#events.close();
    });
  }

  static async start(
    opts: CreateSessionOptions,
    codexHome: CodexHome,
    cliPath = "codex",
    search?: SearchConfig,
    builtinWebSearch = false,
    base?: string,
  ): Promise<CodexAppServerSession> {
    // Replacing the complete table prevents ~/.codex/config.toml MCP entries
    // from leaking into a Loom-controlled session.
    const launch = launchOptions(opts.mcpServers, search, builtinWebSearch, codexHome);
    const proc = spawn(cliPath, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: launch.env,
    });
    const s = new CodexAppServerSession(opts, proc, base);
    try {
      await s.#initialize();
      const started = await s.#rpc.requestStartup("thread/start", {
        ...(opts.model ? { model: opts.model } : {}),
        cwd: opts.cwd,
        approvalPolicy: policyFor(opts.mode),
        approvalsReviewer: approvalsReviewerFor(opts.mode),
        sandbox: sandboxFor(opts.mode),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.systemPromptAppend ? { developerInstructions: opts.systemPromptAppend } : {}),
        ...(opts.loomServer ? { dynamicTools: loomDynamicTools() } : {}),
      });
      s.#threadId = (started as any)?.thread?.id ?? null;
      if (!s.#threadId) throw new Error("codex app-server did not return a thread id");
      if (opts.prompt) await s.#startTurn(opts.prompt);
      else s.#idle();
      return s;
    } catch (err) {
      // Startup failed after the process was already spawned — close it (which
      // kills the process) rather than leaving an orphaned `codex app-server`
      // with a pending request no caller can ever reach.
      s.close();
      throw err;
    }
  }

  static async resume(
    ref: SessionRef,
    codexHome: CodexHome,
    cliPath = "codex",
    search?: SearchConfig,
    builtinWebSearch = false,
    base?: string,
  ): Promise<CodexAppServerSession> {
    if (!ref.providerRef) throw new Error("Codex session has no app-server thread id to resume");
    const opts: CreateSessionOptions = {
      sessionId: ref.sessionId,
      cwd: ref.cwd,
      prompt: "",
      mode: ref.mode ?? "default",
      mcpServers: ref.mcpServers ?? [],
      loomServer: true,
      ...(ref.model ? { model: ref.model } : {}),
      ...(ref.effort ? { effort: ref.effort } : {}),
    };
    const launch = launchOptions(opts.mcpServers, search, builtinWebSearch, codexHome);
    const proc = spawn(cliPath, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: launch.env,
    });
    const s = new CodexAppServerSession(opts, proc, base);
    try {
      await s.#initialize();
      const resumed = await s.#rpc.requestStartup("thread/resume", {
        threadId: ref.providerRef,
        cwd: ref.cwd,
        approvalPolicy: policyFor(opts.mode),
        approvalsReviewer: approvalsReviewerFor(opts.mode),
        sandbox: sandboxFor(opts.mode),
        excludeTurns: true,
        ...(ref.systemPromptAppend ? { developerInstructions: ref.systemPromptAppend } : {}),
        // Codex persists dynamic tools in thread rollout metadata and restores
        // them when the caller sends none — but Loom always resends its own
        // set here, the same reason it always resends `developerInstructions`:
        // a stale steer/tool set surviving a daemon restart would be a bug.
        ...(opts.loomServer ? { dynamicTools: loomDynamicTools() } : {}),
      });
      s.#threadId = (resumed as any)?.thread?.id ?? ref.providerRef;
      s.#idle();
      return s;
    } catch (err) {
      s.close();
      throw err;
    }
  }

  async #initialize(): Promise<void> {
    await this.#rpc.requestStartup("initialize", {
      clientInfo: { name: "loom", title: "Loom", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    this.#rpc.notify("initialized", {});
    await verifyChatGptAccount(this.#rpc);
  }

  get providerRef(): string | null {
    return this.#threadId;
  }
  events(): AsyncIterable<HarnessEvent> {
    return this.#events;
  }

  async send(input: string): Promise<void> {
    if (!this.#threadId) throw new Error("Codex thread has not started");
    if (this.#turnId) {
      await this.#rpc.request("turn/steer", {
        threadId: this.#threadId,
        expectedTurnId: this.#turnId,
        input: [textInput(input)],
      });
      return;
    }
    await this.#startTurn(input);
  }

  async compact(instructions?: string): Promise<void> {
    if (!this.#threadId) throw new Error("Codex thread has not started");
    // `thread/compact/start` accepts no instruction payload — reject rather
    // than silently run plain compaction and drop what the caller asked for
    // (capabilities.compactionInstructions is false; the daemon should already
    // have rejected this, this is the adapter's own defensive check).
    if (instructions?.trim()) {
      throw new Error("Codex Code Mode compaction does not support custom instructions");
    }
    await this.#rpc.request("thread/compact/start", { threadId: this.#threadId });
  }

  async respondToPermission(id: string, decision: PermissionDecision): Promise<void> {
    const pending = this.#permissions.get(id);
    if (!pending) return;
    this.#permissions.delete(id);
    const allow = decision.behavior === "allow";
    const result =
      pending.kind === "command" || pending.kind === "file"
        ? { decision: allow ? "accept" : "decline" }
        : { decision: allow ? "approved" : "denied" };
    this.#rpc.respond(pending.rpcId, result);
  }
  async answerQuestion(_id: string, _text: string): Promise<void> {
    throw new Error("Codex user-input tools are not yet supported by Loom");
  }
  async respondToPlan(_id: string, _decision: PlanDecision): Promise<void> {
    throw new Error("Codex plan review is not yet supported by Loom");
  }

  async interrupt(): Promise<void> {
    if (this.#threadId && this.#turnId)
      await this.#rpc.request("turn/interrupt", { threadId: this.#threadId, turnId: this.#turnId });
    this.#turnId = null;
    this.#idle();
  }
  async rewind(): Promise<void> {
    throw new Error("Codex app-server rewind is not yet supported by Loom");
  }
  async setMode(mode: SessionMode): Promise<void> {
    if (!this.#threadId) throw new Error("Codex thread has not started");
    await this.#rpc.request("thread/settings/update", {
      threadId: this.#threadId,
      approvalPolicy: policyFor(mode),
      approvalsReviewer: approvalsReviewerFor(mode),
      sandboxPolicy: this.#sandboxPolicyFor(mode),
    });
    if (this.#turnId) {
      await this.#rpc.request("turn/settings/update", {
        threadId: this.#threadId,
        turnId: this.#turnId,
        approvalsReviewer: approvalsReviewerFor(mode),
      });
    }
    this.#mode = mode;
  }
  async setModel(model: string): Promise<void> {
    this.#model = model;
  }
  async setEffort(effort: EffortLevel): Promise<void> {
    this.#effort = effort;
  }
  snapshot(): AdapterSnapshot {
    return {
      status: this.#status,
      providerRef: this.#threadId,
      model: this.#model || null,
      effort: this.#effort,
      mode: this.#mode,
      usage: this.#usage,
      contextUsed: this.#contextUsed,
      contextLimit: this.#contextLimit,
      costUsd: 0,
      turns: this.#turns,
    };
  }
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#rpc.close();
    this.#events.close();
  }

  async #startTurn(input: string): Promise<void> {
    const result = await this.#rpc.request("turn/start", {
      threadId: this.#threadId,
      input: [textInput(input)],
      model: this.#model || undefined,
      effort: this.#effort ?? undefined,
      approvalPolicy: policyFor(this.#mode),
      approvalsReviewer: approvalsReviewerFor(this.#mode),
      sandboxPolicy: this.#sandboxPolicy(),
    });
    this.#turnId = (result as any)?.turn?.id ?? this.#turnId;
    this.#status = stateRunning;
    this.#events.push({
      type: "status_changed",
      sessionId: this.id,
      ts: now(),
      status: this.#status,
    });
  }
  #idle(): void {
    this.#status = stateIdle;
    this.#events.push({
      type: "status_changed",
      sessionId: this.id,
      ts: now(),
      status: this.#status,
    });
  }
  #sandboxPolicy(): Record<string, unknown> {
    return this.#sandboxPolicyFor(this.#mode);
  }
  #sandboxPolicyFor(mode: SessionMode): Record<string, unknown> {
    if (mode === "plan") return { type: "readOnly", networkAccess: false };
    return {
      type: "workspaceWrite",
      writableRoots: [this.#cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  #serverRequest(method: string, p: Record<string, unknown>, id: number | string): void {
    if (method === "item/tool/call") {
      this.#toolCall(p, id);
      return;
    }
    const pid = String(p["approvalId"] ?? p["itemId"] ?? p["callId"] ?? id);
    if (method === "item/commandExecution/requestApproval") {
      this.#permissions.set(pid, { rpcId: id, kind: "command" });
      this.#events.push({
        type: "permission_request",
        sessionId: this.id,
        ts: now(),
        id: pid,
        tool: "Bash",
        input: { command: p["command"], cwd: p["cwd"], reason: p["reason"] },
      });
    } else if (method === "item/fileChange/requestApproval") {
      this.#permissions.set(pid, { rpcId: id, kind: "file" });
      this.#events.push({
        type: "permission_request",
        sessionId: this.id,
        ts: now(),
        id: pid,
        tool: "apply_patch",
        input: { reason: p["reason"] },
      });
    } else if (method === "execCommandApproval" || method === "applyPatchApproval") {
      this.#permissions.set(pid, { rpcId: id, kind: "legacy" });
      this.#events.push({
        type: "permission_request",
        sessionId: this.id,
        ts: now(),
        id: pid,
        tool: method === "execCommandApproval" ? "Bash" : "apply_patch",
        input: p,
      });
    } else {
      this.#rpc.respondError(id, `unsupported request: ${method}`);
    }
  }
  /** `item/tool/call` — Codex invoking one of Loom's own dynamic tools
   *  (`commit`/`status`, see `loomDynamicTools`). Reply on the envelope `id`,
   *  not `params.callId` — they're different fields in the protocol. Both
   *  tools are synchronous (`spawnSync`-backed), so this needs no async work
   *  and no pending-interaction bookkeeping. */
  #toolCall(p: Record<string, unknown>, id: number | string): void {
    const tool = String(p["tool"] ?? "");
    const args = (p["arguments"] as Record<string, unknown> | null) ?? {};
    const respond = (text: string, success: boolean): void => {
      this.#rpc.respond(id, { contentItems: [{ type: "inputText", text }], success });
    };
    if (tool === "commit") {
      const message = typeof args["message"] === "string" ? args["message"] : "";
      const res = commitInWorktree(this.#cwd, message, { stageAll: args["stage_all"] !== false });
      respond(res.text, res.ok);
      return;
    }
    if (tool === "status") {
      const res = statusInWorktree(this.#cwd, {
        ...(this.#base ? { base: this.#base } : {}),
        ...(args["patch"] === true ? { patch: true } : {}),
      });
      respond(res.text, res.ok);
      return;
    }
    respond(`unsupported loom tool: ${tool}`, false);
  }
  #notification(method: string, p: Record<string, unknown>): void {
    if (method === "thread/tokenUsage/updated") {
      const usage = p["tokenUsage"] as Record<string, unknown> | undefined;
      const limit = usage?.["modelContextWindow"];
      if (typeof limit === "number") this.#contextLimit = limit;
      const total = usage?.["total"] as Record<string, unknown> | undefined;
      if (typeof total?.["totalTokens"] === "number") this.#contextUsed = total.totalTokens;
      return;
    }
    const item = p["item"] as Record<string, unknown> | undefined;
    if (method === "item/completed" && item) this.#item(item);
    if (method === "item/agentMessage/delta") return; // final item is authoritative and avoids duplicate transcript text.
    if (method === "turn/started") this.#turnId = (p["turn"] as any)?.id ?? this.#turnId;
    if (method === "turn/completed") {
      const turn = p["turn"] as any;
      this.#turnId = null;
      this.#turns++;
      if (turn?.status === "failed")
        this.#events.push({
          type: "error",
          sessionId: this.id,
          ts: now(),
          message: turn?.error?.message ?? "Codex turn failed",
          fatal: true,
        });
      else this.#events.push({ type: "result", sessionId: this.id, ts: now(), kind: "ok" });
      this.#idle();
    }
  }
  #item(item: Record<string, unknown>): void {
    const id = String(item["id"] ?? "");
    const type = item["type"];
    const ts = now();
    if (type === "agentMessage" && typeof item["text"] === "string")
      this.#events.push({ type: "assistant_text", sessionId: this.id, ts, text: item["text"] });
    else if (type === "reasoning")
      this.#events.push({
        type: "thinking",
        sessionId: this.id,
        ts,
        text: [
          ...((item["summary"] as string[] | undefined) ?? []),
          ...((item["content"] as string[] | undefined) ?? []),
        ].join("\n"),
      });
    else if (type === "commandExecution") {
      this.#events.push({
        type: "tool_call",
        sessionId: this.id,
        ts,
        id,
        name: "Bash",
        input: { command: item["command"], cwd: item["cwd"] },
      });
      this.#events.push({
        type: "tool_result",
        sessionId: this.id,
        ts,
        id,
        ok: item["status"] === "completed",
        output: item["aggregatedOutput"] ?? "",
      });
    } else if (type === "fileChange")
      this.#events.push({
        type: "tool_call",
        sessionId: this.id,
        ts,
        id,
        name: "apply_patch",
        input: { changes: item["changes"] },
      });
    else if (type === "mcpToolCall") {
      this.#events.push({
        type: "tool_call",
        sessionId: this.id,
        ts,
        id,
        name: `mcp__${item["server"]}__${item["tool"]}`,
        input: item["arguments"],
      });
      this.#events.push({
        type: "tool_result",
        sessionId: this.id,
        ts,
        id,
        ok: item["status"] === "completed",
        output: item["result"] ?? item["error"] ?? "",
      });
    } else if (type === "dynamicToolCall") {
      const contentItems = (item["contentItems"] as Array<Record<string, unknown>> | null) ?? [];
      const output = contentItems
        .map((c) => (c["type"] === "inputText" ? String(c["text"] ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      this.#events.push({
        type: "tool_call",
        sessionId: this.id,
        ts,
        id,
        name: String(item["tool"] ?? ""),
        input: item["arguments"],
      });
      this.#events.push({
        type: "tool_result",
        sessionId: this.id,
        ts,
        id,
        ok: item["success"] === true,
        output,
      });
    } else if (type === "subAgentActivity") {
      const subagentId = String(item["agentThreadId"] ?? id);
      if (item["kind"] === "started") {
        this.#events.push({
          type: "subagent_started",
          sessionId: this.id,
          ts,
          subagentId,
          name: String(item["agentPath"] ?? subagentId),
        });
      } else {
        this.#events.push({ type: "subagent_stopped", sessionId: this.id, ts, subagentId });
      }
    } else if (type === "contextCompaction")
      this.#events.push({
        type: "compact",
        sessionId: this.id,
        ts,
        trigger: "auto",
        before: this.#contextUsed,
        after: 0,
      });
  }
}

const textInput = (text: string): Record<string, unknown> => ({
  type: "text",
  text,
  text_elements: [],
});
