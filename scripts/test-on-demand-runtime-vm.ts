/**
 * Apple Silicon without a pinned guest runtime: a real in-process daemon builds
 * the session runtime at the first VM session start, reporting progress, and the
 * next start reuses it without building. Uses the Loom package's own bundled
 * runtime manifest (its builder and identity), with daemon, VM and runtime state
 * under a disposable root. The session is an AISDK VM session whose endpoint never
 * resolves, so no credentials or provider traffic are involved.
 *
 * Usage: deno run -A scripts/test-on-demand-runtime-vm.ts <loom-package> [data-dir]
 *
 * `loom-package` is `nix build .#loom` on a Mac whose runtime pin does not match.
 * Pass `data-dir` to keep the built runtime (its GC root) for later checks.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LoomClient } from "@loom/client";
import { setLogLevel } from "@loom/core/logger";
import type { SessionSnapshot } from "@loom/core/wire";
import type { HarnessEvent } from "@loom/core/types";
import { Daemon } from "../backend/daemon/src/daemon/daemon.ts";
import { CONNECTORS } from "../cli/src/connectors.ts";
import { listVms } from "../runtime/src/session-vm/inventory.ts";
import { bundledRuntime } from "../runtime/src/packaged/artifact.ts";
import { gitFixture } from "./lib/git-fixture.ts";

const [loom, data] = Deno.args;
assert(loom, "Pass the Loom package built without a matching runtime pin");
const wrapper = await Deno.readTextFile(join(loom, "bin/loom"));
const manifest = /LOOM_BUNDLED_RUNTIMES[=' ]+'?(\/nix\/store\/[^'\s]+\.json)/.exec(wrapper)?.[1];
assert(manifest, "The package names no bundled runtimes");
setLogLevel("error");
const f = await gitFixture();
for (const [name, dir] of [
  ["XDG_STATE_HOME", join(f.root, "state")],
  ["XDG_CONFIG_HOME", join(f.root, "config")],
  ["XDG_DATA_HOME", data ?? join(f.root, "data")],
  ["XDG_RUNTIME_DIR", join(f.root, "run")],
] as const) {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  Deno.env.set(name, dir);
}
Deno.env.set("LOOM_BUNDLED_RUNTIMES", manifest);
const lock = bundledRuntime("aisdk");
assert(lock?.build, "This package has a pinned runtime; nothing is built on demand");
console.log(`identity ${lock.build.identity}; runtime link ${lock.artifact}`);
await Deno.mkdir(join(f.root, "config/loom"), { recursive: true });
await Deno.writeTextFile(
  join(f.root, "config/loom/config.jsonc"),
  JSON.stringify({
    session: {
      auto_resume: false,
      // No artifact: the package's on-demand runtime is the default.
      isolation: { enabled: true },
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
let passed = false;
try {
  daemon = await Daemon.start({ repoRoot: f.repo, standalone: true, connectors: CONNECTORS });
  const progress = new Map<string, string[]>();
  const emit = daemon.emitEvent.bind(daemon);
  daemon.emitEvent = (event: HarnessEvent) => {
    if (event.type === "startup_progress") {
      const seen = progress.get(event.sessionId) ?? [];
      if (seen.at(-1) !== event.message) console.log(`  ${event.message}`);
      progress.set(event.sessionId, [...seen, event.message]);
    }
    return emit(event);
  };
  client = await LoomClient.connect({
    repoRoot: f.repo,
    sockPath: daemon.sockPath,
    autospawn: false,
  });
  const start = async (label: string, limitMs: number) => {
    const started = Date.now();
    const s = await client!.request<SessionSnapshot>("session.create", {
      provider: "fixture",
      prompt: "hello",
      worktree: true,
      isolation: "vm",
    });
    while (daemon!.registry.get(s.id)?.status.kind === "starting") {
      assert(Date.now() - started < limitMs, `${label}: the VM session did not start`);
      await delay(500);
    }
    const running = (await listVms(await Deno.realPath(f.repo))).vms.some(
      (vm) => vm.sessionId === s.id && vm.state === "running",
    );
    assert(
      running,
      `${label}: the session VM runs (${JSON.stringify(daemon!.registry.get(s.id)?.status)})`,
    );
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`${label}: VM session ready after ${seconds}s`);
    return { id: s.id, messages: progress.get(s.id) ?? [], seconds };
  };

  const first = await start("first start", 2 * 60 * 60_000);
  assert(
    first.messages.some((m) => m.startsWith("Building the VM runtime")),
    "the first start built the runtime",
  );
  assert(first.messages.some((m) => m.startsWith("VM runtime ready")));
  const artifact = await Deno.realPath(lock.artifact);
  assert.match(artifact, /^\/nix\/store\/[a-z0-9]{32}-lvm$/);
  console.log(`built ${artifact}`);
  await client.request("session.markDone", { id: first.id });

  const second = await start("second start", 10 * 60_000);
  assert(
    !second.messages.some((m) => m.startsWith("Building the VM runtime")),
    "the second start reused the runtime",
  );
  assert.equal(await Deno.realPath(lock.artifact), artifact);
  await client.request("session.markDone", { id: second.id });
  passed = true;
} finally {
  await client?.close();
  await daemon?.stop("on-demand-runtime-test");
  const { vms } = await listVms(await Deno.realPath(f.repo));
  const live = vms.filter((vm) => vm.state !== "stopped");
  if (live.length) console.error("VMs still recorded: " + JSON.stringify(live));
  if (passed && !live.length) await f.close();
  else console.error("Retained fixture: " + f.root);
  if (live.length || !passed) Deno.exitCode = 1;
}
console.log("Passed: on-demand runtime built at first start and reused");
