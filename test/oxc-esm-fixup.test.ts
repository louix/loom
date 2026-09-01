import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("oxc-esm-fixup: the TUI loads under oxnode from a CJS-typed cwd", () => {
  // @oxc-node's ESM `load` hook picks a module's format from the nearest
  // package.json of process.cwd(), not the imported file's. From a directory
  // whose package.json is `"type": "commonjs"` (i.e. every user project once
  // loom is nix-installed) it labels the TUI's `.tsx` files `commonjs` with a
  // broken source; Node then re-detects them as ESM mid-CJS-compile and the
  // dynamic `import("@loom/tui/run")` dies with ERR_REQUIRE_CYCLE_MODULE.
  // cli/src/oxc-esm-fixup.mjs re-labels those loads; this drives the exact
  // failing chain (same hooks oxnode registers) and must come out clean.
  const cwd = mkdtempSync(join(tmpdir(), "loom-esm-fixup-"));
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "cjs-project", version: "0.0.0", type: "commonjs" }),
  );

  const spawned = spawnSync(
    process.execPath,
    [
      "--enable-source-maps",
      "--import",
      pathToFileURL(join(repoRoot, "node_modules/@oxc-node/core/register.mjs")).href,
      "--import",
      pathToFileURL(join(repoRoot, "cli/src/oxc-esm-fixup.mjs")).href,
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(join(repoRoot, "frontend/tui/src/run.tsx")).href)});` +
        'process.stdout.write("tui-graph-loaded");',
    ],
    { cwd, encoding: "utf8", timeout: 60_000 },
  );

  assert.equal(
    spawned.status,
    0,
    `node exited ${spawned.status}\nstdout: ${spawned.stdout}\nstderr: ${spawned.stderr}`,
  );
  assert.ok(spawned.stdout.includes("tui-graph-loaded"), `stdout: ${spawned.stdout}`);
});
