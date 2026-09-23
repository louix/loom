import { listVms, type VmRecord } from "../../../../runtime/src/session-vm/inventory.ts";
import { sampleVmUsage, type VmUsage } from "../../../../runtime/src/session-vm/usage.ts";
import { shellQuote } from "./clone-git.ts";

/** Includes committed session work plus staged/unstaged changes; untracked names are listed separately. */
export const changesCommand = (base: string | null, patch: boolean): string => `
set -eu
export GIT_OPTIONAL_LOCKS=0 LC_ALL=C
printf 'WORKING TREE\\n'
status=$(git -c core.quotePath=true status --porcelain=v1)
if [ -n "$status" ]; then printf '%s\\n' "$status"; else printf 'Working tree clean\\n'; fi
printf '\\n'
base=${shellQuote(base ?? "")}
if [ -n "$base" ] && start=$(git merge-base HEAD "$base" 2>/dev/null); then
  printf 'SESSION DIFF · since branching from %s\\n' "$base"
elif start=$(git rev-parse --verify HEAD 2>/dev/null); then
  printf 'SESSION DIFF · against HEAD\\n'
else
  start=$(git hash-object -t tree /dev/null)
  printf 'SESSION DIFF · initial checkout\\n'
fi
git -c core.quotePath=true --no-pager diff --no-ext-diff --no-textconv --no-color ${patch ? "--patch" : "--numstat --shortstat"} "$start" --
`;

export const vmMonitorText = async (
  repo: string,
  sessionId: string,
  signal: AbortSignal,
  inventory = listVms,
  sample = sampleVmUsage,
): Promise<string> => {
  const { vms, errors } = await inventory(repo);
  const selected = vms.filter((vm) => vm.sessionId === sessionId);
  const sections = await Promise.all(
    selected.map(async (vm: VmRecord) => {
      let usage: VmUsage | undefined;
      if (vm.state === "running") {
        try {
          usage = await sample(vm, signal);
        } catch {
          signal.throwIfAborted();
        }
      }
      const mib = (n: number | null | undefined) =>
        n == null ? "—" : (n / 1048576).toFixed(0) + " MiB";
      const kind = { session: "AGENT", mcp: "MCP", prepare: "PREPARATION" }[vm.kind];
      return [
        `${kind} · ${vm.kind === "mcp" ? vm.workload : (vm.provider ?? vm.workload)} · ${vm.id.slice(0, 8)} · ${vm.state}`,
        `CPU   ${usage?.cpuPercent == null ? "—" : usage.cpuPercent.toFixed(1) + "%"}`,
        `RAM   ${mib(usage?.memoryUsed)} / ${mib(usage?.memoryTotal)}`,
        `DISK  ${mib(usage?.diskUsed)} / ${mib(usage?.diskTotal)}`,
        ...(vm.error ? [vm.error] : []),
      ].join("\n");
    }),
  );
  return [
    ...(sections.length ? sections : ["No VMs associated with this session."]),
    "CPU: % of VM capacity · RAM: guest used / total",
    "DISK: guest /storage used / total · — unavailable",
    ...errors.map((error) => "Inventory unavailable: " + error),
  ].join("\n\n");
};
