/**
 * Translate the Claude Agent SDK's `SDKMessage` stream into Loom's normalized
 * `HarnessEvent` union (design spec §3). Kept deliberately loose about the SDK's
 * `@anthropic-ai/sdk` Beta content-block types — we narrow by `.type` and read
 * only the fields we forward, so a Beta type reshape can't break the mapper.
 *
 * Token / cost accounting is stateful: the SDK reports cumulative totals per
 * `query()` call, so the mapper differences them to emit per-turn deltas.
 * Context fill stays absolute, tracked from each main-loop assistant
 * message's own `usage` rather than the turn-level `result.usage` — a turn
 * can drive many internal model calls, and `result.usage` sums all of them,
 * so it isn't the current window fill.
 */
import type {
  BackgroundTaskInfo,
  BackgroundTaskKind,
  HarnessEvent,
  TokenUsage,
} from "@loom/core/events";

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
  /** Chain-entry UUID on assistant / user frames — the fork point for `resumeSessionAt`. */
  uuid?: string;
  parent_tool_use_id?: string | null;
  error?: string;
  message?: { role?: string; model?: string; content?: unknown; usage?: RawUsage };
  // result
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  /** >0 ⇒ more user turns are already queued; this `result` is not the end. */
  queued_turn_count?: number;
  total_cost_usd?: number;
  usage?: RawUsage;
  modelUsage?: Record<string, ModelUsageEntry>;
  errors?: string[];
  // compact_boundary system message
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
  summary?: string;
  // background_tasks_changed system message — full live set, REPLACE semantics.
  tasks?: Array<{
    task_id?: string;
    task_type?: string;
    description?: string;
    /** Housekeeping task the CLI hides from activity indicators — we drop these. */
    ambient?: boolean;
  }>;
  // rate_limit_event
  rate_limit_info?: {
    status?: string;
    rateLimitType?: string;
    utilization?: number;
    resetsAt?: number;
  };
}

// --- structured /usage ----------------------------------------------------

/** One plan window in the `get_usage` control-request response. */
interface SdkUsageWindow {
  /** Percentage of the window used, 0-100 — `null` when the endpoint omits it. */
  utilization?: number | null;
  /** ISO 8601 reset time, or `null`. */
  resets_at?: string | null;
}

/**
 * The subset of the SDK's experimental `get_usage` response we read — the
 * claude.ai plan rate-limit windows. `rate_limits_available` is false (and
 * `rate_limits` null) for API-key / Bedrock / Vertex sessions.
 */
export interface SdkGetUsageResponse {
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: SdkUsageWindow | null;
    seven_day?: SdkUsageWindow | null;
    seven_day_opus?: SdkUsageWindow | null;
    seven_day_sonnet?: SdkUsageWindow | null;
  } | null;
}

/** Plan windows we forward, in display order. */
const PLAN_WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;

/** Coarse status for a polled window — the streamed event still carries the
 *  provider's authoritative `rejected` / `allowed_warning` when the cap bites. */
const planStatus = (utilization: number): "allowed" | "allowed_warning" | "rejected" => {
  if (utilization >= 100) return "rejected";
  if (utilization >= 80) return "allowed_warning";
  return "allowed";
};

// --- accounting state ------------------------------------------------------

export interface MapperState {
  /** The Claude JSONL session id, from the `init` system message. */
  providerRef: string | null;
  model: string | null;
  /** Cumulative — updated from each `result`. */
  costUsd: number;
  usage: TokenUsage;
  turns: number;
  /** The main loop's last single request's input-side tokens, and the model's context limit. */
  contextUsed: number;
  contextLimit: number;
  /**
   * The last completed turn's last main-loop chain-entry UUID — the fork point
   * an undo resumes at (`Options.resumeSessionAt`). null until the first turn
   * lands, or if no frame carried a UUID.
   */
  rewindRef: string | null;
}

const zeroUsage = (): TokenUsage => {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
};

const blocks = (content: unknown): ContentBlock[] => {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
};

/** Map the SDK's free-text `task_type` onto our coarse {@link BackgroundTaskKind}. */
const taskKind = (t: string | undefined): BackgroundTaskKind => {
  const s = (t ?? "").toLowerCase();
  if (s.includes("agent")) return "subagent"; // local_agent / remote_agent / subagent
  if (s.includes("bash") || s.includes("shell")) return "shell";
  if (s.includes("workflow")) return "workflow";
  if (s.includes("monitor") || s.includes("mcp")) return "monitor";
  return "other";
};

/** Trim the SDK's "… [+N chars]" clip marker and collapse whitespace. */
const cleanTitle = (s: string | undefined): string =>
  (s ?? "")
    .replace(/…\s*\[\+\d+\s*chars\]\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();

const sumModelUsage = (
  mu: Record<string, ModelUsageEntry> | undefined,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  contextLimit: number;
} => {
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
};

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
    rewindRef: null,
  };

  /** Most recent main-loop chain-entry UUID seen this turn; snapshotted into
   *  `state.rewindRef` at each completed turn boundary. */
  #lastChainUuid: string | null = null;

  /**
   * Usage / cost totalled by `query()` calls that ran *before* an undo swapped
   * the live query. The SDK restarts `modelUsage` / `total_cost_usd` from ~0 for
   * a resumed query, so the reported cumulative is `#carry + current query` —
   * kept so `snapshot().usage` / `costUsd` never regress across a rewind (C2).
   */
  readonly #carry = { usage: zeroUsage(), costUsd: 0 };
  /** The current query's own running totals — the baseline the SDK's cumulative
   *  `modelUsage` / `total_cost_usd` is diffed against for the per-turn delta. */
  #queryUsage: TokenUsage = zeroUsage();
  #queryCostUsd = 0;

  /** Open *foreground* `Task` tool calls: tool_use id → sub-agent name. A
   *  backgrounded Task is tracked via `background_tasks_changed` instead. */
  readonly #openSubagents = new Map<string, string>();

  /** Ids of the last `background_tasks` set we emitted — to suppress no-op repeats. */
  #lastBgSig: string | null = null; // null until the first set is emitted

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  /** Normalize one SDK message. May yield zero, one, or several harness events. */
  map(msg: unknown): HarnessEvent[] {
    const m = msg as SdkMsgLite;
    // Track the main loop's chain as it streams — every assistant / user frame
    // is a chain entry `resumeSessionAt` accepts. Subagent frames (parent set)
    // live in their own window and never become a fork point.
    if ((m.type === "assistant" || m.type === "user") && m.parent_tool_use_id == null) {
      if (typeof m.uuid === "string" && m.uuid.length > 0) this.#lastChainUuid = m.uuid;
    }
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          if (typeof m.session_id === "string") this.state.providerRef = m.session_id;
          if (typeof m.model === "string") this.state.model = m.model;
          return [];
        }
        if (m.subtype === "compact_boundary") return this.#compactBoundary(m);
        if (m.subtype === "background_tasks_changed") return this.#backgroundTasks(m);
        return [];
      case "assistant":
        return this.#assistant(m);
      case "user":
        return this.#user(m);
      case "result":
        return this.#result(m);
      case "rate_limit_event":
        return this.#rateLimit(m);
      default:
        // stream_event (partials, not requested), tool_progress, notifications, …
        return [];
    }
  }

  /**
   * The adapter calls this when `rewind()` forks + resumes a fresh `query()`.
   * Fold the finished query's totals into `#carry` so the reported cumulative
   * stays monotonic (C2), and drop per-query carry-over state that would
   * otherwise point into the truncated-away transcript (C13): the last chain
   * UUID (a stale `rewindRef` source), the background-task signature (would
   * suppress a legitimate re-emit), and any open foreground sub-agents.
   */
  onQuerySwap(): void {
    this.#carry.usage = {
      input: this.#carry.usage.input + this.#queryUsage.input,
      output: this.#carry.usage.output + this.#queryUsage.output,
      cacheRead: this.#carry.usage.cacheRead + this.#queryUsage.cacheRead,
      cacheWrite: this.#carry.usage.cacheWrite + this.#queryUsage.cacheWrite,
    };
    this.#carry.costUsd += this.#queryCostUsd;
    this.#queryUsage = zeroUsage();
    this.#queryCostUsd = 0;
    this.#lastChainUuid = null;
    // The prior fork ref points into the turns we just undid past — drop it so a
    // second undo before the next completed turn can't fork from a truncated ref.
    this.state.rewindRef = null;
    this.#lastBgSig = null;
    this.#openSubagents.clear();
  }

  #base(agentId: string | null | undefined): { sessionId: string; ts: number; agentId?: string } {
    return {
      sessionId: this.#sessionId,
      ts: Date.now(),
      ...(typeof agentId === "string" && agentId.length > 0 ? { agentId } : {}),
    };
  }

  #rateLimit(m: SdkMsgLite): HarnessEvent[] {
    const info = m.rate_limit_info;
    if (!info) return [];
    const status =
      info.status === "allowed_warning" || info.status === "rejected" ? info.status : "allowed";
    return [
      {
        type: "rate_limit",
        ...this.#base(null),
        status,
        ...(info.rateLimitType ? { window: info.rateLimitType } : {}),
        ...(typeof info.utilization === "number" ? { utilization: info.utilization } : {}),
        ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
      },
    ];
  }

  /**
   * Map the SDK's structured `/usage` response (the `get_usage` control
   * request) into one `rate_limit` event per plan window. Unlike the streamed
   * `rate_limit_event` — a change-notification for whichever window is currently
   * binding — this is a full on-demand snapshot, so it's what keeps `five_hour`
   * / `seven_day` populated when nothing is near the cap. The adapter calls it
   * after init (covering resume too) and, throttled, after each turn. `status`
   * is derived from utilization; the streamed event still supplies the
   * authoritative `rejected` / `allowed_warning` the moment the cap bites.
   */
  mapPlanUsage(resp: SdkGetUsageResponse | null | undefined): HarnessEvent[] {
    const rl = resp?.rate_limits;
    if (!resp?.rate_limits_available || !rl) return [];
    const out: HarnessEvent[] = [];
    for (const window of PLAN_WINDOWS) {
      const w = rl[window];
      if (!w || typeof w.utilization !== "number") continue;
      const resetsAt = w.resets_at ? Date.parse(w.resets_at) : Number.NaN;
      out.push({
        type: "rate_limit",
        ...this.#base(null),
        status: planStatus(w.utilization),
        window,
        utilization: w.utilization,
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      });
    }
    return out;
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

  /**
   * `background_tasks_changed` carries the full live set every time membership
   * changes (and a snapshot right after a re-init). We forward it as a single
   * REPLACE-semantics `background_tasks` event, minus ambient/housekeeping
   * entries, and skip it when the membership is byte-for-byte what we last sent
   * — the daemon de-dupes *status* transitions but not arbitrary events.
   */
  #backgroundTasks(m: SdkMsgLite): HarnessEvent[] {
    const raw = Array.isArray(m.tasks) ? m.tasks : [];
    const tasks: BackgroundTaskInfo[] = raw
      .filter((t): t is { task_id: string; task_type?: string; description?: string } =>
        Boolean(t && t.ambient !== true && typeof t.task_id === "string" && t.task_id.length > 0),
      )
      .map((t) => ({
        id: t.task_id,
        kind: taskKind(t.task_type),
        title: cleanTitle(t.description) || t.task_type || "background task",
      }));
    // Membership is the id set; churn in title/kind alone isn't worth re-emitting.
    const sig = tasks
      .map((t) => t.id)
      .sort()
      .join(",");
    if (sig === this.#lastBgSig) return [];
    this.#lastBgSig = sig;
    return [{ type: "background_tasks", ...this.#base(null), tasks }];
  }

  #assistant(m: SdkMsgLite): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const base = this.#base(m.parent_tool_use_id);
    if (typeof m.error === "string" && m.error.length > 0) {
      out.push({ type: "error", ...base, message: `assistant: ${m.error}`, fatal: false });
    }
    // Context fill is the size of the single most recent request to the main
    // loop's model — a subagent runs in its own window, and a turn can drive
    // many internal tool-calling round trips, so the *turn's* cumulative
    // `result.usage` (summed over all of those calls) isn't it.
    if (m.parent_tool_use_id == null && m.message?.usage) {
      const u = m.message.usage;
      this.state.contextUsed =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
    }
    for (const b of blocks(m.message?.content)) {
      if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
        out.push({ type: "assistant_text", ...base, text: b.text });
      } else if (b.type === "thinking" || b.type === "redacted_thinking") {
        const text = b.thinking ?? b.text ?? "";
        if (text.length > 0) out.push({ type: "thinking", ...base, text });
      } else if (b.type === "tool_use") {
        const id = b.id ?? "";
        out.push({ type: "tool_call", ...base, id, name: b.name ?? "", input: b.input ?? {} });
        // The `Task` tool spawns a sub-agent; its own messages then carry
        // parent_tool_use_id === this id until the matching tool_result.
        // A *foreground* Task brackets cleanly (subagent_started here,
        // subagent_stopped on the tool_result). A *backgrounded* one returns
        // its tool_result immediately with the agent still running, so pairing
        // those edges would report it finished at birth — those are surfaced
        // via `background_tasks_changed` instead.
        if (b.name === "Task" && id) {
          const i = (b.input ?? {}) as Record<string, unknown>;
          const name =
            (typeof i["subagent_type"] === "string" && i["subagent_type"]) ||
            (typeof i["description"] === "string" && i["description"]) ||
            "task";
          const backgrounded = i["run_in_background"] === true || i["isolation"] === "remote";
          if (!backgrounded) {
            this.#openSubagents.set(id, name);
            out.push({ type: "subagent_started", ...base, subagentId: id, name });
          }
        }
      }
    }
    return out;
  }

  #user(m: SdkMsgLite): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const base = this.#base(m.parent_tool_use_id);
    for (const b of blocks(m.message?.content)) {
      if (b.type === "tool_result") {
        const id = b.tool_use_id ?? "";
        out.push({
          type: "tool_result",
          ...base,
          id,
          ok: b.is_error !== true,
          output: b.content ?? null,
        });
        if (this.#openSubagents.has(id)) {
          this.#openSubagents.delete(id);
          out.push({ type: "subagent_stopped", ...base, subagentId: id });
        }
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
    const rawMu = m.modelUsage ? sumModelUsage(m.modelUsage) : null;
    // A crash / startup-error `result` can carry an all-zero modelUsage. Taking
    // it as the new cumulative would reset the running totals to 0, so the next
    // healthy turn diffs its real cumulative against 0 and emits a huge false
    // spike — treat all-zero as "no info" and use the per-turn path instead.
    const mu =
      rawMu &&
      (rawMu.input > 0 ||
        rawMu.output > 0 ||
        rawMu.cacheRead > 0 ||
        rawMu.cacheWrite > 0 ||
        rawMu.costUsd > 0)
        ? rawMu
        : null;
    // `cum` is the *current query's* cumulative (SDK `modelUsage` is cumulative
    // per `query()` and restarts on a resumed query). Diff it against the
    // current-query baseline, not the reported total — the reported total also
    // carries pre-undo history via `#carry`.
    const cum = mu
      ? mu
      : {
          input: this.#queryUsage.input + (m.usage?.input_tokens ?? 0),
          output: this.#queryUsage.output + (m.usage?.output_tokens ?? 0),
          cacheRead: this.#queryUsage.cacheRead + (m.usage?.cache_read_input_tokens ?? 0),
          cacheWrite: this.#queryUsage.cacheWrite + (m.usage?.cache_creation_input_tokens ?? 0),
          costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : this.#queryCostUsd,
          contextLimit: this.state.contextLimit,
        };

    const delta: TokenUsage = {
      input: Math.max(0, cum.input - this.#queryUsage.input),
      output: Math.max(0, cum.output - this.#queryUsage.output),
      cacheRead: Math.max(0, cum.cacheRead - this.#queryUsage.cacheRead),
      cacheWrite: Math.max(0, cum.cacheWrite - this.#queryUsage.cacheWrite),
    };
    const costDeltaUsd = Math.max(0, cum.costUsd - this.#queryCostUsd);

    // `contextUsed` is already current — kept up to date per main-loop
    // assistant message in #assistant(), from that single request's own
    // usage rather than this turn's (possibly multi-call) cumulative total.
    const contextUsed = this.state.contextUsed;
    const contextLimit = cum.contextLimit || this.state.contextLimit;

    // Advance the current-query baseline, then report `#carry + current query`
    // so `state.usage` / `state.costUsd` never regress across a rewind (C2).
    this.#queryUsage = {
      input: cum.input,
      output: cum.output,
      cacheRead: cum.cacheRead,
      cacheWrite: cum.cacheWrite,
    };
    this.#queryCostUsd = cum.costUsd;
    this.state.usage = {
      input: this.#carry.usage.input + this.#queryUsage.input,
      output: this.#carry.usage.output + this.#queryUsage.output,
      cacheRead: this.#carry.usage.cacheRead + this.#queryUsage.cacheRead,
      cacheWrite: this.#carry.usage.cacheWrite + this.#queryUsage.cacheWrite,
    };
    this.state.costUsd = this.#carry.costUsd + this.#queryCostUsd;
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
    let summary: string;
    if (ok) summary = m.result ?? "";
    else if (m.errors && m.errors.length > 0) summary = m.errors.join("; ");
    else summary = m.subtype ?? "error";

    // The SDK emits one `result` per SDK turn, but Loom stitches several SDK
    // turns into one engagement — a mid-turn message the user sent while the
    // last turn was still running, or the "implement it now" turn the plan
    // approval path queues itself. When the SDK tells us more user turns are
    // already queued (`queued_turn_count > 0`), this `result` is an internal
    // seam, not a turn boundary: emitting it would log a false "turn complete"
    // and flap the session to `idle` while it's plainly still working. Keep
    // the usage delta above; drop the marker. A failed turn still surfaces —
    // the error is worth seeing even mid-engagement.
    const queued = (m.queued_turn_count ?? 0) > 0;
    if (ok && queued) return out;

    if (ok) {
      // This turn is a real boundary now — its last chain entry is the fork
      // point a later undo resumes at.
      this.state.rewindRef = this.#lastChainUuid;
      out.push({ type: "result", ...base, kind: "ok", ...(summary ? { summary } : {}) });
    } else {
      out.push({ type: "error", ...base, message: `result: ${summary}`, fatal: false });
      out.push({ type: "result", ...base, kind: "error", error: summary });
    }

    // A foreground `Task` that crashed without emitting its `tool_result` would
    // otherwise leave `subagent_started` unbalanced for the session's life.
    // This engagement segment has ended (no more turns queued) — close any
    // still-open ones.
    if (!queued && this.#openSubagents.size > 0) {
      for (const subId of this.#openSubagents.keys()) {
        out.push({ type: "subagent_stopped", ...base, subagentId: subId });
      }
      this.#openSubagents.clear();
    }
    return out;
  }
}
