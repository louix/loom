/** Runs unchanged on the host and in a Node + pnpm guest image. Offline fixture only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const [workspace, storeArgument, method = "hardlink"] = process.argv.slice(2);
assert(workspace && storeArgument, "Pass workspace and store paths, then optional import method");
const checkout = join(workspace, "checkout");
const store = resolve(storeArgument);
const started = performance.now();
const pnpm = process.env.PNPM_BINARY || "pnpm";
const version = execFileSync(pnpm, ["--version"], { encoding: "utf8" }).trim();
const output = execFileSync(
  pnpm,
  [
    "install",
    "--offline",
    "--ignore-scripts",
    "--store-dir",
    store,
    "--package-import-method=" + method,
    "--reporter=append-only",
  ],
  { cwd: checkout, encoding: "utf8", env: { ...process.env, CI: "true" } },
);
process.stderr.write(output);
const installed = join(checkout, "node_modules/loom-storage-fixture/payload.bin");
const info = statSync(installed);
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const expected = digest(installed);
const files = function* (directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
};
const stored = [...files(store)].find(
  (path) => statSync(path).size === info.size && digest(path) === expected,
);
assert(stored, "Fixture payload must exist in the content-addressed store");
const storedInfo = statSync(stored);
const sameInode = info.dev === storedInfo.dev && info.ino === storedInfo.ino;
let manualLink;
const link = join(checkout, "manual-link-probe");
try {
  linkSync(stored, link);
  const linked = statSync(link);
  manualLink = {
    ok: true,
    sameInode: linked.dev === storedInfo.dev && linked.ino === storedInfo.ino,
  };
  unlinkSync(link);
} catch (error) {
  manualLink = { ok: false, code: error.code };
}
const report = {
  pnpm: version,
  method,
  elapsedMs: Math.round(performance.now() - started),
  payloadBytes: info.size,
  payloadSha256: expected,
  installed: { dev: info.dev, ino: info.ino, nlink: info.nlink },
  stored: { path: stored, dev: storedInfo.dev, ino: storedInfo.ino, nlink: storedInfo.nlink },
  hardlinked: sameInode,
  manualLink,
};
writeFileSync(join(workspace, "probe.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
