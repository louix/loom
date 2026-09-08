/** Opt-in real-VM integration. All Git repositories and sockets are disposable. */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { inspectArtifact } from "../runtime/src/packaged/artifact.ts";
import { gitBridgeWorker } from "./lib/git-bridge-worker.ts";
import { bridgeVm, guestGitSocket } from "./lib/bridge-vm.ts";
import { gitFixture } from "./lib/git-bridge-fixture.ts";

const [artifactArg, smolvmArg] = Deno.args;
if (!artifactArg || !smolvmArg)
  throw new Error("Usage: deno run -A scripts/test-git-bridge-vm.ts ARTIFACT SMOLVM");
const artifact = await Deno.realPath(artifactArg);
const manifest = await inspectArtifact(artifact);
const fixtures = [await gitFixture(), await gitFixture()];
const services: Array<Awaited<ReturnType<typeof gitBridgeWorker>>> = [];
const guests: Array<Awaited<ReturnType<typeof bridgeVm>>> = [];
const states: string[] = [];
const report: string[] = [];
let completed = false;
try {
  for (const [index, fixture] of fixtures.entries()) {
    await Deno.writeTextFile(join(fixture.workspace, "file.txt"), `session ${index}\n`);
    const service = await gitBridgeWorker(fixture.options);
    services.push(service);
    const state = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-vm-" });
    states.push(state);
    for (const name of ["home", "config", "data", "cache"]) await Deno.mkdir(join(state, name));
    guests.push(
      await bridgeVm(
        {
          version: 1,
          artifact,
          manifest,
          smolvm: resolve(smolvmArg),
          workspace: fixture.workspace,
          state,
          token: "test",
        },
        service.socket,
      ),
    );
  }
  const request = async (index: number, value: unknown) => {
    const result = await guests[index]!.exec([
      manifest.entrypoint,
      "unix",
      guestGitSocket,
      JSON.stringify(value),
    ]);
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout));
  };
  const diffs = await Promise.all([
    request(0, { version: 1, op: "diff" }),
    request(1, { version: 1, op: "diff" }),
  ]);
  assert.match(diffs[0].stdout, /\+session 0/);
  assert.doesNotMatch(diffs[0].stdout, /\+session 1/);
  assert.match(diffs[1].stdout, /\+session 1/);
  report.push("Concurrent guests at the same guest socket path see only their bound worktree");
  assert.equal((await request(0, { version: 1, op: "status" })).code, 0);
  assert.match((await request(0, { version: 1, op: "log" })).stdout, /base commit/);
  const first = fixtures[0]!;
  for (const target of [
    join(first.commonDir, "config"),
    join(first.gitDir, "HEAD"),
    services[0]!.socket,
  ]) {
    const denied = await guests[0]!.exec(["/bin/busybox", "cat", target]);
    assert.notEqual(denied.code, 0);
  }
  // Even a substituted .git pointer cannot retarget the host service.
  assert.equal(
    (await guests[0]!.exec(["/bin/sh", "-c", 'printf "gitdir: /other/repo\\n" > .git'])).code,
    0,
  );
  assert.match((await request(0, { version: 1, op: "diff" })).stdout, /\+session 0/);
  assert.equal(
    (await request(0, { version: 1, op: "status", cwd: fixtures[1]!.workspace })).error,
    "invalid-request",
  );
  assert.equal(
    (await request(0, { version: 1, op: "commit", argv: ["-m", "forbidden"] })).error,
    "invalid-request",
  );
  report.push(
    "Host metadata is unreachable; guest .git edits and retargeting do not change endpoint authority",
  );
  await Deno.writeTextFile(join(first.workspace, ".git"), `gitdir: ${first.gitDir}\n`);
  await first.git("-C", first.workspace, "add", "file.txt");
  await first.git("-C", first.workspace, "commit", "-m", "host-visible commit");
  assert.match(
    (await request(0, { version: 1, op: "log", limit: 1 })).stdout,
    /host-visible commit/,
  );
  // Exercise the user's lazygit workflow: move main and rebase the original linked worktree on the host.
  await Deno.writeTextFile(join(first.repo, "main.txt"), "main advanced\n");
  await first.git("-C", first.repo, "add", "main.txt");
  await first.git("-C", first.repo, "commit", "-m", "new main commit");
  await first.git("-C", first.workspace, "rebase", "main");
  assert.match((await request(0, { version: 1, op: "log" })).stdout, /new main commit/);
  report.push(
    "Host commits and rebase appear immediately to the guest without copying Git objects",
  );
  const host = Deno.networkInterfaces().find(
    (i) => i.family === "IPv4" && !i.address.startsWith("127."),
  )?.address;
  assert.ok(host, "Need a non-loopback IPv4 address for the network control");
  let hits = 0;
  const http = Deno.serve({ hostname: host, port: 0, onListen() {} }, () => {
    hits++;
    return new Response("control");
  });
  try {
    const wget = [
      "/bin/busybox",
      "wget",
      "-q",
      "-T",
      "2",
      "-O",
      "-",
      `http://${host}:${http.addr.port}/`,
    ];
    // Positive control with the same explicit socket lifecycle, but IP allowed.
    await guests[1]!.close();
    const f = fixtures[1]!;
    guests[1] = await bridgeVm(
      {
        version: 1,
        artifact,
        manifest,
        smolvm: resolve(smolvmArg),
        workspace: f.workspace,
        state: states[1]!,
        token: "test",
      },
      services[1]!.socket,
      ["--allow-cidr", `${host}/32`],
    );
    const positive = await guests[1]!.exec(wget);
    assert.equal(positive.code, 0, new TextDecoder().decode(positive.stderr));
    assert.equal(new TextDecoder().decode(positive.stdout), "control");
    const count = hits;
    const denied = await guests[0]!.exec(wget);
    assert.notEqual(denied.code, 0);
    assert.match(new TextDecoder().decode(denied.stderr), /Network unreachable/);
    assert.equal(hits, count);
    assert.equal((await request(0, { version: 1, op: "status" })).code, 0);
    report.push(
      "Dedicated socket works with IP disabled, verified against a reachable HTTP positive control",
    );
  } finally {
    await http.shutdown();
  }
  await services[0]!.close();
  const revoked = await guests[0]!.exec([
    manifest.entrypoint,
    "unix",
    guestGitSocket,
    '{"version":1,"op":"status"}',
  ]);
  assert.notEqual(revoked.code, 0);
  report.push("Closing the host service revokes guest access");
  completed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Reap explicitly-created machines before removing state, including failures.
  for (const guest of guests) await guest.close();
  for (const service of services) await service.close();
  for (const state of states) await Deno.remove(state, { recursive: true });
  if (completed) for (const fixture of fixtures) await fixture.close();
  else console.error(`Git fixtures retained: ${fixtures.map((f) => f.root).join(", ")}`);
}
