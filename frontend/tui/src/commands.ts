/**
 * The TUI's command model. One description per command decides whether it is
 * shown, whether it can run and why not, its key, its label and whether the
 * key bar carries it. Keyboard dispatch, the Space palette, the bottom key bar
 * and clicks on that bar all read {@link describeCommands}; none of them keeps
 * a list of its own.
 *
 * A description is bound to the session it was made for (`target`). Whatever
 * activates it later — a palette pick, a click — hands that target back, and
 * the handle describes the command again for it before running. A selection
 * that moved in between is never acted on in the original target's place, and
 * a target that changed state gets the new disabled reason instead of the run.
 *
 * Adding a command is one entry in {@link COMMANDS} plus its availability in
 * {@link sessionAvailability} or {@link otherAvailability}; nothing else
 * needs to learn about it.
 */
import stringWidth from "string-width";
import { absurd } from "@loom/core/absurd";
import type { SessionSnapshot } from "@loom/core/wire";
import type { QueueEntryView } from "@loom/core/message-queue";
import type { KeyLike } from "./editor.ts";
import { liveQNav, questionsOf } from "./interactions.ts";
import { nextThemeMode } from "./theme.ts";
import { startingForkOf } from "./fork-flow.ts";
import {
  cycleProfile,
  cycleWorkspace,
  newBase,
  newWorkspace,
  toggleBase,
} from "./new-workspace.ts";
import { openPrompt } from "./overlay.ts";
import {
  childrenOf,
  defaultProviderId,
  fleetAgentProfiles,
  fleetProviders,
  fleetSessions,
  modelPickItems,
  modelSupportsEffort,
  newSettings,
  providerInfo,
  queueFor,
  selectedSession,
  type TuiState,
} from "./model.ts";

/** `session` commands act on their target; `view` ones on what is on screen;
 *  `app` ones on the UI or the daemon. */
export type CommandScope = "session" | "view" | "app";

interface CommandSpec {
  readonly scope: CommandScope;
  /** The shortcut as shown and as dispatched; "" for palette-only commands.
   *  Absent: not offered on the fleet at all (nor in the palette). */
  readonly keys?: string;
  /** Further keys that dispatch it (shown nowhere). */
  readonly aliases?: readonly string[];
  /** Its key while a send composer is open on the target. Absent: the command
   *  is not reachable from the composer, whose plain keys type text. */
  readonly composer?: string;
  /** Its key in the target's queue view; absent: not offered there. */
  readonly queue?: string;
  /** Its key in the new-session prompt; absent: not offered there. */
  readonly newSession?: string;
  readonly label: string;
  readonly description: string;
}

/**
 * Every command, in palette and key-bar order: request decisions first (the
 * most salient thing a session can need), then the session's other verbs,
 * then the view, then the application.
 */
const COMMANDS = {
  approve: {
    scope: "session",
    keys: "a",
    label: "approve",
    description: "Allow the pending permission request.",
  },
  answer: {
    scope: "session",
    keys: "⏎",
    aliases: ["a"],
    label: "answer",
    description: "Answer the pending question.",
  },
  planreview: {
    scope: "session",
    keys: "⏎",
    aliases: ["a"],
    label: "review plan",
    description: "Open the pending plan review.",
  },
  deny: {
    scope: "session",
    keys: "d",
    label: "deny",
    description: "Deny the pending request, with an optional reason.",
  },
  interrupt: {
    scope: "session",
    keys: "i",
    composer: "⌥i",
    label: "interrupt",
    description: "Stop the current turn, including outstanding background work.",
  },
  send: {
    scope: "session",
    keys: "⏎",
    label: "send",
    description:
      "Message the session. Mid-turn it waits in the queue for the next tool boundary; a stopped session is revived first.",
  },
  enqueueEndOfTurn: {
    scope: "session",
    composer: "⌥q",
    label: "queued send",
    description: "Queue the message for when the agent has finished, background work included.",
  },
  queue: {
    scope: "session",
    keys: "q",
    label: "queue",
    description:
      "Review the session's queued messages: edit, reorder, switch, send now or remove them.",
  },
  queueEdit: {
    scope: "session",
    queue: "e",
    label: "edit",
    description: "Edit the selected message in the composer; ⏎ saves it.",
  },
  queueRemove: {
    scope: "session",
    queue: "x",
    label: "remove",
    description: "Remove the selected message from the queue.",
  },
  queueMoveUp: {
    scope: "session",
    queue: "⇧↑",
    aliases: ["K"],
    label: "move up",
    description: "Move the selected message up within its group.",
  },
  queueMoveDown: {
    scope: "session",
    queue: "⇧↓",
    aliases: ["J"],
    label: "move down",
    description: "Move the selected message down within its group.",
  },
  queueToggleDelivery: {
    scope: "session",
    queue: "t",
    label: "switch",
    description: "Switch the selected message between the next tool boundary and turn end.",
  },
  queueSendNow: {
    scope: "session",
    queue: "s",
    label: "send now",
    description:
      "Hand the selected message over now: at the head of the next boundary, or as a turn of its own when idle or held.",
  },
  queueRelease: {
    scope: "session",
    keys: "",
    queue: "r",
    label: "release the queue",
    description: "Let a held queue go on by its ordinary rules; uncertain messages stay.",
  },
  compact: {
    scope: "session",
    keys: "c",
    label: "compact",
    description: "Summarise the context window, optionally steered by a note.",
  },
  keepwarm: {
    scope: "session",
    keys: "",
    label: "keep cache warm",
    description: "Re-prime the prompt cache before its lifetime lapses.",
  },
  done: {
    scope: "session",
    keys: "x",
    label: "archive",
    description: "Archive the session — its branch and chat are kept.",
  },
  shell: {
    scope: "session",
    keys: "s",
    label: "open shell",
    description: "Open a shell in the session's workspace; exit to return.",
  },
  mode: {
    scope: "session",
    keys: "⇧⇥",
    composer: "⇧⇥",
    label: "mode",
    description: "Cycle the permission mode.",
  },
  model: {
    scope: "session",
    keys: "⌥m",
    composer: "⌥m",
    label: "model",
    description: "Switch the model; it applies from the next turn.",
  },
  effort: {
    scope: "session",
    keys: "⌥t",
    composer: "⌥t",
    label: "effort",
    description: "Switch the thinking-effort level.",
  },
  provider: {
    scope: "session",
    keys: "⌥p",
    composer: "⌥p",
    label: "provider",
    description: "Switch the provider and model.",
  },
  undo: {
    scope: "session",
    keys: "u",
    label: "undo",
    description: "Rewind to an earlier turn and edit its message.",
  },
  fork: {
    scope: "session",
    keys: "F",
    label: "fork",
    description:
      "Start a new session from this one: native history or a portable handoff to any provider, in a copied or shared workspace.",
  },
  rebase: {
    scope: "session",
    keys: "r",
    label: "rebase onto base",
    description: "Replay the session's branch onto its base branch.",
  },
  title: { scope: "session", keys: "e", label: "rename", description: "Rename the session." },
  comment: {
    scope: "session",
    keys: "",
    label: "add comment",
    description: "A note on the session, outside its transcript.",
  },
  copybranch: {
    scope: "session",
    keys: "y",
    label: "copy branch",
    description: "Copy the session's branch name to the clipboard.",
  },
  copyid: {
    scope: "session",
    keys: "Y",
    label: "copy session id",
    description: "Copy the session's id to the clipboard.",
  },
  clearqueue: {
    scope: "session",
    keys: "⌥x",
    composer: "⌥x",
    queue: "c",
    label: "clear the queued messages",
    description: "Drop the messages waiting in the session's queue, after a confirm.",
  },
  delete: {
    scope: "session",
    keys: "X",
    label: "delete",
    description: "Delete the session with its worktree and transcript.",
  },
  childExit: {
    scope: "view",
    keys: "←",
    label: "fleet",
    description: "Step back out of the session's sub-agents and tasks.",
  },
  childEnter: {
    scope: "view",
    keys: "→",
    label: "inspect",
    description: "Drill into the session's sub-agents and background tasks.",
  },
  viewlog: {
    scope: "view",
    keys: "o",
    label: "open in $EDITOR",
    description: "Open the active tab or the pending request in $EDITOR, read-only.",
  },
  chat: { scope: "view", keys: "1", label: "chat tab", description: "Show the session's chat." },
  changes: {
    scope: "view",
    keys: "2",
    label: "changes tab",
    description: "Show the working tree and the changes since the branch point.",
  },
  monitor: {
    scope: "view",
    keys: "3",
    label: "monitor tab",
    description: "Show session activity and resource counters.",
  },
  layout: {
    scope: "view",
    keys: "⇥",
    label: "toggle fleet list",
    description: "Switch between the overview and the full-width session.",
  },
  filter: {
    scope: "view",
    keys: "v",
    label: "verbosity",
    description: "Cycle the chat between full, chat only and chat with tool calls.",
  },
  refreshModels: {
    scope: "view",
    keys: "",
    label: "refresh models",
    description:
      "Rediscover the selected session's provider's models (the default provider's with none selected); ⌥r in a model picker.",
  },
  new: { scope: "app", keys: "n", label: "new", description: "Start a new session." },
  newProfile: {
    scope: "app",
    newSession: "⌥a",
    label: "profile",
    description:
      "Cycle the agent profile the new session starts on: its provider, model, effort and mode (still changeable), prompt and tools. None is today's settings.",
  },
  newWorkspace: {
    scope: "app",
    newSession: "⌥w",
    label: "workspace",
    description:
      "Cycle where the new session works: its own worktree, a private clone (VM only) or in place in the repository checkout.",
  },
  newBase: {
    scope: "app",
    newSession: "⌥b",
    label: "base",
    description:
      "Switch what the new session branches from: the checked-out branch (or commit) or the repository's default branch. The session keeps it.",
  },
  find: {
    scope: "app",
    keys: "/",
    label: "find",
    description: "Filter the fleet by title and transcript text.",
  },
  quit: {
    scope: "app",
    keys: "⌃c",
    label: "quit",
    description: "Quit the UI; the daemon and its sessions keep running.",
  },
  palette: {
    scope: "app",
    keys: "␣",
    label: "more",
    description: "Every command, with why it is unavailable when it is.",
  },
  theme: { scope: "app", keys: "t", label: "cycle theme", description: "Cycle the colour theme." },
  doctor: {
    scope: "app",
    keys: "",
    label: "doctor",
    description: "Show the tools, connectors and daemon vitals a new session gets.",
  },
  prepareEnvironment: {
    scope: "app",
    keys: "",
    label: "Prepare repo environment",
    description:
      "Warm the dependency cache for future sessions: runs `loom vm prepare` with live output.",
  },
  switchRepository: {
    scope: "app",
    keys: "",
    label: "Switch repository",
    description: "Open a recently used repository; sessions here keep running.",
  },
  logs: {
    scope: "app",
    keys: "",
    label: "view logs",
    description: "Open the tail of the daemon and TUI logs in $EDITOR, read-only.",
  },
  gc: {
    scope: "app",
    keys: "",
    label: "gc worktrees",
    description: "Remove the worktrees of archived sessions; rows and branches stay.",
  },
  restart: {
    scope: "app",
    keys: "R",
    label: "restart the daemon",
    description: "Restart the daemon.",
  },
  quitall: {
    scope: "app",
    keys: "",
    label: "Quit and stop the daemon",
    description: "Quit the UI and stop the daemon, interrupting live sessions, after a confirm.",
  },
} as const satisfies Record<string, CommandSpec>;

export type ActName = keyof typeof COMMANDS;
const ORDER = Object.keys(COMMANDS) as ActName[];

/** Client capabilities some commands need; omitted ones count as available. */
export interface CommandFeatures {
  readonly logs: boolean;
  readonly shell: boolean;
  readonly prepareEnvironment: boolean;
  readonly switchRepository: boolean;
}

/** Everything availability reads: the UI state and what this client can do.
 *  A session's queue comes off its snapshot. */
export type CommandContext = TuiState & {
  readonly features?: Partial<CommandFeatures>;
};

/** One command as it stands for one target, right now. */
export interface CommandAction {
  readonly id: ActName;
  readonly scope: CommandScope;
  /** The key for the surface it was described for ("" = palette only). */
  readonly keys: string;
  readonly label: string;
  readonly description: string;
  /** The session the action acts on — the one it was described for. */
  readonly target: string | null;
  /** Why it cannot run; absent when it can. */
  readonly disabled?: string;
  /** Whether the bottom key bar carries it (while enabled). */
  readonly bar: boolean;
}

/** Where the actions are offered: the fleet, an open send composer, the
 *  target's queue view, or the new-session prompt. */
export type CommandSurface = "browse" | "composer" | "queue" | "newSession";

/** The queue entry the queue view has selected for `sessionId` — the one its
 *  entry commands act on — or null when none is (or the view is not open). */
export const queueSelection = (
  ctx: Pick<TuiState, "fleet" | "overlay">,
  sessionId: string,
): QueueEntryView | null => {
  if (ctx.overlay.t !== "queue" || ctx.overlay.sessionId !== sessionId) return null;
  const entries = queueFor(ctx, sessionId);
  const selected = ctx.overlay.selected;
  return entries.find((e) => e.id === selected) ?? entries[0] ?? null;
};

/** Entries a clear can take: still in Loom, or handed over with their fate unknown. */
export const clearable = (entries: readonly QueueEntryView[]): QueueEntryView[] =>
  entries.filter((e) => e.state === "queued" || e.uncertain);

const ALREADY_HANDED = "Already handed to the agent.";

/** Per-command availability: `null` hides the command. */
type Availability = {
  disabled?: string | undefined;
  bar?: boolean;
  label?: string;
} | null;

const first = (...reasons: (string | false | null | undefined)[]): string | undefined =>
  reasons.find((r): r is string => typeof r === "string" && r !== "");

const BUSY = new Set(["running", "starting", "working_background"]);

/** Why the target cannot take any session command, or null when it can. */
const targetGone = (
  ctx: CommandContext,
  target: string | null,
  s: SessionSnapshot | null,
): string | null => {
  if (target === null) return "Select a session first.";
  if (!s) return "That session is no longer in the fleet.";
  if (ctx.archiving.includes(s.id)) return "Archiving…";
  return null;
};

/** The pending decision that blocks ordinary session work, phrased as what to do. */
const requestFirst = (s: SessionSnapshot): string | undefined => {
  if (s.status.kind !== "awaiting_input") return undefined;
  switch (s.status.on) {
    case "question":
    case "user_question":
      return "Answer the pending question first.";
    case "plan_review":
      return "Review the pending plan first.";
    default:
      return "Approve or deny the pending request first.";
  }
};

/** The provider Refresh models acts on for `target`: that session's, else
 *  the default one. A model picker refreshes its own provider instead. */
export const refreshProvider = (ctx: CommandContext, target: string | null): string | null => {
  const s = target === null ? undefined : fleetSessions(ctx).find((x) => x.id === target);
  if (s) return s.provider;
  return fleetProviders(ctx).length > 0 ? defaultProviderId(ctx) : null;
};

/** Refresh models for one provider as it stands: the action it would take
 *  (a running refresh turns it into a cancel), its label, and why not. The
 *  palette command and a model picker's ⌥r both read this. */
export interface ModelRefresh {
  readonly provider: string | null;
  readonly cancel: boolean;
  readonly label: string;
  readonly disabled?: string;
}
export const modelRefresh = (ctx: CommandContext, provider: string | null): ModelRefresh => {
  const p = provider === null ? null : providerInfo(ctx, provider);
  if (ctx.fleet.tag !== "data")
    return { provider, cancel: false, label: "refresh models", disabled: "Not connected." };
  if (!p)
    return {
      provider,
      cancel: false,
      label: "refresh models",
      disabled: "No provider to refresh.",
    };
  const tag = p.tag || p.id;
  if (p.modelsRefreshUnavailable)
    return {
      provider,
      cancel: false,
      label: `refresh models · ${tag}`,
      disabled: p.modelsRefreshUnavailable,
    };
  if (p.modelsLoading) return { provider, cancel: true, label: `cancel model refresh · ${tag}` };
  if (p.modelsError) return { provider, cancel: false, label: `retry model refresh · ${tag}` };
  return { provider, cancel: false, label: `refresh models · ${tag}` };
};

const noModels = (ctx: CommandContext, s: SessionSnapshot): string | undefined =>
  modelPickItems(ctx, s.provider).length === 0 && !providerInfo(ctx, s.provider)?.modelsLoading
    ? `${s.provider} has no alternate models`
    : undefined;

/** Availability of a session command for a present, non-archiving target. */
const sessionAvailability = (
  ctx: CommandContext,
  id: ActName,
  s: SessionSnapshot,
): Availability => {
  const kind = s.status.kind;
  const on = s.status.kind === "awaiting_input" ? s.status.on : null;
  const permission =
    on !== null && on !== "question" && on !== "user_question" && on !== "plan_review";
  const stopping = first(
    s.stopping && "Waiting for the interrupt to settle.",
    s.stopFailed && "Retry the interrupt first.",
  );
  const request = requestFirst(s);
  const readOnly =
    s.resumable === false
      ? (s.resumeBlockedReason ?? "This session is read-only; fork to continue.")
      : undefined;
  const settled = first(stopping, request);
  // Drilled into one of the target's child rows, the verbs that read as acting
  // on that child — talking, stopping, steering, renaming, removing — are
  // withheld: children carry no actions of their own, and these would quietly
  // act on the parent instead. The session's pending request (drawn for the
  // whole session, and often a sub-agent's own ask) and the workspace / branch
  // / id verbs, which name the session outright, stay.
  const child = ctx.selectedChild != null && s.id === ctx.selectedId;
  const onChild = (what: string): string | undefined =>
    child ? `Select the session row (←) to ${what}.` : undefined;
  const queue = queueFor(ctx, s.id);
  switch (id) {
    case "approve":
      return {
        disabled: first(stopping, !permission && "No permission request pending."),
        bar: true,
      };
    case "answer":
      return on === "question" || on === "user_question" ? { disabled: stopping, bar: true } : null;
    case "planreview":
      return on === "plan_review" ? { disabled: stopping, bar: true } : null;
    case "deny":
      return {
        disabled: first(
          stopping,
          !(permission || on === "user_question") && "No permission request pending.",
        ),
        bar: true,
      };
    case "interrupt": {
      let label = "interrupt";
      if (s.stopping) label = "stopping…";
      else if (s.stopFailed) label = "retry interrupt";
      const live = s.stopping || s.stopFailed || BUSY.has(kind) || on !== null;
      return {
        label,
        disabled: first(onChild("interrupt the session"), !live && "Nothing is running."),
        bar: true,
      };
    }
    case "send":
    case "enqueueEndOfTurn": {
      // Mid-turn a message waits in the queue for the next tool boundary;
      // ⌥q waits for the agent to finish (a plain send on an idle target).
      const busy = kind === "running" || kind === "starting" || kind === "awaiting_input";
      let label = "queued send";
      if (id === "send") label = busy ? "queue · next tool boundary" : "send";
      return {
        label,
        disabled: first(
          onChild("talk to the session"),
          settled,
          kind === "starting" && "The session is still starting.",
          readOnly,
        ),
        bar: true,
      };
    }
    case "queue": {
      const n = queue.length;
      const held = s.queue?.hold != null;
      let label = "queue";
      if (held) label = `${n} held`;
      else if (n > 0) label = `queue ${n}`;
      return {
        label,
        disabled: first(
          onChild("review the session's queue"),
          n === 0 && !held && "No queued messages.",
        ),
        bar: n > 0 || held,
      };
    }
    case "queueEdit":
    case "queueRemove":
    case "queueMoveUp":
    case "queueMoveDown":
    case "queueToggleDelivery":
    case "queueSendNow": {
      const e = queueSelection(ctx, s.id);
      if (!e) return { disabled: first(onChild("edit the queue"), "No message selected.") };
      const handed = e.state !== "queued" && !e.uncertain && ALREADY_HANDED;
      const queued = e.state !== "queued" && ALREADY_HANDED;
      const group = queue.filter((x) => x.delivery === e.delivery);
      const at = group.findIndex((x) => x.id === e.id);
      switch (id) {
        case "queueEdit":
          return { disabled: first(onChild("edit the queue"), queued), bar: true };
        case "queueRemove":
          return { disabled: first(onChild("edit the queue"), handed), bar: true };
        case "queueMoveUp":
          return {
            disabled: first(onChild("edit the queue"), queued, at <= 0 && "First in its group."),
            bar: true,
          };
        case "queueMoveDown":
          return {
            disabled: first(
              onChild("edit the queue"),
              queued,
              at >= group.length - 1 && "Last in its group.",
            ),
            bar: true,
          };
        case "queueToggleDelivery":
          return {
            label: e.delivery === "next_boundary" ? "queued send" : "next boundary",
            disabled: first(onChild("edit the queue"), queued),
            bar: true,
          };
        default:
          return {
            label: e.uncertain ? "send again" : "send now",
            disabled: first(onChild("edit the queue"), request, handed),
            bar: true,
          };
      }
    }
    case "queueRelease":
      return {
        disabled: first(
          onChild("release the session's queue"),
          s.queue?.hold == null && "The queue is not held.",
        ),
      };
    case "compact": {
      // Legal on any live session; the bar suggests it once the meter passes
      // half, when it is worth reaching for.
      const half = s.contextLimit > 0 && s.contextUsed / s.contextLimit > 0.5;
      return {
        disabled: first(
          onChild("compact the session"),
          settled,
          readOnly,
          !["running", "idle", "working_background"].includes(kind) &&
            "Compaction needs a running or idle session.",
        ),
        bar: half,
      };
    }
    case "keepwarm":
      return {
        label: s.keepWarm ? "stop keeping cache warm" : "keep cache warm",
        disabled: first(
          onChild("change the session's cache"),
          settled,
          readOnly,
          kind !== "running" && kind !== "idle" && "Keep-warm needs a running or idle session.",
          s.cache.ttlMinutes <= 0 && "No known cache lifetime to keep warm.",
        ),
      };
    case "done":
      return {
        disabled: first(
          onChild("archive the session"),
          settled,
          kind === "done" && "Already archived.",
          !["idle", "error", "interrupted", "done"].includes(kind) &&
            "Interrupt the session before archiving it.",
        ),
        bar: true,
      };
    case "shell":
      return {
        disabled: first(
          stopping,
          kind === "starting" && "The session is still starting.",
          !s.inPlace && !s.worktree && "This session has no workspace.",
          s.isolation === "vm" && kind === "done" && "An archived VM session has no shell.",
          ctx.features?.shell === false && "Shell access is unavailable in this client",
        ),
      };
    case "mode":
      return {
        disabled: first(
          onChild("change the session's mode"),
          settled,
          readOnly,
          // The provider's own modes (`SessionSnapshot.modes`) are what ⇧⇥ walks.
          s.modes !== undefined &&
            s.modes.filter((m) => m !== s.mode).length === 0 &&
            `${s.provider} offers no other permission mode`,
        ),
      };
    case "model":
      return {
        disabled: first(onChild("switch the session's model"), settled, readOnly, noModels(ctx, s)),
      };
    case "effort":
      return {
        disabled: first(
          onChild("change the session's effort"),
          settled,
          readOnly,
          (!s.model || !modelSupportsEffort(ctx, s.provider, s.model)) &&
            `${s.provider}${s.model ? `/${s.model}` : ""} has no thinking-effort control`,
        ),
      };
    case "provider":
      return {
        disabled: first(
          onChild("switch the session's provider"),
          settled,
          readOnly,
          BUSY.has(kind) && "Interrupt the turn before switching provider.",
          // With one provider there is nothing to pick: it opens the models.
          fleetProviders(ctx).length <= 1 && noModels(ctx, s),
        ),
      };
    case "undo":
      return {
        disabled: first(
          onChild("undo a turn"),
          settled,
          readOnly,
          !s.canRewind && "This provider cannot rewind.",
          kind !== "idle" && kind !== "interrupted" && "Undo needs a stopped or idle session.",
          s.turns < 1 && "Nothing to undo yet.",
        ),
      };
    case "fork":
      // A fork of this session still starting: the command cancels it.
      if (startingForkOf(ctx, s))
        return { label: "cancel fork", disabled: onChild("cancel the fork") };
      return {
        disabled: first(
          onChild("fork the session"),
          settled,
          s.inPlace && s.resumable !== false && "An in-place session cannot be forked.",
          !["idle", "interrupted", "done", "error"].includes(kind) &&
            "Stop the turn before forking; a fork copies a settled conversation.",
        ),
        // A read-only session continues only through a fork: say so up front.
        bar: s.resumable === false,
      };
    case "rebase": {
      const behind = s.git?.behindBase ?? 0;
      return {
        // Offered even when `behindBase` reads 0: that count lags a base branch
        // moved outside Loom, and the RPC is a harmless no-op when current.
        label: behind > 0 ? `rebase onto base (-${behind})` : "rebase onto base",
        disabled: first(settled, readOnly, !s.worktree && "This session has no worktree."),
      };
    }
    case "title":
      return { disabled: first(onChild("rename the session"), settled) };
    case "delete":
      return { disabled: first(onChild("delete the session"), settled) };
    case "copyid":
      return { disabled: settled };
    case "comment":
      return {
        label: s.comment ? "edit comment" : "add comment",
        disabled: first(onChild("comment on the session"), settled),
      };
    case "copybranch":
      return {
        disabled: first(settled, !s.branch && !s.worktree && "This session has no branch."),
      };
    case "clearqueue": {
      const n = clearable(queue).length;
      return {
        ...(n > 0 ? { label: `clear ${n} queued` } : {}),
        disabled: first(onChild("clear the session's queue"), n === 0 && "No queued messages."),
      };
    }
    default:
      return {};
  }
};

/** Availability of a `view` / `app` command. */
const otherAvailability = (
  ctx: CommandContext,
  id: ActName,
  target: string | null,
): Availability => {
  const sel = selectedSession(ctx);
  const features = ctx.features ?? {};
  switch (id) {
    case "childEnter":
      return sel && target === sel.id && ctx.selectedChild == null && childrenOf(sel).length > 0
        ? { bar: true }
        : null;
    case "childExit":
      return ctx.selectedChild != null ? { bar: true } : null;
    case "viewlog":
      // It opens what the screen shows, so only for the session on screen.
      return { disabled: target !== ctx.selectedId ? "Select the session to view it." : undefined };
    case "layout":
      return { disabled: sel ? undefined : "Select a session first." };
    case "refreshModels": {
      const r = modelRefresh(ctx, refreshProvider(ctx, target));
      return { label: r.label, disabled: r.disabled };
    }
    case "new":
    case "find":
    case "quit":
    case "palette":
      return { bar: true };
    case "newProfile": {
      const p = openPrompt(ctx.overlay);
      if (p?.t !== "new") return null;
      const profiles = fleetAgentProfiles(ctx);
      const step = cycleProfile(
        profiles,
        fleetProviders(ctx),
        p.settings,
        newSettings(ctx, null, null, null),
      );
      if ("disabled" in step) return { disabled: step.disabled };
      return { label: `profile → ${step.settings.profile ?? "none"}` };
    }
    case "newWorkspace": {
      const p = openPrompt(ctx.overlay);
      if (p?.t !== "new") return null;
      const provider = providerInfo(ctx, p.settings.provider ?? defaultProviderId(ctx));
      const step = cycleWorkspace(provider, p.settings);
      if ("disabled" in step) return { disabled: step.disabled };
      return { label: `workspace → ${newWorkspace(provider, step.settings)}` };
    }
    case "newBase": {
      const p = openPrompt(ctx.overlay);
      if (p?.t !== "new") return null;
      const step = toggleBase(ctx.bases, p.settings);
      if ("disabled" in step) return { disabled: step.disabled };
      return { label: `base → ${newBase(ctx.bases, step.settings)?.label ?? "default"}` };
    }
    case "theme":
      return { label: `switch to ${nextThemeMode(ctx.theme)} theme` };
    case "prepareEnvironment":
      return {
        disabled:
          features.prepareEnvironment === false
            ? "Environment preparation is unavailable in this client"
            : undefined,
      };
    case "switchRepository":
      return {
        disabled:
          features.switchRepository === false ? "Repository switching is unavailable" : undefined,
      };
    case "logs":
      return {
        disabled: features.logs === false ? "Logs aren't wired up in this session" : undefined,
      };
    case "gc":
      return {
        disabled: fleetSessions(ctx).some((x) => x.status.kind === "done" && x.worktree)
          ? undefined
          : "No archived session has a worktree left.",
      };
    default:
      return {};
  }
};

/**
 * Every command relevant to `target` (the selection by default) on `surface`,
 * in palette order, each with its availability. The composer surface offers
 * only the commands it binds, under their composer keys.
 */
export const describeCommands = (
  ctx: CommandContext,
  {
    target = ctx.selectedId,
    surface = "browse",
  }: {
    target?: string | null;
    surface?: CommandSurface;
  } = {},
): CommandAction[] => {
  const s = target === null ? null : (fleetSessions(ctx).find((x) => x.id === target) ?? null);
  const gone = targetGone(ctx, target, s);
  const out: CommandAction[] = [];
  for (const id of ORDER) {
    const spec: CommandSpec = COMMANDS[id];
    const keys = {
      browse: spec.keys,
      composer: spec.composer,
      queue: spec.queue,
      newSession: spec.newSession,
    }[surface];
    if (keys === undefined) continue;
    let a: Availability;
    if (spec.scope !== "session") a = otherAvailability(ctx, id, target);
    // Request-specific verbs are relevant only while that request is pending.
    else if (gone !== null) a = id === "answer" || id === "planreview" ? null : { disabled: gone };
    else a = sessionAvailability(ctx, id, s!);
    if (a === null) continue;
    out.push({
      id,
      scope: spec.scope,
      keys,
      label: a.label ?? spec.label,
      description: spec.description,
      target: spec.scope === "app" ? null : target,
      ...(a.disabled ? { disabled: a.disabled } : {}),
      bar: a.bar ?? false,
    });
  }
  return out;
};

/** One command, described for `target` as it stands now; null when not relevant. */
export const describeCommand = (
  ctx: CommandContext,
  id: ActName,
  target: string | null,
  surface: CommandSurface = "browse",
): CommandAction | null =>
  describeCommands(ctx, { target, surface }).find((a) => a.id === id) ?? null;

/** The enabled command ids for the selection — the set the keymap will run. */
export const allowedActs = (ctx: CommandContext): Set<ActName> =>
  new Set(describeCommands(ctx).flatMap((a) => (a.disabled ? [] : [a.id])));

/** The key a press spells in the command table's notation. */
export const pressedKey = (input: string, key: KeyLike): string => {
  if (key.return) return "⏎";
  if (key.tab) return key.shift ? "⇧⇥" : "⇥";
  if (key.shift && key.upArrow) return "⇧↑";
  if (key.shift && key.downArrow) return "⇧↓";
  if (key.meta) return `⌥${input}`;
  return input === " " ? "␣" : input;
};

/**
 * The command a key press reaches: an enabled match first — `a` both approves
 * and answers, whichever applies — then a disabled one, so the caller can say
 * why. Ctrl never dispatches a command (it is the editor's).
 */
export const keyAction = (
  actions: readonly CommandAction[],
  input: string,
  key: KeyLike,
): CommandAction | null => {
  if (key.ctrl) return null;
  const pressed = pressedKey(input, key);
  if (pressed === "") return null;
  const matches = actions.filter((a) => {
    if (a.keys === pressed) return true;
    const aliases: readonly string[] | undefined = (COMMANDS[a.id] as CommandSpec).aliases;
    return aliases?.includes(pressed) ?? false;
  });
  return matches.find((a) => !a.disabled) ?? matches[0] ?? null;
};

/** The enabled command a key runs, or null. */
export const keyCommand = (
  actions: readonly CommandAction[],
  input: string,
  key: KeyLike,
): ActName | null => {
  const a = keyAction(actions, input, key);
  return a && !a.disabled ? a.id : null;
};

/** One key-bar chip. `command` makes it clickable; plain chips only inform. */
export interface BarItem {
  readonly keys: string;
  readonly label: string;
  readonly command?: { readonly id: ActName; readonly target: string | null };
}

/** A key-bar chip on screen: one row, columns `x0..x1` inclusive, 1-based —
 *  the space SGR mouse reports use. */
export interface BarHit {
  readonly kind: "bar";
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
  readonly command: { readonly id: ActName; readonly target: string | null };
}

/**
 * Where the clickable chips of a bar drawn by `Hints` (gap 1) land when its
 * row starts at column `x`: `keys label`, separated by ` · `. Measured from
 * the same items the bar draws, so a click resolves to the chip on screen;
 * chips past `right` (truncated away) are not targets.
 */
export const barHits = (
  items: readonly BarItem[],
  y: number,
  x: number,
  right: number,
): BarHit[] => {
  const out: BarHit[] = [];
  let at = x;
  items.forEach((item, i) => {
    if (i > 0) at += 3;
    const width = stringWidth(item.keys) + 1 + stringWidth(item.label);
    if (item.command && at <= right)
      out.push({
        kind: "bar",
        y,
        x0: at,
        x1: Math.min(right, at + width - 1),
        command: item.command,
      });
    at += width;
  });
  return out;
};

const chip = (a: CommandAction): BarItem => ({
  keys: a.keys,
  label: a.label,
  command: { id: a.id, target: a.target },
});

/**
 * The browse key bar: the enabled commands that earn a slot, in table order —
 * except the drill-down pair, which brackets the rest (`←` leads while drilled
 * in, `→` trails while there is something to drill into).
 */
export const browseBar = (ctx: CommandContext): BarItem[] => {
  const sel = selectedSession(ctx);
  if (sel && ctx.archiving.includes(sel.id))
    return [
      { keys: "", label: "archiving…" },
      { keys: "↑↓", label: "move" },
    ];
  const shown = describeCommands(ctx).filter((a) => a.bar && !a.disabled);
  const lead = shown.filter((a) => a.id === "childExit");
  const tail = shown.filter((a) => a.id === "childEnter");
  const rest = shown.filter((a) => a.id !== "childExit" && a.id !== "childEnter");
  return [...lead, ...rest, ...tail].map(chip);
};

/** The session commands an open send composer offers for its target — the same
 *  descriptions as the fleet's, under their composer keys, enabled ones only. */
export const composerBar = (ctx: CommandContext, target: string): BarItem[] =>
  describeCommands(ctx, { target, surface: "composer" })
    .filter((a) => !a.disabled)
    .map(chip);

/** The queue view's bar: its own selection keys, then the queue commands it
 *  binds for `target` that can run on the selected entry. */
export const queueBar = (ctx: CommandContext, target: string): BarItem[] => [
  { keys: "↑↓", label: "select" },
  ...describeCommands(ctx, { target, surface: "queue" })
    .filter((a) => !a.disabled)
    .map(chip),
  { keys: "esc", label: "back" },
];

/** The Space palette's rows for `target`: every relevant command but the
 *  palette itself, enabled ones first so a filter lands on something runnable. */
export const paletteActions = (ctx: CommandContext, target: string | null): CommandAction[] => {
  const all = describeCommands(ctx, { target }).filter((a) => a.id !== "palette");
  return [...all.filter((a) => !a.disabled), ...all.filter((a) => a.disabled)];
};

/**
 * The key bar for the current UI mode. `browse` is {@link browseBar}; every
 * overlay owns the screen and its own fixed keys, so the bar never advertises
 * a key the overlay won't accept. `prompt` returns `[]` — the composer draws
 * its own bar (see `FooterArea`).
 */
export const footerHints = (ctx: CommandContext): BarItem[] => {
  switch (ctx.overlay.t) {
    case "prompt":
      return [];
    case "picker": {
      const p = ctx.overlay.picker;
      // A model list offers its own provider's Refresh models.
      const refresh = p.step === "model" ? modelRefresh(ctx, p.chosen.provider) : null;
      return [
        { keys: "↑↓", label: "move" },
        { keys: "enter", label: "pick" },
        ...(refresh && !refresh.disabled
          ? [{ keys: "⌥r", label: refresh.cancel ? "cancel refresh" : "refresh models" }]
          : []),
        { keys: "esc", label: "cancel" },
      ];
    }
    case "confirm": {
      const c = ctx.overlay.confirm;
      const children =
        c.action === "archiveSession" || c.action === "deleteSession" ? c.children : undefined;
      return [
        { keys: "enter", label: "confirm" },
        ...(c.action === "deleteSession" && c.branchName
          ? [{ keys: "b", label: c.deleteBranch ? "keep branch" : "+ branch" }]
          : []),
        ...(children
          ? [{ keys: "c", label: children.choice === "stop" ? "detach agents" : "stop agents" }]
          : []),
        { keys: "esc", label: "cancel" },
      ];
    }
    case "plan":
      return [
        { keys: "i", label: "implement" },
        { keys: "f", label: "fresh" },
        { keys: "e", label: "edit" },
        { keys: "d", label: "discuss" },
        { keys: "⌥o / o", label: "view" },
      ];
    case "questions": {
      // The answer sheet's own keys (see `sheetKey`), by the step it is on.
      const { sessionId, requestId } = ctx.overlay;
      const nav = liveQNav(ctx.qnav, sessionId, requestId);
      const qs = questionsOf(fleetSessions(ctx), sessionId, requestId) ?? [];
      if (nav?.editing)
        return [
          { keys: "enter", label: "done" },
          { keys: "esc", label: "stop editing" },
        ];
      if ((nav?.idx ?? 0) >= qs.length)
        return [
          { keys: "enter", label: "submit answers" },
          { keys: "←", label: "questions" },
          { keys: "esc", label: "back" },
        ];
      return [
        { keys: "↑↓", label: "move" },
        { keys: "␣ / 1–9", label: "choose" },
        { keys: "⇥", label: "custom" },
        { keys: "enter", label: "next" },
        { keys: "←→", label: "questions" },
        { keys: "esc", label: "back" },
      ];
    }
    case "doctor":
      return [{ keys: "esc", label: "close" }];
    case "queue":
      return queueBar(ctx, ctx.overlay.sessionId);
    case "browse":
      return browseBar(ctx);
    default:
      return absurd(ctx.overlay);
  }
};
