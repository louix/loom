/**
 * Disposable offline pnpm storage spike. No production mount changes.
 * deno run -A scripts/spike-pnpm-storage.ts [--parent DIR] [--keep]
 *   [--image LOCAL_NODE_PNPM_IMAGE] [--smolvm PATH]
 * The optional guest image must already contain node and pnpm on PATH.
 */
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { vmEnvironment, reapVm } from "../runtime/src/packaged/vm.ts";

const { values } = parseArgs({
  args: Deno.args,
  options: {
    parent: { type: "string", default: Deno.cwd() },
    keep: { type: "boolean", default: false },
    image: { type: "string" },
    smolvm: { type: "string", default: "smolvm" },
  },
});
const root = await Deno.realPath(
  await Deno.makeTempDir({
    dir: resolve(values.parent),
    prefix: ".pnpm-storage-spike-",
  }),
);
const report: Record<string, unknown> = {
  platform: Deno.build.os,
  arch: Deno.build.arch,
  root,
};
const decoder = new TextDecoder();
const command = async (
  binary: string,
  args: string[],
  cwd = root,
  env?: Record<string, string>,
) => {
  const started = performance.now();
  const result = await new Deno.Command(binary, {
    args,
    cwd,
    ...(env ? { env, clearEnv: true } : {}),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ok: result.success,
    code: result.code,
    elapsedMs: Math.round(performance.now() - started),
    out: decoder.decode(result.stdout),
    err: decoder.decode(result.stderr),
  };
};
const must = async (binary: string, args: string[], cwd = root) => {
  const result = await command(binary, args, cwd);
  assert(result.ok, result.err || result.out);
  return result;
};
const seed = join(root, "seed");
const probe = new URL("./lib/pnpm-storage-probe.mjs", import.meta.url);
const fresh = async (path: string) => {
  await Deno.mkdir(join(path, "checkout"), { recursive: true });
  await Deno.mkdir(join(path, "pnpm-store"), { recursive: true });
  await Deno.copyFile(join(root, "fixture.tgz"), join(path, "fixture.tgz"));
  await Deno.copyFile(probe, join(path, "probe.mjs"));
  await Deno.writeTextFile(
    join(path, "checkout/package.json"),
    JSON.stringify({
      name: "loom-storage-spike",
      private: true,
      dependencies: { "loom-storage-fixture": "file:../fixture.tgz" },
    }),
  );
};
const hostProbe = async (path: string, method = "hardlink") => {
  await must("node", [join(path, "probe.mjs"), path, join(path, "pnpm-store"), method]);
  return JSON.parse(await Deno.readTextFile(join(path, "probe.json")));
};
let cleanupSafe = true;
try {
  console.error("Building a local 32 MiB package; no registry dependencies.");
  const pack = join(root, "package");
  await Deno.mkdir(pack);
  await Deno.writeTextFile(
    join(pack, "package.json"),
    JSON.stringify({
      name: "loom-storage-fixture",
      version: "1.0.0",
    }),
  );
  await Deno.writeFile(join(pack, "payload.bin"), randomBytes(32 * 1024 * 1024));
  for (let i = 0; i < 256; i++)
    await Deno.writeTextFile(join(pack, i + ".js"), "export default " + i + ";\n");
  await must("tar", ["-czf", join(root, "fixture.tgz"), "-C", root, "package"]);
  await fresh(seed);
  const cold = await hostProbe(seed);
  report.hostCold = cold;
  // Snapshot only the warm store and project inputs, not an existing node_modules tree.
  await Deno.remove(join(seed, "checkout/node_modules"), { recursive: true });
  await Deno.remove(join(seed, "probe.json"));
  console.error("Trying strict filesystem cloning; any full-copy fallback is reported explicitly.");
  const left = join(root, "left");
  const clone =
    Deno.build.os === "linux"
      ? await command("cp", ["-a", "--reflink=always", seed, left])
      : {
          ok: false,
          code: 1,
          elapsedMs: 0,
          out: "",
          err: "Strict clone probe currently supports Linux only",
        };
  report.clone = { ...clone, err: clone.err.slice(0, 1200), method: "reflink-always" };
  if (!clone.ok) {
    await Deno.remove(left, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    report.fullCopyFallback = await must("cp", ["-a", seed, left]);
  }
  const right = join(root, "right");
  await must("cp", clone.ok ? ["-a", "--reflink=always", seed, right] : ["-a", seed, right]);
  report.hostWarmLeft = await hostProbe(left);
  report.hostWarmRight = await hostProbe(right);
  const payload = (path: string) =>
    join(path, "checkout/node_modules/loom-storage-fixture/payload.bin");
  const digest = async (path: string) =>
    createHash("sha256")
      .update(await Deno.readFile(path))
      .digest("hex");
  const before = await digest(payload(right));
  const l = await Deno.stat(payload(left));
  const r = await Deno.stat(payload(right));
  assert(l.dev !== r.dev || l.ino !== r.ino, "Sessions must not share a writable inode");
  const file = await Deno.open(payload(left), { write: true });
  try {
    await file.write(new TextEncoder().encode("private session edit"));
  } finally {
    file.close();
  }
  assert.equal(await digest(payload(right)), before, "An in-place edit crossed session boundaries");
  // Inspect the seed directly: reinstalling could repair a corrupted store and mask sharing.
  assert.equal(await digest(cold.stored.path), before, "Session edit changed the seed");
  report.independentWrites = true;

  if (!values.image) {
    report.guest = {
      status: "not-run",
      reason: "Pass --image with a local Node + pnpm image on a VM-capable host",
    };
  } else {
    let canRun = true;
    if (Deno.build.os === "linux") {
      try {
        await Deno.stat("/dev/kvm");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        canRun = false;
      }
    }
    if (!canRun) {
      report.guest = { status: "blocked", reason: "/dev/kvm is absent" };
      Deno.exitCode = 2;
    } else {
      const smolvm = await Deno.realPath(
        values.smolvm!.includes("/")
          ? values.smolvm!
          : (await must("which", [values.smolvm!])).out.trim(),
      );
      const guests = [];
      for (const split of [false, true]) {
        const workspace = join(root, split ? "guest-split" : "guest-single");
        await fresh(workspace);
        // smolvm uses Unix sockets: keep its private state path short.
        const state = await Deno.makeTempDir({ dir: "/tmp", prefix: "lp-" });
        for (const dir of ["home", "cache", "data", "config"])
          await Deno.mkdir(join(state, dir), { recursive: true });
        const mounts = split
          ? [
              "-v",
              join(workspace, "checkout") + ":/probe/checkout",
              "-v",
              join(workspace, "pnpm-store") + ":/store",
            ]
          : ["-v", workspace + ":/probe"];
        if (split) {
          await Deno.copyFile(join(workspace, "probe.mjs"), join(workspace, "checkout/probe.mjs"));
          await Deno.copyFile(
            join(workspace, "fixture.tgz"),
            join(workspace, "checkout/fixture.tgz"),
          );
          await Deno.writeTextFile(
            join(workspace, "checkout/package.json"),
            JSON.stringify({
              name: "loom-storage-spike",
              private: true,
              dependencies: { "loom-storage-fixture": "file:./fixture.tgz" },
            }),
          );
        }
        try {
          const result = await command(
            smolvm,
            [
              "machine",
              "run",
              "--cpus",
              "1",
              "--mem",
              "1024",
              "--timeout",
              "120s",
              "--image",
              values.image,
              ...mounts,
              "-w",
              "/probe/checkout",
              "--",
              "node",
              split ? "/probe/checkout/probe.mjs" : "/probe/probe.mjs",
              "/probe",
              split ? "/store" : "/probe/pnpm-store",
            ],
            state,
            vmEnvironment(state),
          );
          // Split /probe is guest-local; the probe emits JSON on stdout in both cases.
          const line = result.out
            .trim()
            .split("\n")
            .findLast((line) => line.startsWith("{"));
          assert(result.ok, result.err || result.out);
          assert(line, "Guest must emit its measurements");
          const measurement = JSON.parse(line);
          assert.equal(measurement.payloadSha256, cold.payloadSha256);
          assert.equal(measurement.hardlinked, !split, "Unexpected pnpm import behavior");
          assert.equal(measurement.manualLink.ok, !split, "Unexpected filesystem link behavior");
          if (split) assert.equal(measurement.manualLink.code, "EXDEV");
          guests.push({
            layout: split ? "separate-mounts" : "single-mount",
            ...result,
            measurement,
          });
        } finally {
          try {
            await reapVm({ smolvm, state });
            await Deno.remove(state, { recursive: true });
          } catch (error) {
            cleanupSafe = false;
            console.error("VM cleanup failed; retained state at " + state);
            console.error(error);
          }
        }
        if (!cleanupSafe) throw new Error("VM cleanup failed; see retained state above");
      }
      report.guest = guests;
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (values.keep || !cleanupSafe) console.error("Retained disposable files at " + root);
  else await Deno.remove(root, { recursive: true });
}
