import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loomPaths, worktreeDirectory } from "@loom/core/paths";
import {
  loomRuntimeDirectory,
  TEST_HOME_VARIABLE,
  temporaryRoots,
  userDirectory,
} from "@loom/core/user-dirs";
import { userConfigPath } from "../backend/daemon/src/config-path.ts";
import { defaultCatalogueDirectory } from "../backend/daemon/src/daemon/model-catalogue-cache.ts";
import { mcpOAuthStateDirectory } from "../backend/daemon/src/daemon/mcp-oauth-store.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";
import { isolateStateRoot } from "../cli/src/isolate/state.ts";
import { recentRepositoriesPath } from "../cli/src/recent-repositories.ts";
import { environmentUserConfigPath } from "../environment-config/src/paths.ts";
import { runtimeHome } from "../runtime/src/packaged/artifact.ts";
import { vmInventoryHome } from "../runtime/src/session-vm/inventory.ts";
import { repoBaseDirectory } from "../runtime/src/session-vm/repo-base.ts";

const root = Deno.env.get(TEST_HOME_VARIABLE);
// Other test files point XDG variables at their own temp fixtures; both are fine.
const within = (path: string) =>
  !!root && [root, ...temporaryRoots()].some((dir) => !relative(dir, path).startsWith(".."));

test("the suite runs inside a throwaway HOME and XDG root", () => {
  assert.ok(
    root,
    `${TEST_HOME_VARIABLE} is unset: run the suite with \`deno task test\` (or test:silent / test:timing), ` +
      "not bare `deno test`, so it cannot write into your real ~/.local/state",
  );
  for (const variable of [
    "HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
  ])
    assert.ok(within(Deno.env.get(variable) ?? "/"), `${variable} escapes ${root}`);
  assert.ok(!relative(root, homedir()).startsWith(".."), `HOME escapes ${root}`);
  // Fixtures compare with Loom's canonical paths; macOS's $TMPDIR is a symlink.
  assert.equal(Deno.realPathSync(tmpdir()), tmpdir().replace(/\/$/, ""));
});

test("every per-user Loom location resolves inside the test roots", { skip: !root }, () => {
  const repo = join(tmpdir(), "repo");
  for (const path of [
    worktreeDirectory(repo),
    ...(({ runtime, state, packageCache }) => [runtime, state, packageCache])(loomPaths(repo)),
    userConfigPath(),
    defaultCatalogueDirectory(),
    mcpOAuthStateDirectory(),
    sessionVmDirectory(repo, "session"),
    recentRepositoriesPath(),
    runtimeHome(),
    vmInventoryHome(),
    repoBaseDirectory(repo),
    environmentUserConfigPath(),
    isolateStateRoot(),
  ])
    assert.ok(within(path), `${path} escapes ${root}`);
});

test("a test run refuses per-user paths outside its roots", () => {
  const env = { [TEST_HOME_VARIABLE]: "/nonexistent/test-home", HOME: "/home/someone" };
  assert.throws(() => userDirectory("state", env), /outside LOOM_TEST_HOME/);
  assert.throws(
    () => userDirectory("cache", { ...env, XDG_CACHE_HOME: "/home/someone/.cache" }),
    /outside LOOM_TEST_HOME/,
  );
  // Tests' own fixture roots live in temporary directories.
  const fixture = join(tmpdir(), "fixture-state");
  assert.equal(userDirectory("state", { ...env, XDG_STATE_HOME: fixture }), fixture);
  // Also by their real paths: on macOS /tmp and $TMPDIR are symlinks into /private.
  for (const temporary of [tmpdir(), "/tmp"]) {
    const real = join(Deno.realPathSync(temporary), "fixture-state");
    assert.equal(userDirectory("state", { ...env, XDG_STATE_HOME: real }), real);
  }
  // Outside a test run, resolution follows the XDG spec untouched.
  assert.equal(userDirectory("state", { HOME: "/home/someone" }), "/home/someone/.local/state");
  assert.throws(
    () => loomRuntimeDirectory({ ...env, XDG_RUNTIME_DIR: "/run/user/1000" }),
    /outside LOOM_TEST_HOME/,
  );
  assert.equal(
    userDirectory("data", { HOME: "/home/someone", XDG_DATA_HOME: "relative" }),
    "/home/someone/.local/share",
  );
});
