/**
 * The fork wizard (`F`): provider → history → model / effort → workspace →
 * confirm. Each step is a picker whose destination carries the {@link ForkPlan}
 * settled so far; the model and effort steps are the shared catalogue steps
 * ({@link pickerStep}), so a fork offers exactly the rows and effort levels a
 * new session or a live switch would.
 *
 * Two kinds of fork, never blurred:
 *
 * - native history: the source's own provider resumes a copy of its history.
 *   Offered only on that provider, and only when the daemon says the session
 *   can (`nativeForkBlockedReason` absent).
 * - handoff: a fresh session on any available provider, opened with a summary
 *   of the visible conversation. Hidden provider state does not cross.
 */
import type { SessionSnapshot } from "@loom/core/wire";
import {
  makePicker,
  type ForkPlan,
  type Overlay,
  type PickItem,
  type Picker,
  pickerCurrent,
  unwind,
} from "./overlay.ts";
import { fleetProviders, fleetSessions, pickerStep, providerInfo, type TuiState } from "./model.ts";

type St = Pick<TuiState, "fleet">;

const sessionOf = (st: St, id: string): SessionSnapshot | undefined =>
  fleetSessions(st).find((x) => x.id === id);

const tagOf = (st: St, provider: string): string => providerInfo(st, provider)?.tag || provider;

/** A fork of `s` that is still starting; the fork command cancels it. */
export const startingForkOf = (st: St, s: SessionSnapshot): SessionSnapshot | undefined =>
  fleetSessions(st).find(
    (x) => x.parentId === s.id && x.forkTurn !== null && x.status.kind === "starting",
  );

/** Why a fork cannot share `s`'s worktree under `isolation` — the daemon's
 *  own rule, so the step can say so before anything is sent. */
export const shareBlockedReason = (
  s: SessionSnapshot,
  isolation: "vm" | "none",
): string | undefined => {
  if (s.checkout === "clone") return "A private clone cannot be shared; fork into a copy.";
  if (s.inPlace) return "An in-place session has no worktree of its own to share.";
  if (!s.worktree) return "The source has no worktree to share (it was archived).";
  if ((s.isolation ?? "none") !== "none" || isolation !== "none")
    return "Sharing a worktree needs Local isolation on both sessions.";
  return undefined;
};

/** Whether `provider` can take `s`'s native history. */
const nativeOn = (s: SessionSnapshot, provider: string): boolean =>
  provider === s.provider && s.resumable !== false && !s.nativeForkBlockedReason;

const forkPicker = (
  step: Picker["step"],
  title: string,
  items: PickItem[],
  fork: ForkPlan,
  pick?: string | null,
): Overlay => {
  const at = pick ? items.findIndex((it) => it.id === pick) : -1;
  return {
    t: "picker",
    picker: makePicker({
      step,
      title,
      items,
      dest: { t: "fork", fork },
      chosen: { provider: fork.provider, model: fork.model },
      index: Math.max(0, at),
    }),
  };
};

/** What a fork onto `provider` can carry, as the provider row says it. */
const providerHint = (s: SessionSnapshot, provider: string): string => {
  if (nativeOn(s, provider)) return "native history or handoff";
  if (provider !== s.provider) return "handoff · fresh session from a summary";
  return `handoff · ${s.nativeForkBlockedReason ?? s.resumeBlockedReason ?? "native history unavailable"}`;
};

const providerStep = (st: St, s: SessionSnapshot, fork: ForkPlan): Overlay =>
  forkPicker(
    "provider",
    "fork · provider",
    fleetProviders(st).map((p) => ({
      id: p.id,
      label: p.tag || p.id,
      hint: providerHint(s, p.id),
    })),
    { ...fork, provider: null, history: null, model: null, effort: null },
    fork.provider ?? s.provider,
  );

const historyStep = (st: St, s: SessionSnapshot, fork: ForkPlan): Overlay =>
  forkPicker(
    "forkHistory",
    `fork · history · ${tagOf(st, s.provider)}`,
    [
      {
        id: "native",
        label: "native history",
        hint: `${tagOf(st, s.provider)} resumes a copy of its own session${s.model ? ` · keeps ${s.model}` : ""}`,
      },
      {
        id: "handoff",
        label: "portable handoff",
        hint: "fresh session from a summary · hidden provider state is not carried",
      },
    ],
    { ...fork, history: null, model: null, effort: null },
    fork.history,
  );

const modelStep = (st: TuiState, fork: ForkPlan): Overlay =>
  pickerStep(st, "model", {
    dest: { t: "fork", fork: { ...fork, model: null, effort: null } },
    chosen: { provider: fork.provider, model: null },
    from: "model",
    pick: fork.model ?? sessionOf(st, fork.sessionId)?.model ?? null,
  });

/** The workspace step: copy (the default) or share the source's worktree. */
export const forkWorkspaceStep = (st: St, fork: ForkPlan): Overlay => {
  const s = sessionOf(st, fork.sessionId);
  if (!s) return { t: "browse" };
  const shareBlocked = shareBlockedReason(s, fork.isolation);
  return forkPicker(
    "forkWorkspace",
    "fork · workspace",
    [
      {
        id: "copy",
        label: "copy workspace",
        hint:
          s.checkout === "clone"
            ? "new private clone from the source's published branch"
            : "new worktree with the source's staged, unstaged and untracked work",
      },
      {
        id: "share",
        label: "share worktree",
        hint: `both sessions work in ${s.branch ?? "the source's worktree"}; the source keeps it`,
        ...(shareBlocked ? { disabled: shareBlocked } : {}),
      },
    ],
    { ...fork, workspace: null },
    fork.workspace,
  );
};

/** Open the wizard on `s`. With one provider there is nothing to pick first. */
export const startFork = (st: TuiState, s: SessionSnapshot): Overlay => {
  const fork: ForkPlan = {
    sessionId: s.id,
    provider: null,
    history: null,
    model: null,
    effort: null,
    workspace: null,
    isolation: s.isolation ?? "none",
  };
  const providers = fleetProviders(st);
  if (providers.length > 1) return providerStep(st, s, fork);
  return afterProvider(st, s, fork, providers[0]?.id ?? s.provider);
};

const afterProvider = (st: TuiState, s: SessionSnapshot, fork: ForkPlan, provider: string) => {
  const next = { ...fork, provider };
  if (nativeOn(s, provider)) return historyStep(st, s, next);
  return modelStep(st, { ...next, history: "handoff" });
};

/** Isolation is the user's to change only for a handoff into a copy: native
 *  history and a shared worktree both stay Local. */
export const forkIsolationLocked = (fork: ForkPlan): string | undefined => {
  if (fork.history === "native") return "Native history keeps Local isolation.";
  if (fork.workspace === "share") return "A shared worktree keeps Local isolation.";
  return undefined;
};

/** What the fork will do, in words, for the confirmation. */
export const forkSummary = (st: St, fork: ForkPlan): string => {
  const s = sessionOf(st, fork.sessionId);
  const provider = fork.provider ?? s?.provider ?? "";
  const tag = tagOf(st, provider);
  const settings = [fork.model ?? (fork.history === "native" ? s?.model : null), fork.effort]
    .filter(Boolean)
    .join(" · ");
  const history =
    fork.history === "native"
      ? `History: native — ${tag} resumes a copy of its own session${settings ? ` (${settings})` : ""}.`
      : `History: handoff — a fresh ${tag} session${settings ? ` (${settings})` : ""} opened with a summary of the visible conversation. Tool results, reasoning and other provider state are not carried.`;
  let workspace =
    "Workspace: a copy — a new worktree with the source's staged, unstaged and untracked work.";
  if (fork.workspace === "share")
    workspace = `Workspace: shared — the fork works in ${s?.branch ?? "the source's worktree"}, which the source keeps.`;
  else if (s?.checkout === "clone" || fork.isolation === "vm")
    workspace = "Workspace: a copy — a new branch from the source's work.";
  return `${history}\n${workspace}\nThe source session keeps its history and workspace.`;
};

export const forkConfirm = (st: St, fork: ForkPlan): Overlay => ({
  t: "confirm",
  confirm: {
    action: "forkSession",
    fork,
    title: "fork session",
    danger: false,
    body: forkSummary(st, fork),
  },
});

/** Enter on one of the wizard's own steps (provider, history, workspace). */
export const pickForkStep = (st: TuiState, p: Picker): Overlay => {
  if (p.dest.t !== "fork") return unwind({ t: "picker", picker: p });
  const fork = p.dest.fork;
  const s = sessionOf(st, fork.sessionId);
  const cur = pickerCurrent(p);
  if (!s || !cur) return unwind({ t: "picker", picker: p });
  if (cur.disabled) return { t: "picker", picker: p };
  switch (p.step) {
    case "provider":
      return afterProvider(st, s, fork, cur.id);
    case "forkHistory":
      return cur.id === "native"
        ? forkWorkspaceStep(st, { ...fork, history: "native", model: null, effort: null })
        : modelStep(st, { ...fork, history: "handoff" });
    case "forkWorkspace": {
      const workspace = cur.id === "share" ? "share" : "copy";
      // A shared tree is the source's, so the fork runs where it does.
      const isolation = workspace === "share" ? "none" : fork.isolation;
      return forkConfirm(st, { ...fork, workspace, isolation });
    }
    default:
      return unwind({ t: "picker", picker: p });
  }
};

/** `Esc` inside the wizard: one step back, or out from its first step. */
export const escapeFork = (st: TuiState, p: Picker): Overlay => {
  if (p.dest.t !== "fork") return unwind({ t: "picker", picker: p });
  const fork = p.dest.fork;
  const s = sessionOf(st, fork.sessionId);
  if (!s) return unwind({ t: "picker", picker: p });
  const provider = fork.provider ?? s.provider;
  const backToProvider = (): Overlay =>
    fleetProviders(st).length > 1 ? providerStep(st, s, fork) : unwind({ t: "picker", picker: p });
  switch (p.step) {
    case "forkWorkspace":
      return fork.history === "native" ? historyStep(st, s, fork) : modelStep(st, fork);
    case "effort":
      return modelStep(st, { ...fork, provider: p.chosen.provider, model: p.chosen.model });
    case "model":
      return nativeOn(s, provider) ? historyStep(st, s, { ...fork, provider }) : backToProvider();
    case "forkHistory":
      return backToProvider();
    default:
      return unwind({ t: "picker", picker: p });
  }
};
