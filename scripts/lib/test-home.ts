// A throwaway HOME and XDG base directories for one `deno test` run, so the
// suite never reads or writes the developer's real Loom state, caches,
// config, Git identity or provider profiles. Production path resolution
// (`core/src/user-dirs.ts`) throws while LOOM_TEST_HOME is set if a path
// escapes it, and `test/test-home.test.ts` fails a bare `deno test test/`.
//
// Set LOOM_KEEP_TEST_HOME=1 to keep the directory for inspection.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { TEST_HOME_VARIABLE } from "../../core/src/user-dirs.ts";

const DIRECTORIES = {
  HOME: "home",
  XDG_STATE_HOME: "state",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_CONFIG_HOME: "config",
  XDG_RUNTIME_DIR: "runtime",
};

/** Real profile locations that would bypass HOME. */
const UNSET = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"];

/** Deno's module cache moves with HOME; pin it so child `deno` processes stay offline-capable. */
const denoDir = async (): Promise<string> => {
  const pinned = Deno.env.get("DENO_DIR");
  if (pinned) return pinned;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return (JSON.parse(new TextDecoder().decode(out.stdout)) as { denoDir: string }).denoDir;
};

export interface TestHome {
  root: string;
  /** The complete environment for the child run (use with `clearEnv: true`). */
  env: Record<string, string>;
  remove: () => Promise<void>;
}

export const createTestHome = async (): Promise<TestHome> => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "loom-test-home-" }));
  const env = Deno.env.toObject();
  for (const key of UNSET) delete env[key];
  Object.assign(env, {
    [TEST_HOME_VARIABLE]: root,
    DENO_DIR: await denoDir(),
    GIT_CONFIG_NOSYSTEM: "1",
  });
  for (const [variable, name] of Object.entries(DIRECTORIES)) {
    env[variable] = join(root, name);
    await Deno.mkdir(env[variable]!, { mode: 0o700 });
  }
  // A neutral global identity: commits work without the developer's ~/.gitconfig,
  // and tests that resolve identity from Git config still see config, not env.
  await Deno.writeTextFile(
    join(env["HOME"]!, ".gitconfig"),
    "[user]\n\tname = Loom test\n\temail = loom@example.invalid\n[init]\n\tdefaultBranch = main\n",
  );
  return {
    root,
    env,
    remove: async () => {
      if (Deno.env.get("LOOM_KEEP_TEST_HOME")) {
        console.error(`Kept test home: ${root}`);
        return;
      }
      // Git and Nix leave read-only files and directories behind.
      await new Deno.Command("chmod", { args: ["-R", "u+w", root] }).output();
      await Deno.remove(root, { recursive: true });
    },
  };
};

/** `test/` unless the arguments already name test files or directories. */
const withDefaultTarget = (args: string[]) =>
  args.some((arg) => !arg.startsWith("-") && existsSync(arg)) ? args : [...args, "test/"];

/** Run `deno test -A <args>` inside a fresh test home; resolves to its exit code. */
export const runIsolatedTests = async (
  args: string[],
  io: { stdout: "inherit" | "piped"; stderr: "inherit" | "piped" },
): Promise<{ code: number; stdout: string; stderr: string }> => {
  args = withDefaultTarget(args);
  const home = await createTestHome();
  // Ctrl-C reaches the child too; outlive it so the test home is still removed.
  const ignore = () => {};
  Deno.addSignalListener("SIGINT", ignore);
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["test", "-A", ...args],
      clearEnv: true,
      env: home.env,
      stdout: io.stdout,
      stderr: io.stderr,
    }).spawn();
    const text = (stream: ReadableStream<Uint8Array> | null) =>
      stream ? new Response(stream).text() : Promise.resolve("");
    const [stdout, stderr, status] = await Promise.all([
      io.stdout === "piped" ? text(child.stdout) : "",
      io.stderr === "piped" ? text(child.stderr) : "",
      child.status,
    ]);
    return { code: status.code, stdout, stderr };
  } finally {
    Deno.removeSignalListener("SIGINT", ignore);
    await home.remove();
  }
};
