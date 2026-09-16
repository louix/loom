import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../backend/daemon/src/config/config.ts";
import { detectNixActivation } from "../core/src/nix-activation.ts";
import { environmentEnabled } from "../core/src/session-environment.ts";

const settings = true;
const fixture = async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "loom-bare-environment-" }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  const commit = () => {
    git(seed, "add", ".");
    git(
      seed,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
  };
  const bare = join(root, "bare");
  return { root, seed, bare, git, commit };
};

test("bare repo Nix detection reads committed root files and preserves checkout detection", async () => {
  const f = await fixture();
  try {
    await Deno.mkdir(join(f.seed, "nested"));
    await Deno.writeTextFile(join(f.seed, "nested/flake.nix"), "");
    await Deno.writeTextFile(join(f.seed, "nested/default.nix"), "");
    f.commit();
    f.git(f.root, "clone", "--bare", f.seed, f.bare);
    assert.equal(detectNixActivation(f.bare, settings), undefined);

    const update = () => {
      f.commit();
      f.git(f.bare, "fetch", f.seed, "main:main");
    };
    await Deno.writeTextFile(join(f.seed, "default.nix"), "");
    update();
    assert.deepEqual(detectNixActivation(f.bare, settings), {
      kind: "default",
    });
    assert.equal(detectNixActivation(f.bare, false), undefined);
    await Deno.writeTextFile(join(f.seed, "shell.nix"), "");
    update();
    assert.deepEqual(detectNixActivation(f.bare, settings), { kind: "shell" });
    await Deno.writeTextFile(join(f.seed, "flake.nix"), "");
    update();
    assert.deepEqual(detectNixActivation(f.bare, settings), { kind: "flake" });
    assert.equal(detectNixActivation(f.bare, false), undefined);
    assert.equal(await Deno.stat(join(f.bare, "flake.nix")).catch(() => null), null);

    const linked = join(f.root, "linked");
    f.git(f.bare, "worktree", "add", "--detach", linked, "HEAD");
    await Deno.remove(join(linked, "flake.nix"));
    assert.deepEqual(detectNixActivation(linked, settings), { kind: "shell" });
    await Deno.remove(join(linked, "shell.nix"));
    assert.equal(detectNixActivation(linked, settings)?.kind, "default");
    await Deno.remove(join(linked, "default.nix"));
    assert.equal(
      detectNixActivation(linked, settings),
      undefined,
      "do not fall back to bare HEAD from a checkout",
    );
    assert.deepEqual(detectNixActivation(linked, true, true), {
      kind: "flake",
    });
    await Deno.writeTextFile(join(linked, "devenv.nix"), "");
    assert.deepEqual(detectNixActivation(linked, true), { kind: "devenv" });
    assert.deepEqual(detectNixActivation(linked, true, true), {
      kind: "flake",
    });

    const configFile = join(f.root, "config.jsonc");
    await Deno.writeTextFile(
      configFile,
      JSON.stringify({
        repos: [{ path: linked, session: { auto_nix: true } }],
      }),
    );
    const config = loadConfig(f.bare, configFile);
    assert.equal(config.isolation.environment?.autoNix, true);
    assert.equal(
      environmentEnabled(config.isolation.environment),
      true,
      "session startup carries activation permission",
    );

    await Deno.writeTextFile(
      configFile,
      JSON.stringify({
        session: {
          isolation: { environment: { command_prefix: ["custom-shell"] } },
        },
      }),
    );
    assert.deepEqual(loadConfig(f.bare, configFile).isolation.environment?.commandPrefix, [
      "custom-shell",
    ]);
    await Deno.writeTextFile(
      configFile,
      JSON.stringify({
        session: { auto_nix: false },
      }),
    );
    assert.equal(environmentEnabled(loadConfig(f.bare, configFile).isolation.environment), false);

    await Deno.remove(join(f.seed, "flake.nix"));
    await Deno.mkdir(join(f.seed, "flake.nix"));
    await Deno.writeTextFile(join(f.seed, "flake.nix/child"), "");
    update();
    assert.equal(
      detectNixActivation(f.bare, settings)?.kind,
      "shell",
      "directories are not Nix files",
    );

    const unborn = join(f.root, "unborn");
    f.git(f.root, "init", "--bare", unborn);
    assert.equal(detectNixActivation(unborn, settings), undefined);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

test("environment prepare detects bare HEAD and explains missing or disabled Nix shells", async () => {
  const f = await fixture();
  try {
    f.commit();
    f.git(f.root, "clone", "--bare", f.seed, f.bare);
    const configHome = join(f.root, "config");
    await Deno.mkdir(join(configHome, "loom"), { recursive: true });
    const configFile = join(configHome, "loom/config.jsonc");
    const config = {
      session: {
        auto_nix: true,
        isolation: {
          claude: {
            artifact: join(f.root, "unused-runtime"),
            smolvm: join(f.root, "missing-smolvm"),
          },
        },
      },
    };
    await Deno.writeTextFile(configFile, JSON.stringify(config));
    const prepare = async () => {
      const output = await new Deno.Command(Deno.execPath(), {
        cwd: f.bare,
        args: [
          "run",
          "-A",
          "--config",
          fileURLToPath(new URL("../deno.json", import.meta.url)),
          fileURLToPath(new URL("../cli/src/loom.ts", import.meta.url)),
          "environment",
          "prepare",
        ],
        env: { XDG_CONFIG_HOME: configHome },
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(20_000),
      }).output();
      assert.notEqual(output.code, 0);
      return new TextDecoder().decode(output.stderr);
    };
    assert.match(
      await prepare(),
      /No devenv.nix, flake.nix, shell.nix or default.nix found.*committed HEAD.*bare repos/,
    );
    await Deno.writeTextFile(join(f.seed, "default.nix"), "");
    f.commit();
    f.git(f.bare, "fetch", f.seed, "main:main");
    assert.match(await prepare(), /Configured smolvm executable was not found/);
    await Deno.writeTextFile(
      configFile,
      JSON.stringify({
        ...config,
        session: { auto_nix: false },
      }),
    );
    assert.match(await prepare(), /Nix auto-activation is disabled/);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});
