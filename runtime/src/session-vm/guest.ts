/** Guest-only bootstrap: local proxy adapter, isolated auth, then the normal worker. */
import { sessionAuth } from "./auth.ts";
import { prepareEnvironment, initializeGuestNix } from "./environment.ts";
import type { SessionEnvironment } from "../../../core/src/session-environment.ts";
import { runWorker } from "../worker/main.ts";
import { startGuestRelay } from "./guest-relay.ts";
import { reportStartup } from "./progress.ts";
// Cache package downloads on ext4, alongside the private Nix store. Worktree
// outputs still live on the host mount; HOME holds only launch-time bootstrap.
for (const [key, path] of Object.entries({
  XDG_CACHE_HOME: "/storage/loom-cache",
  XDG_DATA_HOME: "/storage/loom-data",
  DENO_DIR: "/storage/loom-cache/deno",
})) {
  await Deno.mkdir(path, { recursive: true });
  Deno.env.set(key, path);
}
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
// Setup happens during initialize, before provider loading/readiness. The proxy
// stays alive while the environment subprocess downloads its dependencies.
const prepare = async (output?: "inherit") => {
  let config: SessionEnvironment | undefined;
  try {
    config = JSON.parse(await Deno.readTextFile("/run/loom/private/environment.json")) ?? undefined;
  } catch (error) {
    // Older launchers do not provide environment configuration.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (config?.nix) Deno.env.set("TMPDIR", "/storage/loom-nix/tmp");
  const before = Deno.env.toObject();
  const env = await prepareEnvironment(config, {
    shell: before.LOOM_GUEST_SHELL!,
    initializeNix: initializeGuestNix,
    ...(output ? { output } : {}),
  });
  if (!env) {
    Deno.env.set("PATH", [before.LOOM_GUEST_CONTROL_PATH, before.PATH].filter(Boolean).join(":"));
    return;
  }
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  // The dev shell supplies tools and exports; Loom's provider
  // executables retain precedence and bootstrap settings remain available.
  Deno.env.set(
    "PATH",
    [before.LOOM_GUEST_CONTROL_PATH, env.PATH, before.PATH].filter(Boolean).join(":"),
  );
  for (const key of Object.keys(before))
    if (
      key.startsWith("LOOM_") ||
      [
        "HOME",
        "TMPDIR",
        "DENO_DIR",
        "DENO_NO_UPDATE_CHECK",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "CLAUDE_CODE_PROJECT_DIR_NAME",
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
    reportStartup("provider");
  });
