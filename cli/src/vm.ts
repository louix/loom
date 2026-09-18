import { parseArgs } from "node:util";
import { basename } from "node:path";
import { findRepoRoot } from "@loom/core/paths";
import {
  listVms,
  legacyVmStates,
  resolveVm,
  stopVm,
  removeVm,
  type VmRecord,
} from "../../runtime/src/session-vm/inventory.ts";

export const VM_HELP = `loom vm <command>

  prepare [--repo <path>]             warm repository dependency caches at committed HEAD
  list [--repo <path>] [--wide] [--json]  list this user's known VMs across repositories
  inspect <vm-id> [--repo <path>] [--json]  show workload, ownership and disk paths
  stop <vm-id> [--repo <path>]         stop a workload and await VM cleanup
  rm <vm-id> [--repo <path>]           remove a stopped VM's inventory record
  prune [--repo <path>] [--dry-run] [--json]  collect obsolete bases and disposable caches

  prepare/prune default to the current repository; inventory defaults to all repos.
  IDs accept unique prefixes. stop/rm preserve session history and host worktrees.
  VMs are disposable workers; stopped instances cannot be resumed.
  Use loom vm <command> --help for details.`;
const details: Record<string, string> = {
  prepare: `loom vm prepare [--repo <path>]

Warm dependency caches in disposable VMs/worktrees at committed HEAD.
Prepare all available runtime images, building shared images once. Sessions
activate their checkout on launch; preparation is optional. Failures/cancellation
retain the previous base. Running sessions update once idle. Progress goes to
the terminal. Without --repo, use the current repository (including bare repos).`,
  list: `loom vm list [--repo <path>] [--wide] [--json]

List known instances across this user's repositories, including stopped records.
--repo filters to one repository; --wide adds full session IDs and absolute
repository/runtime/state paths. MCP VMs show their owning session and tool name.
VM state is separate from session activity. Untracked state is
reported separately. Does not start a daemon or perform recovery.`,
  inspect: `loom vm inspect <vm-id> [--repo <path>] [--json]

Show full instance identity, owner observation time, workload and disk paths.
Missing optional metadata is shown as unavailable. Does not launch or recover VMs.`,
  stop: `loom vm stop <vm-id> [--repo <path>]

Ask the owner to stop the session workload or cancel preparation; wait for
VM and relay cleanup. Discard disposable guest disks, preserving host worktrees,
session history and provider profiles. Recover orphaned VMs under their ownership
lock. Fail if shutdown cannot be confirmed. An already stopped VM succeeds.
A later session action can launch a fresh VM.`,
  rm: `loom vm rm <vm-id> [--repo <path>]

Remove a stopped instance's inventory record. Refuse live or unrecovered VMs;
run loom vm stop first. Never remove provider profiles, host worktrees or bases.`,
  prune: `loom vm prune [--repo <path>] [--dry-run] [--json]

Collect obsolete repository bases, legacy disposable session disks and unused
runtime/template caches, preserving current selections and VM references.
--dry-run reports what would be removed using the same retention checks.
Without --repo, use the current repository. Lock files may be created for
coordination; --dry-run does not delete or change cache selections.`,
};
// Repository names and paths must not inject terminal control sequences.
// eslint-disable-next-line no-control-regex
const safe = (s: unknown) => String(s ?? "-").replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
const age = (date: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 1000));
  if (seconds < 60) return seconds + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
  return Math.floor(seconds / 86400) + "d";
};
export const formatVmList = (vms: VmRecord[], wide = false) => {
  if (!vms.length) return "No known VMs.\n";
  const shortId = (id: string) => {
    let length = 8;
    while (vms.some((vm) => vm.id !== id && vm.id.startsWith(id.slice(0, length)))) length++;
    return id.slice(0, length);
  };
  const rows = [
    [
      "VM",
      "STATE",
      "REPO",
      "KIND",
      "SESSION",
      "WORKLOAD",
      "AGE",
      ...(wide ? ["RUNTIME", "STATE DIRECTORY"] : []),
    ],
    ...vms.map((vm) => [
      shortId(vm.id),
      vm.state,
      wide ? vm.repo : basename(vm.repo),
      vm.kind,
      (wide ? vm.sessionId : vm.sessionId?.slice(0, 8)) ?? "-",
      [vm.provider, vm.workload].filter(Boolean).join(" / "),
      age(vm.createdAt),
      ...(wide ? [vm.paths.runtime, vm.paths.state] : []),
    ]),
  ].map((row) => row.map(safe));
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return (
    rows
      .map((row) =>
        row
          .map((cell, i) => cell.padEnd(widths[i]!))
          .join("  ")
          .trimEnd(),
      )
      .join("\n") + "\n"
  );
};
const formatInspect = (vm: VmRecord) =>
  Object.entries({
    VM: vm.id,
    State: vm.state,
    Repository: vm.repo,
    Kind: vm.kind,
    Session: vm.sessionId,
    Provider: vm.provider,
    Workload: vm.workload,
    Created: vm.createdAt,
    Stopped: vm.stoppedAt,
    Observed: vm.observedAt,
    Source: vm.source,
    Workspace: vm.paths.workspace,
    Runtime: vm.paths.runtime,
    "Ephemeral VM state": vm.paths.state,
    "Persistent session state": vm.paths.session,
    "Provider profile": vm.paths.profile,
    "Backend data": vm.paths.backend,
    "Prepared base": vm.paths.base,
    Error: vm.error,
  })
    .map(([key, value]) => key + ": " + safe(value))
    .join("\n") + "\n";

export const vmCommand = async (args: string[]): Promise<string> => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      help: { type: "boolean" },
      json: { type: "boolean" },
      wide: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  });
  const command = positionals[1];
  if (!command) {
    if (positionals.length === 1) return VM_HELP + "\n";
    throw new Error(VM_HELP);
  }
  if (!(command in details)) throw new Error("Unknown VM command: " + command + "\n" + VM_HELP);
  const hasId = ["inspect", "stop", "rm"].includes(command);
  if (positionals.length !== (hasId ? 3 : 2) && !(values.help && positionals.length === 2))
    throw new Error(details[command]);
  const allowed = new Set([
    "repo",
    "help",
    ...(["list", "inspect", "prune"].includes(command) ? ["json"] : []),
    ...(command === "list" ? ["wide"] : []),
    ...(command === "prune" ? ["dry-run"] : []),
  ]);
  for (const key of Object.keys(values))
    if (!allowed.has(key)) throw new Error("Unknown option for vm " + command + ": --" + key);
  if (values.help) return details[command] + "\n";
  const repo =
    values.repo || ["prepare", "prune"].includes(command) ? findRepoRoot(values.repo) : undefined;
  if (command === "prepare") {
    const { prepareRepoEnvironment } = await import("./environment.ts");
    await prepareRepoEnvironment(repo!);
    return "";
  }
  if (command === "prune") {
    const { pruneRepoEnvironment } = await import("./environment.ts");
    const r = await pruneRepoEnvironment(repo!, values["dry-run"]);
    if (values.json) return JSON.stringify({ version: 1, ...r }) + "\n";
    const verb = r.dryRun ? "Would remove" : "Removed";
    return (
      `${verb} ${r.removed} old environment bases; retained ${r.retained}.\n` +
      r.retainedBases.map((base) => `  ${safe(base.directory)}: ${safe(base.reason)}\n`).join("") +
      `${verb} legacy disks from ${r.sessionDisksRemoved} sessions; deferred ${r.sessionDisksRetained}.\n` +
      `${verb} ${r.generations} runtime generations and ${r.templates} template caches.` +
      (r.deferred
        ? " Runtime cache cleanup deferred: active VMs/updates or retained/unreadable state."
        : "") +
      "\n"
    );
  }
  if (command === "list") {
    const all = await listVms();
    let legacy: string[] = [];
    try {
      legacy = await legacyVmStates(all.vms);
    } catch (error) {
      all.errors.push(String(error));
    }
    const vms = repo ? all.vms.filter((vm) => vm.repo === repo) : all.vms;
    if (all.errors.length || vms.some((vm) => vm.state === "unknown")) Deno.exitCode = 1;
    if (values.json) return JSON.stringify({ ...all, vms, legacyStates: legacy }) + "\n";
    for (const error of all.errors) console.error(safe(error));
    for (const path of legacy)
      console.error("Untracked VM state (repo/session/activity unknown): " + safe(path));
    for (const vm of vms) if (vm.error) console.error(vm.id.slice(0, 8) + ": " + safe(vm.error));
    return formatVmList(vms, values.wide);
  }
  const vm = await resolveVm(positionals[2]!, repo);
  if (command === "inspect") {
    if (vm.state === "unknown") Deno.exitCode = 1;
    return values.json ? JSON.stringify({ version: 1, vm }) + "\n" : formatInspect(vm);
  }
  if (command === "stop") {
    await stopVm(vm.id);
    return "Stopped VM " + vm.id + ".\n";
  }
  await removeVm(vm.id);
  return "Removed VM " + vm.id + ".\n";
};
