/**
 * Minimal vendored ChatGPT/Codex OAuth provider for AI SDK v5.
 *
 * Adapted from the MIT-licensed `@grikomsn/ai-sdk-provider-chatgpt-oauth`
 * v2 provider, but kept here because its published v2 targets AI SDK v7. The
 * catalog and request shapes are verified against the local Codex source tree.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  SharedV2ProviderMetadata,
} from "@ai-sdk/provider";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
// Codex's public OAuth client id. Refreshing stays in memory: Loom never
// rewrites the user's Codex credential file.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type ChatGPTToolMode = "full" | "codex-shell";

export interface ChatGPTModelInfo {
  slug: string;
  display_name?: string;
  /** Codex exposes only `list` models in its picker. */
  visibility?: "list" | "hide" | "none" | string;
  /** Lower values are preferred by Codex when choosing its default model. */
  priority?: number;
  base_instructions?: string;
  context_window?: number;
  max_context_window?: number;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort?: string }>;
  tool_mode?: "code_mode_only" | string | null;
  multi_agent_version?: string | null;
}

interface Credentials {
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  expiresAt?: number;
}

interface CatalogResponse {
  models?: ChatGPTModelInfo[];
}

interface ChatGPTMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
}

/** Responses input items, rather than Chat Completions' `tool_calls` shape. */
interface ChatGPTFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface ChatGPTFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

interface PreparedRequest {
  body: Record<string, unknown>;
  warnings: LanguageModelV2CallWarning[];
  toolMapping: Map<string, string>;
}

const jwtPayload = (token: string): Record<string, unknown> => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const accountIdFromToken = (token: string): string => {
  const payload = jwtPayload(token);
  const nested = payload["https://api.openai.com/auth"];
  const account =
    payload["https://chatgpt.com/account_id"] ??
    (nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)["chatgpt_account_id"]
      : undefined) ??
    payload["account_id"];
  return typeof account === "string" ? account : "";
};

const expiryFromToken = (token: string): number | undefined => {
  const exp = jwtPayload(token)["exp"];
  return typeof exp === "number" ? exp * 1000 : undefined;
};

class CodexAuth {
  #credentials: Credentials | undefined;
  #refreshing: Promise<Credentials> | undefined;
  readonly authPath: string | undefined;

  constructor(authPath?: string) {
    this.authPath = authPath;
  }

  async credentials(): Promise<Credentials> {
    if (!this.#credentials) this.#credentials = await this.#load();
    if ((this.#credentials.expiresAt ?? Infinity) - Date.now() < 60_000) {
      if (!this.#refreshing) this.#refreshing = this.#refresh(this.#credentials);
      try {
        this.#credentials = await this.#refreshing;
      } finally {
        this.#refreshing = undefined;
      }
    }
    return this.#credentials;
  }

  async #load(): Promise<Credentials> {
    const path = this.authPath || join(homedir(), ".codex", "auth.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      throw new Error(`could not read Codex OAuth credentials at ${path}`, { cause: err });
    }
    const tokens =
      parsed && typeof parsed === "object" && (parsed as Record<string, unknown>)["tokens"]
        ? ((parsed as Record<string, unknown>)["tokens"] as Record<string, unknown>)
        : undefined;
    const accessToken = typeof tokens?.["access_token"] === "string" ? tokens.access_token : "";
    const idToken = typeof tokens?.["id_token"] === "string" ? tokens.id_token : "";
    const accountId =
      (typeof tokens?.["account_id"] === "string" ? tokens.account_id : "") ||
      accountIdFromToken(idToken || accessToken);
    if (!accessToken || !accountId)
      throw new Error("Codex auth.json does not contain usable ChatGPT OAuth credentials");
    const expiry = expiryFromToken(accessToken) ?? expiryFromToken(idToken);
    return {
      accessToken,
      accountId,
      ...(typeof tokens?.["refresh_token"] === "string"
        ? { refreshToken: tokens.refresh_token }
        : {}),
      ...(expiry ? { expiresAt: expiry } : {}),
    };
  }

  async #refresh(credentials: Credentials): Promise<Credentials> {
    if (!credentials.refreshToken)
      throw new Error("Codex OAuth token expired and has no refresh token");
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) throw new Error(`Codex OAuth refresh failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body["access_token"] !== "string")
      throw new Error("Codex OAuth refresh returned no access token");
    return {
      accessToken: body.access_token,
      accountId: credentials.accountId,
      refreshToken:
        typeof body["refresh_token"] === "string" ? body.refresh_token : credentials.refreshToken,
      ...(typeof body["expires_in"] === "number"
        ? { expiresAt: Date.now() + body.expires_in * 1000 }
        : {}),
    };
  }
}

/** One shared authenticated catalog, including the exact model instructions. */
export class ChatGPTCatalog {
  #models: ChatGPTModelInfo[] | undefined;
  #loading: Promise<ChatGPTModelInfo[]> | undefined;
  readonly auth: CodexAuth;
  readonly baseUrl: string;

  constructor(auth: CodexAuth, baseUrl = DEFAULT_BASE_URL) {
    this.auth = auth;
    this.baseUrl = baseUrl;
  }

  async list(): Promise<ChatGPTModelInfo[]> {
    if (this.#models) return this.#models;
    if (!this.#loading) this.#loading = this.#fetch();
    try {
      this.#models = await this.#loading;
      return this.#models;
    } finally {
      this.#loading = undefined;
    }
  }

  async get(model: string): Promise<ChatGPTModelInfo> {
    const found = (await this.list()).find((x) => x.slug === model);
    if (!found)
      throw new Error(`model ${JSON.stringify(model)} is not available to this ChatGPT account`);
    return found;
  }

  async headers(): Promise<Record<string, string>> {
    const credentials = await this.auth.credentials();
    return {
      Authorization: `Bearer ${credentials.accessToken}`,
      "ChatGPT-Account-ID": credentials.accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      session_id: randomUUID(),
    };
  }

  async #fetch(): Promise<ChatGPTModelInfo[]> {
    const res = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/codex/models?client_version=0.0.0`,
      {
        headers: { Accept: "application/json", ...(await this.headers()) },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) throw new Error(`Codex model discovery failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as CatalogResponse;
    return (body.models ?? []).filter(
      (model) => typeof model.slug === "string" && model.slug !== "",
    );
  }
}

const asText = (part: { type: string; text?: string; filename?: string }): string => {
  if (part.type === "text" && typeof part.text === "string") return part.text;
  if (part.type === "file") {
    const name = typeof part.filename === "string" ? part.filename : "unnamed";
    return `[File: ${name}]`;
  }
  return "";
};

const messagesFor = (
  prompt: LanguageModelV2CallOptions["prompt"],
): Array<ChatGPTMessage | ChatGPTFunctionCall | ChatGPTFunctionCallOutput> => {
  const messages: Array<ChatGPTMessage | ChatGPTFunctionCall | ChatGPTFunctionCallOutput> = [];
  for (const message of prompt) {
    if (message.role === "system") messages.push({ role: "user", content: message.content });
    else if (message.role === "user")
      messages.push({
        role: "user",
        content: message.content.map(asText).filter(Boolean).join("\n"),
      });
    else if (message.role === "assistant") {
      const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      if (text) messages.push({ role: "assistant", content: text });
      for (const part of message.content) {
        if (part.type !== "tool-call") continue;
        messages.push({
          type: "function_call",
          call_id: part.toolCallId,
          name: part.toolName,
          arguments: JSON.stringify(part.input),
        });
      }
    } else {
      for (const part of message.content) {
        const output = part.output;
        const content =
          output.type === "text" || output.type === "error-text"
            ? output.value
            : JSON.stringify(output.value);
        messages.push({ type: "function_call_output", call_id: part.toolCallId, output: content });
      }
    }
  }
  return messages;
};

const mapFinish = (value: unknown): LanguageModelV2FinishReason => {
  if (value === "completed" || value === "stop") return "stop";
  if (value === "length" || value === "max_tokens") return "length";
  if (value === "tool_calls" || value === "function_call") return "tool-calls";
  if (value === "content_filter") return "content-filter";
  return "other";
};

const usageFor = (raw: unknown): LanguageModelV2Usage => {
  const usage = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const input = typeof usage["input_tokens"] === "number" ? usage.input_tokens : 0;
  const output = typeof usage["output_tokens"] === "number" ? usage.output_tokens : 0;
  const details = usage["input_tokens_details"] as Record<string, unknown> | undefined;
  const cached = typeof details?.["cached_tokens"] === "number" ? details.cached_tokens : undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
  };
};

/** Codex exposes subscription-window use in response headers, not its SSE body. */
const rateLimitMetadataFor = (headers: Headers): SharedV2ProviderMetadata | undefined => {
  const prefixes = new Set<string>();
  for (const [name] of headers) {
    const match = /^x-(.+)-(?:primary|secondary)-used-percent$/i.exec(name);
    if (match?.[1]) prefixes.add(match[1].toLowerCase());
  }
  const rateLimits: Record<string, Record<string, string | number>> = {};
  for (const prefix of prefixes) {
    for (const window of ["primary", "secondary"] as const) {
      const utilization = Number(headers.get(`x-${prefix}-${window}-used-percent`));
      if (!Number.isFinite(utilization)) continue;
      const resetSeconds = Number(headers.get(`x-${prefix}-${window}-reset-at`));
      let status: "rejected" | "allowed_warning" | "allowed";
      if (utilization >= 100) status = "rejected";
      else if (utilization >= 80) status = "allowed_warning";
      else status = "allowed";
      rateLimits[`${prefix}-${window}`] = {
        status,
        utilization,
        ...(Number.isFinite(resetSeconds) && resetSeconds > 0
          ? { resetsAt: resetSeconds * 1000 }
          : {}),
      };
    }
  }
  return Object.keys(rateLimits).length > 0 ? { chatgpt: { rateLimits } } : undefined;
};

const configuredEffort = (options: LanguageModelV2CallOptions): string | undefined => {
  const providers = options.providerOptions as Record<string, unknown> | undefined;
  const settings = providers?.["chatgpt"];
  if (!settings || typeof settings !== "object") return undefined;
  const effort = (settings as Record<string, unknown>)["reasoningEffort"];
  return typeof effort === "string" ? effort : undefined;
};

export class ChatGPTModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider = "chatgpt";
  readonly supportedUrls: Record<string, RegExp[]> = { "image/*": [/^https?:\/\//] };

  readonly modelId: string;
  readonly catalog: ChatGPTCatalog;

  constructor(modelId: string, catalog: ChatGPTCatalog) {
    this.modelId = modelId;
    this.catalog = catalog;
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    warnings: LanguageModelV2CallWarning[];
  }> {
    const { stream, warnings } = await this.doStream(options);
    const reader = stream.getReader();
    let text = "";
    let finishReason: LanguageModelV2FinishReason = "other";
    let usage: LanguageModelV2Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const content: LanguageModelV2Content[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "text-delta") text += value.delta;
      if (value.type === "tool-call") content.push(value);
      if (value.type === "finish") {
        finishReason = value.finishReason;
        usage = value.usage;
      }
    }
    if (text) content.unshift({ type: "text", text });
    return { content, finishReason, usage, warnings };
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>;
    usage: Promise<LanguageModelV2Usage>;
    warnings: LanguageModelV2CallWarning[];
    response: { headers: Record<string, string> };
  }> {
    const prepared = await this.#prepare(options);
    const response = await fetch(`${this.catalog.baseUrl.replace(/\/$/, "")}/codex/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(await this.catalog.headers()),
        ...options.headers,
      },
      body: JSON.stringify(prepared.body),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    if (!response.ok)
      throw new Error(`ChatGPT Codex request failed: ${response.status} ${await response.text()}`);
    if (!response.body) throw new Error("ChatGPT Codex response has no body");

    const providerMetadata = rateLimitMetadataFor(response.headers);
    let finalUsage: LanguageModelV2Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const reader = response.body.getReader();
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        const decoder = new TextDecoder();
        let buffer = "";
        const textId = `text-${randomUUID()}`;
        let textOpen = false;
        const calls = new Map<string, { name: string; arguments: string }>();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6);
              if (data === "[DONE]") continue;
              let event: Record<string, unknown>;
              try {
                event = JSON.parse(data) as Record<string, unknown>;
              } catch {
                continue;
              }
              const item = event["item"] as Record<string, unknown> | undefined;
              if (
                event.type === "response.output_item.added" &&
                item?.["type"] === "function_call"
              ) {
                const id = typeof item["id"] === "string" ? item.id : `call-${randomUUID()}`;
                calls.set(id, {
                  name: typeof item["name"] === "string" ? item.name : "",
                  arguments: "",
                });
              } else if (event.type === "response.function_call_arguments.delta") {
                const id = typeof event["item_id"] === "string" ? event.item_id : "";
                const delta = typeof event["delta"] === "string" ? event.delta : "";
                const call = calls.get(id);
                if (call) call.arguments += delta;
              } else if (
                event.type === "response.output_item.done" &&
                item?.["type"] === "function_call"
              ) {
                const id: string = typeof item["id"] === "string" ? (item.id as string) : "";
                const call = calls.get(id) ?? { name: "", arguments: "" };
                const name: string =
                  typeof item["name"] === "string" ? (item.name as string) : call.name;
                const args =
                  typeof item["arguments"] === "string"
                    ? (item.arguments as string)
                    : call.arguments;
                if (id && name)
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: id,
                    toolName: prepared.toolMapping.get(name) ?? name,
                    input: args,
                  });
              } else if (
                event.type === "response.output_text.delta" &&
                typeof event["delta"] === "string"
              ) {
                if (!textOpen) {
                  controller.enqueue({ type: "text-start", id: textId });
                  textOpen = true;
                }
                controller.enqueue({ type: "text-delta", id: textId, delta: event.delta });
              } else if (
                event.type === "response.completed" ||
                event.type === "response.incomplete"
              ) {
                const result = event["response"] as Record<string, unknown> | undefined;
                finalUsage = usageFor(result?.["usage"]);
                if (textOpen) controller.enqueue({ type: "text-end", id: textId });
                controller.enqueue({
                  type: "finish",
                  finishReason: mapFinish(result?.["status"] ?? event["status"]),
                  usage: finalUsage,
                  ...(providerMetadata ? { providerMetadata } : {}),
                });
              } else if (event.type === "response.failed") {
                const result = event["response"] as Record<string, unknown> | undefined;
                const error = result?.["error"] as Record<string, unknown> | undefined;
                throw new Error(
                  typeof error?.["message"] === "string"
                    ? error.message
                    : "ChatGPT Codex response failed",
                );
              }
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          reader.releaseLock();
        }
      },
    });
    return {
      stream,
      usage: Promise.resolve(finalUsage),
      warnings: prepared.warnings,
      response: { headers: Object.fromEntries(response.headers) },
    };
  }

  async #prepare(options: LanguageModelV2CallOptions): Promise<PreparedRequest> {
    const info = await this.catalog.get(this.modelId);
    const mode = info.tool_mode === "code_mode_only" ? "codex-shell" : "full";
    const warnings: LanguageModelV2CallWarning[] = [];
    const tools = (options.tools ?? [])
      .filter((tool) => tool.type === "function")
      .filter((tool) => {
        if (mode === "full") return true;
        return tool.name === "bash" || tool.name === "shell";
      })
      .map((tool) => ({
        type: "function",
        name: mode === "codex-shell" ? "shell" : tool.name,
        description:
          mode === "codex-shell"
            ? "Runs a shell command and returns its output"
            : (tool.description ?? ""),
        strict: false,
        parameters:
          mode === "codex-shell"
            ? {
                type: "object",
                properties: {
                  command: { type: "array", items: { type: "string" } },
                  workdir: { type: "string" },
                  timeout: { type: "number" },
                },
                required: ["command"],
                additionalProperties: false,
              }
            : tool.inputSchema,
      }));
    if (mode === "codex-shell" && (options.tools?.length ?? 0) > tools.length)
      warnings.push({
        type: "other",
        message:
          "This Codex model requires code mode; Loom currently exposes only its shell bridge.",
      });
    const requested = configuredEffort(options);
    const effort =
      requested && info.supported_reasoning_levels?.some((x) => x.effort === requested)
        ? requested
        : info.default_reasoning_level;
    return {
      body: {
        model: this.modelId,
        instructions: info.base_instructions ?? "You are a helpful assistant.",
        input: messagesFor(options.prompt),
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        parallel_tool_calls: false,
        ...(effort
          ? { reasoning: { effort, summary: "auto" }, include: ["reasoning.encrypted_content"] }
          : {}),
        store: false,
        stream: true,
      },
      warnings,
      toolMapping: mode === "codex-shell" ? new Map([["shell", "bash"]]) : new Map(),
    };
  }
}

export const createChatGPTModels = (opts: { authPath?: string; baseUrl?: string } = {}) => {
  const catalog = new ChatGPTCatalog(
    new CodexAuth(opts.authPath),
    opts.baseUrl || DEFAULT_BASE_URL,
  );
  return {
    catalog,
    makeModel: (model: string): LanguageModelV2 => new ChatGPTModel(model, catalog),
  };
};
