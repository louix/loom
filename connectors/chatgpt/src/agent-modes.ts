/**
 * Loom agent modes expressed as Codex's native thread settings.
 *
 * Codex owns the effective state: an approval reviewer (`auto_review` or
 * `user`, always with `on-request` approvals) and a collaboration mode
 * (`default` or `plan`, discovered from `collaborationMode/list`). Loom's
 * presets are views of that pair:
 *
 * | Loom    | collaboration | reviewer                     |
 * | ------- | ------------- | ---------------------------- |
 * | auto    | default       | auto_review                  |
 * | default | default       | user (shown as "Manual")     |
 * | plan    | plan          | unchanged — the exit choice  |
 *
 * Sandbox policy is not part of a mode; the session's isolation configuration
 * owns it. A mode counts as effective only once Codex reports it — in a
 * start/resume reply or a `thread/settings/updated` notification — never on
 * the strength of an update's acknowledgement.
 */
import type { SessionMode } from "@loom/core/types";

export type CodexAgentMode = "auto" | "default" | "plan";
/** What Plan hands back to: the reviewer Codex kept while planning. */
export type CodexExecutionMode = Exclude<CodexAgentMode, "plan">;
type Collaboration = "default" | "plan";
type Reviewer = "user" | "auto_review";

/** The modes a Codex session offers, in the order the TUI cycles them. */
export const CODEX_PERMISSION_MODES: SessionMode[] = ["default", "plan", "auto"];

/**
 * Loom's mode vocabulary mapped onto Codex's presets, explicitly. `acceptEdits`
 * has no native counterpart: its old Codex translation (on-request approvals
 * reviewed by the user) is exactly Manual's, and Codex cannot auto-approve
 * edits alone. A requested or saved `acceptEdits` therefore selects Manual, and
 * the session reports `default` from then on rather than a duplicate choice.
 */
export const codexAgentMode = (mode: SessionMode): CodexAgentMode =>
  mode === "acceptEdits" ? "default" : mode;

export const reviewerFor = (mode: CodexExecutionMode): Reviewer =>
  mode === "auto" ? "auto_review" : "user";

const collaborationOf = (value: unknown): Collaboration | null => {
  const mode = (value as { mode?: unknown } | null | undefined)?.mode;
  return mode === "default" || mode === "plan" ? mode : null;
};
const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

interface Effective {
  collaboration: Collaboration | null;
  approvalPolicy: unknown;
  reviewer: Reviewer | null;
  model: string | null;
  effort: string | null;
}

interface Waiter {
  target: CodexAgentMode;
  resolve(): void;
  reject(error: Error): void;
}

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Effective native settings for one thread, and the observation of changes to them. */
export class CodexNativeModes {
  readonly #timeoutMs: number;
  /** Discovered presets and their default reasoning effort; empty until discovery. */
  #presets = new Map<Collaboration, string | null>();
  #effective: Effective | null = null;
  readonly #waiters = new Set<Waiter>();
  #closed: Error | null = null;

  constructor(timeoutMs = 5_000) {
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Ask Codex which collaboration presets it offers. An absent, failed or
   * malformed catalogue leaves the missing presets unavailable; the returned
   * diagnostic is for the user, and nothing is substituted for them.
   */
  async discover(request: Request): Promise<string | null> {
    let data: unknown;
    try {
      data = ((await request("collaborationMode/list", {})) as { data?: unknown } | null)?.data;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return `Codex did not list its collaboration modes (${reason}); agent mode changes are unavailable.`;
    }
    if (!Array.isArray(data))
      return "Codex returned a malformed collaboration mode list; agent mode changes are unavailable.";
    const presets = new Map<Collaboration, string | null>();
    for (const item of data) {
      const mode = collaborationOf(item);
      if (!mode) continue;
      if (presets.has(mode))
        return `Codex listed the ${mode} collaboration mode twice; agent mode changes are unavailable.`;
      presets.set(mode, text((item as Record<string, unknown>)["reasoning_effort"]));
    }
    this.#presets = presets;
    const missing = (["default", "plan"] as const).filter((mode) => !presets.has(mode));
    if (!missing.length) return null;
    return missing.includes("default")
      ? "Codex did not offer its default collaboration mode; Auto and Manual cannot be selected."
      : "Codex did not offer a Plan collaboration mode; Plan cannot be selected.";
  }

  /**
   * Seed from a `thread/start` or `thread/resume` reply. A new thread is in
   * Default collaboration (Codex's start reply never carries the field); a
   * resume reply that omits it leaves the collaboration mode unknown.
   */
  initialize(reply: unknown, fresh: boolean): void {
    const r = (reply ?? {}) as Record<string, unknown>;
    this.#apply({
      ...r,
      effort: r["reasoningEffort"],
      collaborationMode: r["collaborationMode"] ?? (fresh ? { mode: "default" } : null),
    });
  }

  /** A `thread/settings/updated` notification's complete thread settings. */
  observe(settings: unknown): void {
    if (typeof settings !== "object" || settings === null) return;
    this.#apply(settings as Record<string, unknown>);
    for (const waiter of this.#waiters)
      if (this.mode === waiter.target) {
        this.#waiters.delete(waiter);
        waiter.resolve();
      }
  }

  #apply(s: Record<string, unknown>): void {
    const reviewer = s["approvalsReviewer"];
    this.#effective = {
      collaboration: collaborationOf(s["collaborationMode"]),
      approvalPolicy: s["approvalPolicy"],
      reviewer: reviewer === "user" || reviewer === "auto_review" ? reviewer : null,
      model: text(s["model"]),
      effort: text(s["effort"]),
    };
  }

  /** Whether Codex has reported the collaboration mode at all. */
  get collaborationKnown(): boolean {
    return this.#effective?.collaboration != null;
  }

  /** The Loom mode Codex reports, or null when its settings don't name one. */
  get mode(): CodexAgentMode | null {
    const collaboration = this.#effective?.collaboration;
    if (collaboration === "plan") return "plan";
    return collaboration === "default" ? this.executionMode : null;
  }

  /** The reviewer-defined choice — current outside Plan, remembered inside it. */
  get executionMode(): CodexExecutionMode | null {
    const e = this.#effective;
    if (e?.approvalPolicy !== "on-request" || !e.reviewer) return null;
    return e.reviewer === "auto_review" ? "auto" : "default";
  }

  /**
   * `thread/settings/update` parameters selecting `target`, or null when Codex
   * already reports it: a native no-op is acknowledged without a settings
   * notification, so there would be nothing to observe. Plan omits the
   * reviewer so the execution choice survives planning; Auto and Manual set it
   * explicitly and explicitly leave Plan. No variant touches the sandbox.
   */
  updateFor(
    target: CodexAgentMode,
    model: string | null,
    effort: string | null,
  ): Record<string, unknown> | null {
    if (this.mode === target) return null;
    const collaboration: Collaboration = target === "plan" ? "plan" : "default";
    if (!this.#presets.has(collaboration))
      throw new Error(
        collaboration === "plan"
          ? "Codex does not offer a Plan collaboration mode"
          : "Codex does not offer its default collaboration mode",
      );
    const settingsModel = model || this.#effective?.model;
    if (!settingsModel) throw new Error("Codex has not reported this thread's model");
    return {
      approvalPolicy: "on-request",
      ...(target === "plan" ? {} : { approvalsReviewer: reviewerFor(target) }),
      collaborationMode: {
        mode: collaboration,
        settings: {
          model: settingsModel,
          reasoning_effort:
            this.#presets.get(collaboration) ?? effort ?? this.#effective?.effort ?? null,
          // null selects the preset's built-in instructions.
          developer_instructions: null,
        },
      },
    };
  }

  /**
   * Watch for Codex reporting `target` as effective. Register before sending
   * the update: Codex may deliver the notification on either side of its
   * acknowledgement. `wait()` — called once the update is acknowledged —
   * bounds the remaining wait; it rejects on timeout or when the connection
   * closes. `cancel()` abandons the watch (e.g. the update was rejected).
   */
  until(target: CodexAgentMode): { wait(): Promise<void>; cancel(): void } {
    const settled = Promise.withResolvers<void>();
    // Handled here so a rejection before `wait()` is never reported as unhandled.
    settled.promise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter: Waiter = {
      target,
      resolve: () => {
        clearTimeout(timer);
        settled.resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        settled.reject(error);
      },
    };
    if (this.#closed) waiter.reject(this.#closed);
    else this.#waiters.add(waiter);
    return {
      wait: () => {
        if (this.#waiters.has(waiter))
          timer = setTimeout(() => {
            this.#waiters.delete(waiter);
            waiter.reject(
              new Error(
                `Codex acknowledged the change but did not report the ${target} mode as effective`,
              ),
            );
          }, this.#timeoutMs);
        return settled.promise;
      },
      cancel: () => {
        this.#waiters.delete(waiter);
        clearTimeout(timer);
      },
    };
  }

  /** The connection is gone: nothing more will be observed. */
  close(error: Error): void {
    this.#closed = error;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }
}
