/**
 * Where a new session will run and work, as the `new` prompt settles it:
 * isolation (`⌥i`), workspace (`⌥w`) and base (`⌥b`), and the agent profile it
 * starts on (picked with the providers, `⌥p`). Pure functions of the prompt's settings and the daemon's
 * facts, so the prompt line, the commands' descriptions and the submit all
 * read one answer.
 *
 * The daemon offers three workspaces: a worktree (on the host, or mounted into
 * a VM), a private clone (VM only: the guest reaches the repository through a
 * host relay) and in place in the repository checkout (not in a bare
 * repository). Isolation takes precedence: a private clone is available only
 * when VM isolation is selected.
 */
import { absurd } from "@loom/core/absurd";
import type { Loadable } from "@loom/core/loadable";
import type { BaseChoices, ProviderInfo, WorkspaceMode } from "@loom/core/wire";
import type { AgentProfileInfo } from "@loom/core/agents";
import type { NewSessionSettings } from "./overlay.ts";

/** `⌥w` order. */
export const WORKSPACE_MODES = [
  "worktree",
  "clone",
  "in-place",
] as const satisfies readonly WorkspaceMode[];

type Provider = ProviderInfo | null;

/** The isolation the session will run under: chosen, else the provider's default. */
export const newIsolation = (p: Provider, s: NewSessionSettings): "vm" | "none" =>
  s.isolation ?? p?.defaultIsolation ?? "none";

/** The workspace the session will get: chosen, else the daemon's default for
 *  its isolation. A daemon that names no default makes a worktree. */
export const newWorkspace = (p: Provider, s: NewSessionSettings): WorkspaceMode => {
  const isolation = newIsolation(p, s);
  const workspace = s.workspace ?? p?.defaultWorkspace?.[isolation] ?? "worktree";
  return isolation === "none" && workspace === "clone" ? "worktree" : workspace;
};

/** Why `w` cannot be chosen for a session on `p`; absent when it can. */
export const workspaceBlocked = (p: Provider, w: WorkspaceMode): string | undefined => {
  switch (w) {
    case "worktree":
      return undefined;
    case "clone":
      return p?.vmUnavailableReason
        ? `A private clone runs only in a VM: ${p.vmUnavailableReason}`
        : undefined;
    case "in-place":
      return p?.inPlaceUnavailableReason;
    default:
      return absurd(w);
  }
};

/** A change to the prompt's settings, with what it changed besides or passed
 *  over (`note`) — or why there is none to make. */
export type SettingsStep =
  | { readonly settings: NewSessionSettings; readonly note?: string }
  | { readonly disabled: string };

const CLONE_LEFT_VM = "A private clone runs only in a VM — workspace is now worktree.";

/** `⌥w`: the next workspace after the current one that can be chosen. */
export const cycleWorkspace = (p: Provider, s: NewSessionSettings): SettingsStep => {
  if (!p?.defaultWorkspace)
    return { disabled: "This daemon cannot choose a workspace; restart it (R) to update it." };
  const isolation = newIsolation(p, s);
  const modes: readonly WorkspaceMode[] =
    isolation === "none"
      ? WORKSPACE_MODES.filter((workspace) => workspace !== "clone")
      : WORKSPACE_MODES;
  const current = newWorkspace(p, s);
  const at = modes.indexOf(current);
  const skipped: string[] = [];
  for (let i = 1; i < modes.length; i++) {
    const workspace = modes[(at + i) % modes.length]!;
    const blocked = workspaceBlocked(p, workspace);
    if (blocked) {
      skipped.push(blocked);
      continue;
    }
    const note = skipped.join(" ");
    return {
      settings: { ...s, workspace },
      ...(note ? { note } : {}),
    };
  }
  return {
    disabled:
      skipped.join(" ") ||
      (isolation === "none" && modes.length < WORKSPACE_MODES.length
        ? "A private clone needs VM isolation (⌥i)."
        : "There is no other workspace."),
  };
};

/** `⌥i`: the other isolation, or why not. */
export const toggleIsolation = (p: Provider, s: NewSessionSettings): SettingsStep => {
  const current = newIsolation(p, s);
  if (current === "none" && p?.vmUnavailableReason) return { disabled: p.vmUnavailableReason };
  if (current === "none") return { settings: { ...s, isolation: "vm" } };
  if (s.workspace === "clone")
    return { settings: { ...s, isolation: "none", workspace: "worktree" }, note: CLONE_LEFT_VM };
  return { settings: { ...s, isolation: "none" } };
};

// ---------------------------------------------------------------------------
// agent profile
// ---------------------------------------------------------------------------

/** Why `profile` cannot start a session here; absent when it can. A profile on
 *  a provider this daemon does not offer is listed, but not choosable. */
export const profileBlocked = (
  profile: AgentProfileInfo,
  providers: readonly ProviderInfo[],
): string | undefined =>
  profile.provider && !providers.some((x) => x.id === profile.provider)
    ? `runs on ${profile.provider}, which is not available`
    : undefined;

/**
 * Start the new session on `profile` (picked from `⌥p`): it sets what it names
 * — provider, model, effort, mode — over the prompt's settings, and what it
 * leaves out follows the provider it runs on. Another profile chosen before it
 * is replaced whole, from `defaults` (today's settings), so nothing of it
 * lingers. Where, isolation and base stay.
 */
export const applyProfile = (
  profile: AgentProfileInfo,
  providers: readonly ProviderInfo[],
  s: NewSessionSettings,
  defaults: NewSessionSettings,
): SettingsStep => {
  const blocked = profileBlocked(profile, providers);
  if (blocked) return { disabled: `${profile.name} ${blocked}.` };
  const { provider: p0, model, effort, mode } = defaults;
  const from = s.profile === undefined ? s : { provider: p0, model, effort, mode };
  const provider = profile.provider ?? from.provider;
  const same = provider === from.provider;
  return {
    settings: {
      ...s,
      profile: profile.name,
      provider,
      model: profile.model ?? (same ? from.model : null),
      effort: profile.effort ?? (same && !profile.model ? from.effort : null),
      mode: profile.mode ?? from.mode,
    },
  };
};

// ---------------------------------------------------------------------------
// base
// ---------------------------------------------------------------------------

type Bases = Loadable<string, BaseChoices>;

/** The ref the session will branch from and how the prompt names it; null
 *  until the daemon has said. The checked-out branch unless the default
 *  branch is chosen, or no commit is checked out to start from. */
export const newBase = (
  bases: Bases,
  s: NewSessionSettings,
): { readonly ref: string; readonly label: string } | null => {
  if (bases.tag !== "data") return null;
  const { current, default: def } = bases.value;
  if (current && s.base !== "default")
    return {
      ref: current.ref,
      label: current.detached ? `detached ${current.ref.slice(0, 7)}` : current.ref,
    };
  return def.unavailableReason ? null : { ref: def.ref, label: def.ref };
};

/** `⌥b`: the other base, or why there is none to switch to. */
export const toggleBase = (bases: Bases, s: NewSessionSettings): SettingsStep => {
  switch (bases.tag) {
    case "idle":
    case "pending":
      return { disabled: "Still reading the repository's branches." };
    case "error":
      return { disabled: bases.error };
    case "data": {
      const { current, default: def } = bases.value;
      if (def.unavailableReason) return { disabled: def.unavailableReason };
      if (!current) return { disabled: "Nothing is checked out yet; the default branch it is." };
      if (!current.detached && current.ref === def.ref)
        return { disabled: `The checked-out branch is already the default branch, ${def.ref}.` };
      return { settings: { ...s, base: s.base === "default" ? "current" : "default" } };
    }
    default:
      return absurd(bases);
  }
};
