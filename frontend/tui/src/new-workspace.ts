/**
 * Where a new session will run and work, as the `new` prompt settles it:
 * isolation (`⌥i`) and workspace (`⌥w`). Pure functions of the prompt's
 * settings and the provider's facts, so the prompt line, the `⌥w` command's
 * description and the submit all read one answer.
 *
 * The daemon offers three workspaces: a worktree (on the host, or mounted into
 * a VM), a private clone (VM only: the guest reaches the repository through a
 * host relay) and in place in the repository checkout (not in a bare
 * repository). So choosing a clone brings VM isolation with it, and leaving the
 * VM turns a chosen clone back into a worktree; the prompt says so each time.
 */
import { absurd } from "@loom/core/absurd";
import type { ProviderInfo, WorkspaceMode } from "@loom/core/wire";
import type { NewSessionSettings } from "./overlay.ts";

/** `⌥w` order. */
export const WORKSPACE_MODES = [
  "worktree",
  "clone",
  "in-place",
] as const satisfies readonly WorkspaceMode[];

type Provider = ProviderInfo | null;

/** The isolation the session will run under: chosen, else the provider's default. */
export const newIsolation = (p: Provider, s: NewSessionSettings): "vm" | "local" =>
  s.isolation ?? p?.defaultIsolation ?? "local";

/** The workspace the session will get: chosen, else the daemon's default for
 *  its isolation. A daemon that names no default makes a worktree. */
export const newWorkspace = (p: Provider, s: NewSessionSettings): WorkspaceMode =>
  s.workspace ?? p?.defaultWorkspace?.[newIsolation(p, s)] ?? "worktree";

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

const CLONE_NEEDS_VM = "A private clone runs in a VM — isolation is now VM.";
const CLONE_LEFT_VM = "A private clone runs only in a VM — workspace is now worktree.";

/** `⌥w`: the next workspace after the current one that can be chosen. */
export const cycleWorkspace = (p: Provider, s: NewSessionSettings): SettingsStep => {
  if (!p?.defaultWorkspace)
    return { disabled: "This daemon cannot choose a workspace; restart it (R) to update it." };
  const at = WORKSPACE_MODES.indexOf(newWorkspace(p, s));
  const skipped: string[] = [];
  for (let i = 1; i < WORKSPACE_MODES.length; i++) {
    const workspace = WORKSPACE_MODES[(at + i) % WORKSPACE_MODES.length]!;
    const blocked = workspaceBlocked(p, workspace);
    if (blocked) {
      skipped.push(blocked);
      continue;
    }
    const toVm = workspace === "clone" && newIsolation(p, s) !== "vm";
    const note = [...skipped, ...(toVm ? [CLONE_NEEDS_VM] : [])].join(" ");
    return {
      settings: { ...s, workspace, ...(toVm ? { isolation: "vm" as const } : {}) },
      ...(note ? { note } : {}),
    };
  }
  return { disabled: skipped.join(" ") || "There is no other workspace." };
};

/** `⌥i`: the other isolation, or why not. */
export const toggleIsolation = (p: Provider, s: NewSessionSettings): SettingsStep => {
  const current = newIsolation(p, s);
  if (current === "local" && p?.vmUnavailableReason) return { disabled: p.vmUnavailableReason };
  if (current === "local") return { settings: { ...s, isolation: "vm" } };
  if (s.workspace === "clone")
    return { settings: { ...s, isolation: "local", workspace: "worktree" }, note: CLONE_LEFT_VM };
  return { settings: { ...s, isolation: "local" } };
};
