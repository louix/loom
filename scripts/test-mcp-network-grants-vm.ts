/**
 * Live check of MCP tool-VM network grants: an exact grant admits only that name.
 * Needs internet access; uses throwaway VM state only.
 *
 *   deno run -A scripts/test-mcp-network-grants-vm.ts <session-runtime> <smolvm>
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { McpGrants } from "../core/src/mcp-config.ts";
import {
  reapVm,
  stageGuestImage,
  vmArguments,
  type VmBinding,
  vmEnvironment,
} from "../runtime/src/packaged/vm.ts";

const [artifact, smolvm] = Deno.args;
assert(artifact && smolvm, "usage: <session-runtime artifact> <smolvm executable>");
const manifest = JSON.parse(await Deno.readTextFile(join(artifact, "manifest.json")));
const inventory = (await Deno.readTextFile(join(artifact, "store-paths"))).trim().split("\n");
const storePath = (pattern: RegExp) => {
  const path = inventory.find((p) => pattern.test(p));
  assert(path, `Runtime closure lacks ${pattern}`);
  return path;
};
const curl = storePath(/-curl-[0-9.]+-bin$/) + "/bin/curl";
const caBundle = storePath(/-nss-cacert-/) + "/etc/ssl/certs/ca-bundle.crt";
const apex = "https://github.com/";
const subdomain = "https://api.github.com/";

/** curl's exit status per URL: 0 reached, 6 name refused, 7/28 connection blocked. */
const probe = async (network: string[], legacy = false) => {
  const scratch = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-mcp-net-" }),
  );
  const state = join(scratch, "state");
  const binding: VmBinding = {
    version: 1,
    artifact,
    smolvm,
    manifest,
    workspace: join(scratch, "workspace"),
    state,
    token: "acceptance-test-only".repeat(2),
    mcpGrants: { workspace: "none", network } satisfies McpGrants,
  };
  try {
    for (const dir of ["workspace", "state/home", "state/cache", "state/data", "state/config"])
      await Deno.mkdir(join(scratch, dir), { recursive: true });
    await stageGuestImage(binding);
    let args = vmArguments(binding);
    // Control only: the flag Loom used before, to show what the exact grant prevents.
    if (legacy) args = args.map((a) => (a === "--allow-host-pattern" ? "--allow-host" : a));
    const prefix = [
      ...args.slice(0, args.indexOf("--")).filter((a) => a !== "-i"),
      "--timeout",
      "90s",
    ];
    const runtimePrefix = args.slice(args.indexOf("--") + 1, args.indexOf(manifest.entrypoint));
    const result = await new Deno.Command(smolvm, {
      args: [
        ...prefix,
        "--",
        ...runtimePrefix,
        "/bin/sh",
        "-c",
        `curl="$1"; ca="$2"; shift 2
for url; do
  status=0
  "$curl" -sS -o /dev/null --connect-timeout 8 --max-time 15 --cacert "$ca" "$url" || status=$?
  echo "$url $status"
done`,
        "loom-network-probe",
        curl,
        caBundle,
        apex,
        subdomain,
      ],
      clearEnv: true,
      env: vmEnvironment(state),
      cwd: state,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(result.stdout);
    assert(result.success, `VM failed: ${new TextDecoder().decode(result.stderr)}\n${stdout}`);
    const statuses = Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((line) => line.split(" "))
        .map(([url, status]) => [url, Number(status)]),
    );
    assert.deepEqual(Object.keys(statuses).sort(), [apex, subdomain].sort(), stdout);
    return { network, flag: legacy ? "--allow-host" : "--allow-host-pattern", statuses };
  } finally {
    await reapVm(binding).catch(() => {});
    await Deno.remove(scratch, { recursive: true });
  }
};

const report = [];
// smolvm's legacy flag admits the subdomain; this is the gap the exact grant closes.
const legacy = await probe(["github.com"], true);
report.push(legacy);
assert.equal(legacy.statuses[apex], 0, "legacy control could not reach the granted host");
assert.equal(legacy.statuses[subdomain], 0, "legacy --allow-host no longer admits subdomains");

const exact = await probe(["github.com"]);
report.push(exact);
assert.equal(exact.statuses[apex], 0, "exact grant did not reach its host");
assert.notEqual(exact.statuses[subdomain], 0, "exact grant admitted a subdomain");

console.log(JSON.stringify({ passed: true, report }, null, 2));
