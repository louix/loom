/** Private connector protocol. Never route these messages through daemon admin RPC. */
import type { HarnessEvent } from "./events.ts";
import { MCP_CAPABILITIES } from "./types.ts";
import type { ConnectorConfig } from "./connector.ts";
import type {
  AdapterSnapshot,
  AgentSession,
  CreateSessionOptions,
  ProviderCapabilities,
  SessionRef,
  DiscoveredModel,
} from "./types.ts";

export const WORKER_VERSION = 2;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_PENDING = 128;

const diagnostics = {
  claudeCliPath:
    "providers.claude.cli_path is not an executable file. Set it to an installed Claude executable and restart the daemon.",
  claudeBundledCli:
    "Claude could not start. No claude executable was found on the daemon's PATH, and the SDK's bundled binary failed to launch. Install Claude or set providers.claude.cli_path, then restart the daemon.",
  claudeDiscovery:
    "Claude model discovery failed. Check that Claude can start and is authenticated; set providers.claude.cli_path if needed, then restart the daemon.",
} as const;

/** Only fixed, credential-free diagnostics may cross the worker boundary. */
export class WorkerDiagnostic extends Error {
  constructor(code: keyof typeof diagnostics) {
    super(diagnostics[code]);
  }
}

export interface WorkerBinding {
  generation: string;
  providerId: string;
  sessionId: string;
  connector: "@loom/connector-mock" | "@loom/connector-claude";
  config: ConnectorConfig;
  role: WorkerRole;
  baseBranch?: string;
}

export type WorkerRole = "session" | "title" | "discovery" | "enumeration" | "capabilities";
export type WorkerProfile = Pick<WorkerBinding, "connector" | "config" | "baseBranch">;

type SessionMethod = Exclude<keyof AgentSession, "id" | "providerRef" | "events" | "snapshot">;
type SessionCommand = {
  [K in SessionMethod]: { method: K; args: Parameters<AgentSession[K]> };
}[SessionMethod];
export type WorkerCommand =
  | { method: "initialize"; args: [WorkerBinding] }
  | { method: "create"; args: [CreateSessionOptions] }
  | { method: "resume"; args: [SessionRef] }
  | { method: "listModels"; args: [] }
  | { method: "listPersistedSessions"; args: [] }
  | SessionCommand;
export type WorkerRequest = { kind: "request"; id: number } & WorkerCommand;
export type WorkerFrame =
  | { kind: "hello"; version: number }
  | { kind: "ready"; id: number; generation: string; capabilities: ProviderCapabilities }
  | { kind: "response"; id: number; error?: { code: "operation_failed"; message: string } }
  | { kind: "state"; snapshot: AdapterSnapshot }
  | { kind: "event"; seq: number; event: HarnessEvent }
  | { kind: "models"; id: number; models: DiscoveredModel[] }
  | { kind: "sessions"; id: number; sessions: SessionRef[] }
  | { kind: "end" };

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const mode = (v: unknown) => ["default", "plan", "acceptEdits", "auto"].includes(String(v));
const id = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const strings = (v: unknown) => Array.isArray(v) && v.every(str);
const tokens = (v: unknown) =>
  record(v) && ["input", "output", "cacheRead", "cacheWrite"].every((k) => finite(v[k]));
const nullableString = (v: unknown) => v === null || str(v);
const state = (v: unknown): boolean => {
  if (!record(v)) return false;
  switch (v.kind) {
    case "starting":
    case "running":
    case "idle":
    case "working_background":
    case "done":
      return true;
    case "error":
      return str(v.message);
    case "interrupted":
      return v.by === "user" || v.by === "stream_ended";
    case "awaiting_input":
      return ["permission", "question", "plan_review", "user_question"].includes(String(v.on));
    default:
      return false;
  }
};
const permission = (v: unknown) =>
  record(v) &&
  (v.behavior === "allow"
    ? optional(v.updatedInput, record)
    : v.behavior === "deny" && optional(v.message, str));
const plan = (v: unknown) =>
  record(v) &&
  ["implement", "implement_fresh", "revise", "discuss", "handoff"].includes(String(v.action)) &&
  optional(v.mode, mode) &&
  optional(v.model, str) &&
  optional(v.effort, str) &&
  (v.action !== "revise" || str(v.plan));

const stringMap = (v: unknown) => record(v) && Object.values(v).every(str);
const mcp = (v: unknown): boolean => {
  if (
    !record(v) ||
    !str(v.name) ||
    !record(v.spec) ||
    !optional(
      v.defaultFor,
      (x) => Array.isArray(x) && x.every((c) => MCP_CAPABILITIES.includes(c)),
    ) ||
    !optional(v.credentialEnv, str)
  )
    return false;
  const s = v.spec;
  if (s.transport === "stdio")
    return str(s.command) && optional(s.args, strings) && optional(s.env, stringMap);
  return s.transport === "http" && str(s.url) && optional(s.headers, stringMap);
};

const sessionOptions = (v: unknown, resume: boolean): boolean => {
  if (!record(v) || !str(v.sessionId) || !str(v.cwd)) return false;
  if (resume ? !str(v.providerRef) : !str(v.prompt) || !mode(v.mode)) return false;
  if (!optional(v.mode, mode)) return false;
  for (const key of ["model", "effort", "parentId", "systemPromptAppend", "workspaceRoot"]) {
    if (!optional(v[key], str)) return false;
  }
  if (!optional(v.repoInstructions, nullableString)) return false;
  for (const key of ["disableTools", "settingSources"])
    if (!optional(v[key], strings)) return false;
  for (const key of ["loomServer", "oneShot"])
    if (!optional(v[key], (x) => typeof x === "boolean")) return false;
  if (
    !optional(
      v.subagents,
      (x) =>
        Array.isArray(x) &&
        x.every(
          (a) =>
            record(a) &&
            str(a.name) &&
            str(a.description) &&
            str(a.prompt) &&
            optional(a.tools, strings) &&
            optional(a.model, str),
        ),
    )
  )
    return false;
  return (
    (resume && v.mcpServers === undefined) ||
    (Array.isArray(v.mcpServers) && v.mcpServers.every(mcp))
  );
};

export const decodeWorkerRequest = (v: unknown): WorkerRequest => {
  if (!record(v) || v.kind !== "request" || !id(v.id) || !Array.isArray(v.args))
    throw new Error("invalid worker request");
  const a = v.args;
  let valid = false;
  switch (v.method) {
    case "initialize": {
      const b = a[0];
      valid =
        a.length === 1 &&
        record(b) &&
        str(b.generation) &&
        str(b.providerId) &&
        str(b.sessionId) &&
        ["session", "title", "discovery", "enumeration", "capabilities"].includes(String(b.role)) &&
        optional(b.baseBranch, str) &&
        ["@loom/connector-mock", "@loom/connector-claude"].includes(String(b.connector)) &&
        record(b.config) &&
        Object.entries(b.config).every(
          ([k, v]) => ["cliPath", "configDir", "promptCacheTtl"].includes(k) && str(v),
        );
      break;
    }
    case "create":
    case "resume":
      valid = a.length === 1 && sessionOptions(a[0], v.method === "resume");
      break;
    case "send":
    case "setModel":
    case "setEffort":
      valid = a.length === 1 && str(a[0]);
      break;
    case "setMode":
      valid = a.length === 1 && mode(a[0]);
      break;
    case "compact":
      valid = a.length === 0 || (a.length === 1 && str(a[0]));
      break;
    case "rewind":
      valid =
        (a.length === 1 || a.length === 2) &&
        Number.isSafeInteger(a[0]) &&
        Number(a[0]) >= 0 &&
        optional(a[1], str);
      break;
    case "respondToPermission":
      valid = a.length === 2 && str(a[0]) && permission(a[1]);
      break;
    case "answerQuestion":
      valid = a.length === 2 && str(a[0]) && str(a[1]);
      break;
    case "respondToPlan":
      valid = a.length === 2 && str(a[0]) && plan(a[1]);
      break;
    case "interrupt":
    case "close":
    case "listModels":
    case "listPersistedSessions":
      valid = a.length === 0;
      break;
  }
  if (!valid) throw new Error("invalid worker method or arguments");
  return v as unknown as WorkerRequest;
};

export const decodeWorkerFrame = (v: unknown): WorkerFrame => {
  if (!record(v)) throw new Error("invalid worker frame");
  let valid = false;
  switch (v.kind) {
    case "hello":
      valid = Number.isSafeInteger(v.version);
      break;
    case "end":
      valid = true;
      break;
    case "response":
      valid =
        id(v.id) &&
        optional(v.error, (e) => record(e) && e.code === "operation_failed" && str(e.message));
      break;
    case "models":
      valid =
        id(v.id) &&
        Array.isArray(v.models) &&
        v.models.every(
          (m) =>
            record(m) &&
            str(m.id) &&
            optional(m.label, str) &&
            optional(m.context, finite) &&
            optional(m.supportsEffort, (x) => typeof x === "boolean") &&
            optional(m.effortLevels, strings) &&
            optional(m.defaultEffort, str),
        );
      break;
    case "sessions":
      valid =
        id(v.id) && Array.isArray(v.sessions) && v.sessions.every((s) => sessionOptions(s, true));
      break;
    case "ready": {
      const c = v.capabilities;
      valid =
        id(v.id) &&
        str(v.generation) &&
        record(c) &&
        [
          "liveModeSwitch",
          "liveModelSwitch",
          "forking",
          "rewind",
          "subagents",
          "compaction",
          "compactionInstructions",
          "ownsTranscript",
          "oneShot",
          "partialTokens",
        ].every((k) => typeof c[k] === "boolean") &&
        strings(c.models) &&
        Array.isArray(c.permissionModes) &&
        c.permissionModes.every(mode);
      break;
    }
    case "state": {
      const s = v.snapshot;
      valid =
        record(s) &&
        state(s.status) &&
        nullableString(s.providerRef) &&
        nullableString(s.model) &&
        nullableString(s.effort) &&
        mode(s.mode) &&
        tokens(s.usage) &&
        ["contextUsed", "contextLimit", "costUsd", "turns"].every((k) => finite(s[k])) &&
        optional(s.rewindRef, str);
      break;
    }
    case "event": {
      const e = v.event;
      if (!id(v.seq) || !record(e) || !str(e.sessionId) || !finite(e.ts)) break;
      if (!optional(e.agentId, str) || !optional(e.ordinal, finite)) break;
      switch (e.type) {
        case "assistant_text":
        case "thinking":
          valid = str(e.text);
          break;
        case "compact":
          valid =
            ["manual", "auto"].includes(String(e.trigger)) && finite(e.before) && finite(e.after);
          break;
        case "error":
          valid = str(e.message) && typeof e.fatal === "boolean";
          break;
        case "result":
          valid = e.kind === "ok" ? optional(e.summary, str) : e.kind === "error" && str(e.error);
          break;
        case "permission_request":
          valid = str(e.id) && str(e.tool);
          break;
        case "question":
          valid = str(e.id) && str(e.question) && optional(e.context, str);
          break;
        case "plan_review":
          valid = str(e.id) && str(e.plan);
          break;
        case "status_changed":
          valid = state(e.status);
          break;
        case "usage":
          valid =
            tokens(e.tokens) &&
            finite(e.contextUsed) &&
            finite(e.contextLimit) &&
            optional(e.costDeltaUsd, finite) &&
            optional(e.cacheTtlMinutes, finite) &&
            optional(
              e.cacheCreation,
              (value) =>
                record(value) &&
                optional(
                  value.ephemeral_5m_input_tokens,
                  (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
                ) &&
                optional(
                  value.ephemeral_1h_input_tokens,
                  (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
                ),
            );
          break;
        case "tool_call":
          valid = str(e.id) && str(e.name) && "input" in e;
          break;
        case "tool_result":
          valid = str(e.id) && typeof e.ok === "boolean" && "output" in e;
          break;
        case "answer":
          valid = str(e.id) && str(e.text);
          break;
        case "context":
          valid = finite(e.contextUsed) && optional(e.contextLimit, finite);
          break;
        case "compact_progress":
          valid = finite(e.elapsedMs) && finite(e.generated) && finite(e.before);
          break;
        case "subagent_started":
          valid = str(e.subagentId) && str(e.name);
          break;
        case "subagent_stopped":
          valid = str(e.subagentId);
          break;
        case "background_tasks":
          valid =
            Array.isArray(e.tasks) &&
            e.tasks.every(
              (t) =>
                record(t) &&
                str(t.id) &&
                str(t.title) &&
                ["subagent", "shell", "workflow", "monitor", "other"].includes(String(t.kind)),
            );
          break;
        case "rate_limit":
          valid =
            ["allowed", "allowed_warning", "rejected"].includes(String(e.status)) &&
            optional(e.window, str) &&
            optional(e.utilization, finite) &&
            optional(e.resetsAt, finite);
          break;
      }
      break;
    }
  }
  if (!valid) throw new Error("invalid worker frame payload");
  return v as unknown as WorkerFrame;
};
