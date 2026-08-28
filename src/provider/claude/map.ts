/**
 * Translate the Claude Agent SDK's `SDKMessage` stream into Loom's normalized
 * `HarnessEvent` union (design spec §3). Kept deliberately loose about the SDK's
 * `@anthropic-ai/sdk` Beta content-block types — we narrow by `.type` and read
 * only the fields we forward, so a Beta type reshape can't break the mapper.
 *
 * Token / cost accounting is stateful: the SDK reports cumulative totals per
 * `query()` call, so the mapper differences them to emit per-turn deltas
 * (context fill stays absolute — it's the last request's input size).
 */
import type { HarnessEvent, TokenUsage } from "../../protocol/events.ts";

// --- minimal shapes we depend on -------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
}

interface SdkMsgLite {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  error?: string;
  message?: { role?: string; model?: string; content?: unknown; usage?: RawUsage };
  // result
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: RawUsage;
  modelUsage?: Record<string, ModelUsageEntry>;
  errors?: string[];
  // compact_boundary system message
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
  summary?: string;
}

// --- accounting state ------------------------------------------------------

export interface MapperState {
  /** The Claude JSONL session id, from the `init` system message. */
  providerRef: string | null;
  model: string | null;
  /** Cumulative — updated from each `result`. */
  costUsd: number;
  usage: TokenUsage;
  turns: number;
  /** Last request's input-side tokens, and the model's context limit. */
  contextUsed: number;
  contextLimit: number;
}

function zeroUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function blocks(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function sumModelUsage(mu: Record<string, ModelUsageEntry> | undefined): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  contextLimit: number;
} {
  const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextLimit: 0 };
  for (const e of Object.values(mu ?? {})) {
    acc.input += e.inputTokens ?? 0;
    acc.output += e.outputTokens ?? 0;
    acc.cacheRead += e.cacheReadInputTokens ?? 0;
    acc.cacheWrite += e.cacheCreationInputTokens ?? 0;
    acc.costUsd += e.costUSD ?? 0;
    acc.contextLimit = Math.max(acc.contextLimit, e.contextWindow ?? 0);
  }
  return acc;
}

// --- the mapper ----------------------------------------------------------

export class ClaudeEventMapper {
  readonly #sessionId: string;
  readonly state: MapperState = {
    providerRef: null,
    model: null,
    costUsd: 0,
    usage: zeroUsage(),
    turns: 0,
    contextUsed: 0,
    contextLimit: 0,
  };

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  /** Normalize one SDK message. May yield zero, one, or several harness events. */
  map(msg: unknown): HarnessEvent[] {
    const m = msg as SdkMsgLite;
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          if (typeof m.session_id === "string") this.state.providerRef = m.session_id;
          if (typeof m.model === "string") this.state.model = m.model;
          return [];
        }
        if (m.subtype === "compact_boundary") return this.#compactBoundary(m);
        return [];
      case "assistant":
        return this.#assistant(m);
      case "user":
        return this.#user(m);
      case "result":
        return this.#result(m);
      default:
        // stream_event (partials, not requested), tool_progress, notifications, …
        return [];
    }
  }

  #base(agentId: string | null | undefined): { sessionId: string; ts: number; agentId?: string } {
    return {
      sessionId: this.#sessionId,
      ts: Date.now(),
      ...(typeof agentId === "string" && agentId.length > 0 ? { agentId } : {}),
    };
  }

  #compactBoundary(m: SdkMsgLite): HarnessEvent[] {
    const meta = m.compact_metadata ?? {};
    const before = typeof meta.pre_tokens === "number" ? meta.pre_tokens : this.state.contextUsed;
    const after = typeof meta.post_tokens === "number" ? meta.post_tokens : 0;
    // The next request's usage re-measures context; here we only know it dropped.
    if (after > 0) this.state.contextUsed = after;
    return [
      {
        type: "compact",
        ...this.#base(null),
        trigger: meta.trigger === "auto" ? "auto" : "manual",
        before,
        after,
        ...(typeof m.summary === "string" && m.summary.length > 0 ? { summary: m.summary } : {}),
      },
    ];
  }

  #assistant(m: SdkMsgLite): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const base = this.#base(m.parent_tool_use_id);
    if (typeof m.error === "string" && m.error.length > 0) {
      out.push({ type: "error", ...base, message: `assistant: ${m.error}`, fatal: false });
    }
    for (const b of blocks(m.message?.content)) {
      if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
        out.push({ type: "assistant_text", ...base, text: b.text });
      } else if (b.type === "thinking" || b.type === "redacted_thinking") {
        const text = b.thinking ?? b.text ?? "";
        if (text.length > 0) out.push({ type: "thinking", ...base, text });
      } else if (b.type === "tool_use") {
        out.push({
          type: "tool_call",
          ...base,
          id: b.id ?? "",
          name: b.name ?? "",
          input: b.input ?? {},
        });
      }
    }
    return out;
  }

  #user(m: SdkMsgLite): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const base = this.#base(m.parent_tool_use_id);
    for (const b of blocks(m.message?.content)) {
      if (b.type === "tool_result") {
        out.push({
          type: "tool_result",
          ...base,
          id: b.tool_use_id ?? "",
          ok: b.is_error !== true,
          output: b.content ?? null,
        });
      }
    }
    return out;
  }

  #result(m: SdkMsgLite): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const base = this.#base(null);

    if (typeof m.num_turns === "number") this.state.turns = m.num_turns;

    // Prefer modelUsage (covers subagents + internal calls); fall back to the
    // per-turn main-loop `usage` + cumulative `total_cost_usd`.
    const mu = m.modelUsage;
    const cum = mu
      ? sumModelUsage(mu)
      : {
          input: this.state.usage.input + (m.usage?.input_tokens ?? 0),
          output: this.state.usage.output + (m.usage?.output_tokens ?? 0),
          cacheRead: this.state.usage.cacheRead + (m.usage?.cache_read_input_tokens ?? 0),
          cacheWrite: this.state.usage.cacheWrite + (m.usage?.cache_creation_input_tokens ?? 0),
          costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : this.state.costUsd,
          contextLimit: this.state.contextLimit,
        };

    const delta: TokenUsage = {
      input: Math.max(0, cum.input - this.state.usage.input),
      output: Math.max(0, cum.output - this.state.usage.output),
      cacheRead: Math.max(0, cum.cacheRead - this.state.usage.cacheRead),
      cacheWrite: Math.max(0, cum.cacheWrite - this.state.usage.cacheWrite),
    };
    const costDeltaUsd = Math.max(0, cum.costUsd - this.state.costUsd);

    const lastReq = m.usage;
    const contextUsed = lastReq
      ? (lastReq.input_tokens ?? 0) +
        (lastReq.cache_read_input_tokens ?? 0) +
        (lastReq.cache_creation_input_tokens ?? 0)
      : this.state.contextUsed;
    const contextLimit = cum.contextLimit || this.state.contextLimit;

    this.state.usage = { ...cum };
    this.state.costUsd = cum.costUsd;
    this.state.contextUsed = contextUsed;
    this.state.contextLimit = contextLimit;

    out.push({
      type: "usage",
      ...base,
      tokens: delta,
      contextUsed,
      contextLimit,
      ...(costDeltaUsd > 0 ? { costDeltaUsd } : {}),
    });

    const ok = m.subtype === "success" && m.is_error !== true;
    const summary = ok
      ? (m.result ?? "")
      : (m.errors && m.errors.length > 0 ? m.errors.join("; ") : (m.subtype ?? "error"));
    if (!ok) {
      out.push({ type: "error", ...base, message: `result: ${summary}`, fatal: false });
    }
    out.push({ type: "result", ...base, ok, ...(summary ? { summary } : {}) });
    return out;
  }
}
