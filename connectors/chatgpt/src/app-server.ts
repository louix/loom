/**
 * Thin JSONL client for `codex app-server`.
 *
 * The app server deliberately owns the Code Mode host; Loom owns the process,
 * its per-session MCP configuration, and the human approval surface.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { AsyncChannel } from "@loom/core/channel";
import type { HarnessEvent, TokenUsage } from "@loom/core/events";
import type { SearchConfig } from "@loom/core/connector";
import { stateIdle, stateRunning } from "@loom/core/session-state";
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

type Rpc = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};

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

const launchOptions = (
  servers: McpServerHandle[],
  search: SearchConfig | undefined,
  builtinWebSearch: boolean,
): { args: string[]; env?: NodeJS.ProcessEnv } => ({
  args: [
    "app-server",
    "-c",
    `mcp_servers=${mcpConfig(servers, search)}`,
    // Loom's Kagi server is the configured search source for Code Mode too.
    ...(builtinWebSearch ? [] : ["-c", 'web_search = "disabled"']),
  ],
  ...(search?.backend === "kagi"
    ? { env: { ...Deno.env.toObject(), [KAGI_TOKEN_ENV]: search.apiKey } }
    : {}),
});

const loomMcpServer = (cwd: string): McpServerHandle => ({
  name: "loom",
  spec: {
    transport: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./loom-mcp-server.mjs", import.meta.url))],
    env: { LOOM_WORKTREE: cwd },
  },
});

const policyFor = (mode: SessionMode): "untrusted" | "on-request" =>
  mode === "default" || mode === "plan" ? "untrusted" : "on-request";

const sandboxFor = (mode: SessionMode): "read-only" | "workspace-write" =>
  mode === "plan" ? "read-only" : "workspace-write";

export const approvalsReviewerFor = (mode: SessionMode): "user" | "auto_review" =>
  mode === "auto" ? "auto_review" : "user";

export class CodexAppServerSession implements AgentSession {
  readonly id: string;
  #proc: ChildProcessWithoutNullStreams;
  #events = new AsyncChannel<HarnessEvent>();
  #requests = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
  #permissions = new Map<string, { rpcId: number | string; kind: "command" | "file" | "legacy" }>();
  #next = 1;
  #threadId: string | null = null;
  #turnId: string | null = null;
  #model: string;
  #effort: EffortLevel | null;
  #mode: SessionMode;
  #cwd: string;
  #closing = false;
  #status = stateRunning;
  #usage = zeroUsage();
  #contextUsed = 0;
  #contextLimit = 0;
  #turns = 0;
  #stderr = "";

  private constructor(opts: CreateSessionOptions, proc: ChildProcessWithoutNullStreams) {
    this.id = opts.sessionId;
    this.#proc = proc;
    this.#model = opts.model ?? "";
    this.#effort = opts.effort ?? null;
    this.#mode = opts.mode;
    this.#cwd = opts.cwd;
    createInterface({ input: proc.stdout }).on("line", (line) => this.#onLine(line));
    proc.once("exit", (code, signal) => {
      if (!this.#closing)
        this.#events.push({
          type: "error",
          sessionId: this.id,
          ts: now(),
          message: `codex app-server exited (${signal ?? code ?? "unknown"}): ${this.#stderr.slice(-500)}`,
          fatal: true,
        });
      this.#events.close();
      for (const { reject } of this.#requests.values())
        reject(new Error(`codex app-server exited: ${this.#stderr.slice(-500)}`));
      this.#requests.clear();
    });
    proc.once("error", (err) => {
      this.#stderr += err.message;
      for (const { reject } of this.#requests.values()) reject(err);
      this.#requests.clear();
      this.#events.push({
        type: "error",
        sessionId: this.id,
        ts: now(),
        message: `could not start codex app-server: ${err.message}`,
        fatal: true,
      });
      this.#events.close();
    });
    proc.stderr.on("data", (data: Buffer) => {
      this.#stderr += data.toString();
    });
  }

  static async start(
    opts: CreateSessionOptions,
    cliPath = "codex",
    search?: SearchConfig,
    builtinWebSearch = true,
  ): Promise<CodexAppServerSession> {
    // Replacing the complete table prevents ~/.codex/config.toml MCP entries
    // from leaking into a Loom-controlled session.
    const launch = launchOptions(
      opts.loomServer ? [...opts.mcpServers, loomMcpServer(opts.cwd)] : opts.mcpServers,
      search,
      builtinWebSearch,
    );
    const proc = spawn(cliPath, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: launch.env,
    });
    const s = new CodexAppServerSession(opts, proc);
    await s.#initialize();
    const started = await s.#request("thread/start", {
      ...(opts.model ? { model: opts.model } : {}),
      cwd: opts.cwd,
      approvalPolicy: policyFor(opts.mode),
      approvalsReviewer: approvalsReviewerFor(opts.mode),
      sandbox: sandboxFor(opts.mode),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.systemPromptAppend ? { developerInstructions: opts.systemPromptAppend } : {}),
    });
    s.#threadId = (started as any)?.thread?.id ?? null;
    if (!s.#threadId) throw new Error("codex app-server did not return a thread id");
    if (opts.prompt) await s.#startTurn(opts.prompt);
    else s.#idle();
    return s;
  }

  static async resume(
    ref: SessionRef,
    cliPath = "codex",
    search?: SearchConfig,
    builtinWebSearch = true,
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
    const launch = launchOptions(
      opts.loomServer ? [...opts.mcpServers, loomMcpServer(opts.cwd)] : opts.mcpServers,
      search,
      builtinWebSearch,
    );
    const proc = spawn(cliPath, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: launch.env,
    });
    const s = new CodexAppServerSession(opts, proc);
    await s.#initialize();
    const resumed = await s.#request("thread/resume", {
      threadId: ref.providerRef,
      cwd: ref.cwd,
      approvalPolicy: policyFor(opts.mode),
      approvalsReviewer: approvalsReviewerFor(opts.mode),
      sandbox: sandboxFor(opts.mode),
      excludeTurns: true,
    });
    s.#threadId = (resumed as any)?.thread?.id ?? ref.providerRef;
    s.#idle();
    return s;
  }

  async #initialize(): Promise<void> {
    await this.#request("initialize", {
      clientInfo: { name: "loom", title: "Loom", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    this.#notify("initialized", {});
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
      await this.#request("turn/steer", {
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
    // app-server's compact endpoint currently accepts no instruction payload.
    // Preserve the interface argument for parity with other adapters.
    void instructions;
    await this.#request("thread/compact/start", { threadId: this.#threadId });
  }

  async respondToPermission(id: string, decision: PermissionDecision): Promise<void> {
    const pending = this.#permissions.get(id);
    if (!pending) return;
    this.#permissions.delete(id);
    const allow = decision.behavior === "allow";
    const result =
      pending.kind === "command"
        ? { decision: allow ? "accept" : "decline" }
        : pending.kind === "file"
          ? { decision: allow ? "accept" : "decline" }
          : { decision: allow ? "approved" : "denied" };
    this.#write({ id: pending.rpcId, result });
  }
  async answerQuestion(_id: string, _text: string): Promise<void> {
    throw new Error("Codex user-input tools are not yet supported by Loom");
  }
  async respondToPlan(_id: string, _decision: PlanDecision): Promise<void> {
    throw new Error("Codex plan review is not yet supported by Loom");
  }

  async interrupt(): Promise<void> {
    if (this.#threadId && this.#turnId)
      await this.#request("turn/interrupt", { threadId: this.#threadId, turnId: this.#turnId });
    this.#turnId = null;
    this.#idle();
  }
  async rewind(): Promise<void> {
    throw new Error("Codex app-server rewind is not yet supported by Loom");
  }
  async setMode(mode: SessionMode): Promise<void> {
    if (!this.#threadId) throw new Error("Codex thread has not started");
    await this.#request("thread/settings/update", {
      threadId: this.#threadId,
      approvalPolicy: policyFor(mode),
      approvalsReviewer: approvalsReviewerFor(mode),
      sandboxPolicy: this.#sandboxPolicyFor(mode),
    });
    if (this.#turnId) {
      await this.#request("turn/settings/update", {
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
    this.#proc.kill();
    this.#events.close();
  }

  async #startTurn(input: string): Promise<void> {
    const result = await this.#request("turn/start", {
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
  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#next++;
    // Register before writing: a local test host (and occasionally a warmed
    // app-server) can answer in the same event-loop turn as stdin accepts it.
    const reply = new Promise<unknown>((resolve, reject) =>
      this.#requests.set(id, { resolve, reject }),
    );
    this.#write({ method, id, params });
    return reply;
  }
  #notify(method: string, params: Record<string, unknown>): void {
    this.#write({ method, params });
  }
  #write(value: unknown): void {
    this.#proc.stdin.write(`${JSON.stringify(value)}\n`);
  }
  #onLine(line: string): void {
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const request = this.#requests.get(Number(msg.id));
      if (!request) return;
      this.#requests.delete(Number(msg.id));
      if (msg.error)
        request.reject(new Error(msg.error.message ?? "Codex app-server request failed"));
      else request.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    if (msg.id !== undefined) {
      this.#serverRequest(msg);
      return;
    }
    this.#notification(msg.method, msg.params ?? {});
  }
  #serverRequest(msg: Rpc): void {
    const p = msg.params ?? {};
    const id = String(p["approvalId"] ?? p["itemId"] ?? p["callId"] ?? msg.id);
    if (msg.method === "item/commandExecution/requestApproval") {
      this.#permissions.set(id, { rpcId: msg.id!, kind: "command" });
      this.#events.push({
        type: "permission_request",
        sessionId: this.id,
        ts: now(),
        id,
        tool: "Bash",
        input: { command: p["command"], cwd: p["cwd"], reason: p["reason"] },
      });
    } else if (msg.method === "item/fileChange/requestApproval") {
      this.#permissions.set(id, { rpcId: msg.id!, kind: "file" });
      this.#events.push({
        type: "permission_request",
        sessionId: this.id,
        ts: now(),
        id,
        tool: "apply_patch",
        input: { reason: p["reason"] },
      });
    } else if (msg.method === "execCommandApproval" || msg.method === "applyPatchApproval") {
      this.#permissions.set(id, { rpcId: msg.id!, kind: "legacy" });
      this.#events.push({
        type: "permission_request",
        sessionId: this.id,
        ts: now(),
        id,
        tool: msg.method === "execCommandApproval" ? "Bash" : "apply_patch",
        input: p,
      });
    } else {
      this.#write({ id: msg.id, result: {} });
    }
  }
  #notification(method: string, p: Record<string, unknown>): void {
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
