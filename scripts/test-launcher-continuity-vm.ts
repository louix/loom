/**
 * Old-session continuity across the launcher default flip, on a real VM: a daemon on
 * the legacy launcher creates an AISDK VM session and idle-suspends it; a restarted
 * daemon on the isolation launcher resumes it in the same session state directory,
 * with its worker as a leased execution and guest commands under the environment's
 * leases. LOOM_TEST_FROM=isolation runs the reverse direction.
 *
 * The AISDK endpoint never resolves (.invalid): turns fail at the egress proxy
 * without credentials or provider traffic, and the worker stays up. All daemon, VM
 * and worktree state stays under a disposable root.
 *
 * Usage: deno run -A scripts/test-launcher-continuity-vm.ts <session-runtime> <smolvm>
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import { setLogLevel } from "@loom/core/logger";
import type { HistoryPage, SessionSnapshot } from "@loom/core/wire";
import { Daemon } from "../backend/daemon/src/daemon/daemon.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";
import { CONNECTORS } from "../cli/src/connectors.ts";
import { listVms } from "../runtime/src/session-vm/inventory.ts";
import { gitFixture } from "./lib/git-fixture.ts";
import { hostProcesses } from "./lib/host-processes.ts";

type Launcher = "legacy" | "isolation";
const [runtime, backend] = Deno.args;
assert(runtime && backend, "Pass a rebuilt session runtime and smolvm");
const from = (Deno.env.get("LOOM_TEST_FROM") ?? "legacy") as Launcher;
assert(from === "legacy" || from === "isolation", "LOOM_TEST_FROM must be legacy or isolation");
const to: Launcher = from === "legacy" ? "isolation" : "legacy";
const artifact = await Deno.realPath(runtime);
const smolvm = await Deno.realPath(backend);
setLogLevel("error");
const f = await gitFixture();
for (const [name, dir] of [
  ["XDG_STATE_HOME", "state"],
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_DATA_HOME", "data"],
  ["XDG_RUNTIME_DIR", "run"],
] as const) {
  await Deno.mkdir(join(f.root, dir), { recursive: true, mode: 0o700 });
  Deno.env.set(name, join(f.root, dir));
}
await Deno.mkdir(join(f.root, "config/loom"), { recursive: true });
const configure = (launcher: Launcher) =>
  Deno.writeTextFile(
    join(f.root, "config/loom/config.jsonc"),
    JSON.stringify({
      session: {
        titles: { enabled: false },
        auto_resume: { enabled: false },
        commit_reminder: { enabled: false },
        isolation: { enabled: true, launcher, aisdk: { artifact, smolvm } },
      },
      providers: {
        openai_compatible: {
          profiles: {
            fixture: {
              base_url: "https://loom-fixture.invalid/v1",
              api_key: "disposable-test-key",
              model: "fixture",
            },
          },
        },
      },
    }),
  );

let daemon: Daemon | undefined;
let client: LoomClient | undefined;
const start = async (launcher: Launcher) => {
  await configure(launcher);
  daemon = await Daemon.start({
    repoRoot: f.repo,
    standalone: true,
    connectors: CONNECTORS,
  });
  client = await LoomClient.connect({
    repoRoot: f.repo,
    sockPath: daemon.sockPath,
    autospawn: false,
  });
};
const stop = async (why: string) => {
  await client?.close();
  client = undefined;
  await daemon?.stop(why);
  daemon = undefined;
};
const settle = async (id: string, what: string) => {
  const deadline = Date.now() + 240_000;
  while (["starting", "running"].includes(daemon!.registry.get(id)?.status.kind ?? "")) {
    assert(Date.now() < deadline, what);
    await delay(100);
  }
};
const sessionVms = async (id: string) =>
  (await listVms(await Deno.realPath(f.repo))).vms.filter(
    (vm) => vm.sessionId === id && vm.state !== "stopped",
  );
/**
 * Which launcher runs the VM's agent worker. Both run guest.ts as the VM's own
 * workload; only the isolation launcher adds a guest-worker.ts execution beside it.
 */
const workerLauncher = async (state: string) => {
  const execs = (await hostProcesses({ environment: true })).filter(
    ({ argv, text }) =>
      text.includes(join(state, "home")) &&
      argv.some((arg) => /\/session-vm\/guest(?:-worker)?\.ts$/.test(arg)),
  );
  assert(execs.length, "no guest exec for " + state);
  return execs.some(({ argv }) => argv.some((arg) => arg.endsWith("/guest-worker.ts")))
    ? "isolation"
    : "legacy";
};

const transcriptLength = async (id: string) =>
  (await client!.request<HistoryPage>("session.events", { id, limit: 5000 })).items.length;

let passed = false;
try {
  console.log(`Creating on the ${from} launcher`);
  await start(from);
  const created = await client!.request<SessionSnapshot>("session.create", {
    provider: "fixture",
    prompt: "hello",
    worktree: true,
    isolation: "vm",
  });
  const id = created.id;
  await settle(id, "the VM session did not start");
  const dir = sessionVmDirectory(f.repo, id);
  const [first] = await sessionVms(id);
  assert(first && first.state === "running", "the session VM runs");
  assert.equal(first.paths.session, dir);
  assert.equal(
    await workerLauncher(first.paths.state),
    from,
    "the worker runs on the first launcher",
  );
  assert.equal(await Deno.readTextFile(join(dir, "aisdk")), "1");
  console.log(`created: VM ${first.id.slice(0, 8)} on ${from}, state ${dir}`);

  // Idle suspension: the session keeps its files and history; its VM stops. The
  // daemon's sweep only suspends idle sessions, and this fixture's turn ends in an
  // error, so close the worker exactly as the sweep does.
  assert(daemon!.registry.store.providerRef(id), "the session has a provider reference");
  await daemon!.sessions.close(id, "idle_suspension");
  assert.equal(daemon!.sessions.has(id), false, "idle suspension closed the worker");
  assert.deepEqual(await sessionVms(id), [], "the suspended session has no VM");
  const history = await transcriptLength(id);
  console.log(`suspended; ${history} history events`);

  await stop("continuity-restart");
  console.log(`Restarting on the ${to} launcher`);
  await start(to);
  const before = daemon!.registry.mustGet(id);
  assert.equal(before.isolation, "vm");
  await client!.request("session.resume", { id });
  await settle(id, "the resumed VM session did not start");
  // The inventory observes its VMs every 500 ms.
  for (let i = 0; (await sessionVms(id))[0]?.state !== "running" && i < 50; i++) await delay(100);
  const [second] = await sessionVms(id);
  assert(second && second.state === "running", "the resumed session VM runs");
  assert.notEqual(second.id, first.id, "a fresh VM generation");
  assert.equal(second.paths.session, dir, "the same session state directory");
  assert.equal(second.paths.workspace, first.paths.workspace, "the same workspace");
  assert.equal(await workerLauncher(second.paths.state), to, "the worker runs on the new launcher");
  // Guest commands reach the resumed VM: on the isolation launcher, under its leases.
  const inspection = await client!.request<{ text: string }>("session.inspect", {
    id,
    tab: "changes",
  });
  assert.match(inspection.text, /WORKING TREE/);
  const shell = await client!.request<{ token: string; isolation: string }>("session.openShell", {
    id,
  });
  assert.equal(shell.isolation, "vm");
  await client!.request("session.closeShell", { token: shell.token });
  // A further turn runs in the resumed worker against the same host transcript.
  await client!.request("session.send", { id, text: "again" });
  await settle(id, "the resumed turn did not end");
  const after = await transcriptLength(id);
  assert(after > history, "the resumed session extends its history");
  console.log(`resumed: VM ${second.id.slice(0, 8)} on ${to}, same state; ${after} history events`);
  await client!.request("session.markDone", { id });
  passed = true;
} finally {
  await stop("continuity-test").catch((error) => console.error(error));
  const { vms } = await listVms(await Deno.realPath(f.repo));
  const live = vms.filter((vm) => vm.state !== "stopped");
  if (live.length) console.error("VMs still recorded: " + JSON.stringify(live));
  if (passed && !live.length) await f.close();
  else console.error("Retained fixture: " + f.root);
  if (live.length || !passed) Deno.exitCode = 1;
}
console.log(`Passed: a VM session suspended on the ${from} launcher resumed on the ${to} launcher`);
