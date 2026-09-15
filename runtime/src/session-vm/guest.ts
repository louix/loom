/** Guest-only bootstrap: local proxy adapter, isolated auth, then the normal worker. */
import { sessionAuth } from "./auth.ts";
import {
  prepareEnvironment,
  initializeGuestNix,
  loadPreparedEnvironment,
  guestPathProfile,
} from "./environment.ts";
import type { SessionEnvironment } from "../../../core/src/session-environment.ts";
import { runWorker } from "../worker/main.ts";
import { startGuestRelay } from "./guest-relay.ts";
import { reportStartup } from "./progress.ts";
// Package caches outlive VM replacement; installed dependencies stay in the worktree.
const cache = await Deno.readTextFile("/run/loom/private/cache-path").catch((error) => {
  if (error instanceof Deno.errors.NotFound) return "/storage/loom-cache";
  throw error;
});
for (const [key, path] of Object.entries({
  // Nix's libgit2 cache requires guest ownership; host mounts expose the host UID.
  XDG_CACHE_HOME: "/storage/loom-cache",
  npm_config_cache: `${cache}/npm`,
  PIP_CACHE_DIR: `${cache}/pip`,
  UV_CACHE_DIR: `${cache}/uv`,
  XDG_DATA_HOME: `${cache}/data`,
  DENO_DIR: `${cache}/deno`,
})) {
  await Deno.mkdir(path, { recursive: true });
  Deno.env.set(key, path);
}
// pnpm's root-user lifecycle mode otherwise moves TMPDIR into node_modules.
// Keep extraction on guest storage: virtiofs cannot apply tarball ownership.
// Package scripts already run inside this session's VM as the guest user.
Deno.env.set("npm_config_unsafe_perm", "true");
Deno.env.set("pnpm_config_unsafe_perm", "true");
const auth = sessionAuth(JSON.parse(await Deno.readTextFile("/run/loom/private/auth.json")));
Deno.env.set("CLAUDE_CONFIG_DIR", "/tmp/loom-home/.claude");
Deno.env.set("CLAUDE_CODE_PROJECT_DIR_NAME", "loom-session");
if (auth.claudeAiOauth) {
  await Deno.mkdir("/tmp/loom-home/.claude", { recursive: true });
  try {
    await Deno.remove("/tmp/loom-home/.claude/.credentials.json");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.symlink("/run/loom/private/auth.json", "/tmp/loom-home/.claude/.credentials.json");
}
if (auth.codexOauth) {
  Deno.env.set("CODEX_HOME", "/tmp/loom-home/.codex");
  await Deno.mkdir("/tmp/loom-home/.codex", { recursive: true });
  await Deno.remove("/tmp/loom-home/.codex/auth.json").catch((e) => {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  });
  await Deno.symlink("/run/loom/private/codex.json", "/tmp/loom-home/.codex/auth.json");
}
for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const)
  if (typeof auth[key] === "string") Deno.env.set(key, auth[key]);
// Node/Corepack otherwise bypass the proxy and attempt unavailable guest DNS.
Deno.env.set("NODE_USE_ENV_PROXY", "1");
Deno.env.set("HTTPS_PROXY", "http://127.0.0.1:3128");
Deno.env.set("HTTP_PROXY", "http://127.0.0.1:3128");
Deno.env.set("NO_PROXY", "localhost,127.0.0.1");
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"])
  Deno.env.set(name.toLowerCase(), Deno.env.get(name)!);
Deno.env.set("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
Deno.env.set("DISABLE_AUTOUPDATER", "1");
Deno.env.set("IS_SANDBOX", "1");
Deno.env.set("SHELL", Deno.env.get("LOOM_GUEST_SHELL")!);
await Deno.mkdir("/tmp/loom-home", { recursive: true });
await Deno.writeTextFile(
  "/tmp/loom-home/.claude.json",
  JSON.stringify({ hasCompletedOnboarding: true }),
);
const listener = Deno.listen({ hostname: "127.0.0.1", port: 3128 });
void startGuestRelay(listener, "/run/loom/egress.sock").finished;
const mcp: Array<{ guestPort: number }> = JSON.parse(
  await Deno.readTextFile("/run/loom/private/mcp.json"),
);
for (const [index, spec] of mcp.entries()) {
  const endpoint = Deno.listen({ hostname: "127.0.0.1", port: spec.guestPort });
  void startGuestRelay(endpoint, `/run/loom/mcp-${index}.sock`).finished;
}
// Explicit preparation builds the environment; normal initialization restores it
// before loading the provider. The proxy remains available to setup and init hooks.
const prepare = async (output?: "inherit") => {
  const config: SessionEnvironment | undefined =
    JSON.parse(await Deno.readTextFile("/run/loom/private/environment.json")) ?? undefined;
  if (config?.nix) Deno.env.set("TMPDIR", "/storage/loom-nix/tmp");
  const before = Deno.env.toObject();
  const env = output
    ? await prepareEnvironment(config, {
        shell: before.LOOM_GUEST_SHELL!,
        initializeNix: initializeGuestNix,
        ...(output ? { output } : {}),
      })
    : await loadPreparedEnvironment(config);
  if (output && env)
    await Deno.writeTextFile("/storage/loom-environment.json", JSON.stringify(env));
  if (!env) return;
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  // Keep the pinned provider executable ahead of dev-shell tools.
  Deno.env.set(
    "PATH",
    [before.LOOM_GUEST_PROVIDER_PATH, env.PATH, before.PATH].filter(Boolean).join(":"),
  );
  for (const key of Object.keys(before))
    if (
      key.startsWith("LOOM_") ||
      [
        "HOME",
        "TMPDIR",
        "DENO_DIR",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "npm_config_cache",
        "npm_config_unsafe_perm",
        "pnpm_config_unsafe_perm",
        "PIP_CACHE_DIR",
        "UV_CACHE_DIR",
        "DENO_NO_UPDATE_CHECK",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "CLAUDE_CODE_PROJECT_DIR_NAME",
        "NODE_USE_ENV_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
      ].includes(key)
    )
      Deno.env.set(key, before[key]!);
  // nix develop removes its build-temporary directory when activation exits.
  if (!before.TMPDIR) Deno.env.delete("TMPDIR");
};
let preparationOnly = false;
try {
  preparationOnly = (await Deno.readTextFile("/run/loom/private/prepare-only")) === "1";
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
if (preparationOnly) {
  Deno.env.set("LOOM_PREPARATION_ONLY", "1");
  try {
    await prepare("inherit");
    Deno.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
} else
  await runWorker(async () => {
    await prepare();
    await Deno.mkdir("/etc/profile.d", { recursive: true });
    await Deno.writeTextFile(
      "/etc/profile.d/zz-loom-path.sh",
      guestPathProfile(Deno.env.get("PATH")!),
    );
    reportStartup("provider");
  }, "session-vm");
