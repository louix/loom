/** `loom config convert`: Loom's config.jsonc into the versioned environment format. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configConvert, convertLoomConfig } from "../cli/src/config-convert.ts";
import { loadConfig } from "@loom/daemon/config/config";
import {
  parseEnvironmentUser,
  resolveEnvironmentConfig,
} from "@loom/environment-config/resolution";
import { parseProjectEnvironment } from "@loom/environment-config/resolution";

const convert = (raw: Record<string, unknown>) => convertLoomConfig(raw, "/config.jsonc");
const paths = (entries: Array<{ path: string }>) => entries.map((entry) => entry.path);

Deno.test("an empty config converts to Loom's explicit local, worktree default", () => {
  const report = convert({});
  assert.deepEqual(report.user, {
    version: 1,
    lifecycle: { workspace: "worktree", execution: "none", idle_stop_minutes: 10 },
  });
  assert.deepEqual(report.converted, []);
  assert.deepEqual(report.unsupported, []);
});

Deno.test("environment settings convert into host layers; Loom settings stay", () => {
  // Written with the deprecated names: they convert as the keys they now are.
  const report = convert({
    $schema: "./config.schema.json",
    default_provider: "claude",
    git: { name: "Loom ({model})" },
    tui: { include_event_log_in_editor: true },
    providers: { claude: { model: "claude-opus-5" } },
    session: {
      auto_nix: true,
      auto_resume: false,
      worktree: { enabled: true },
      isolation: {
        enabled: true,
        launcher: "legacy",
        network_presets: ["javascript"],
        extra_allowed_hosts: ["Example.COM"],
        environment: { cpus: 2, memory_mib: 4096, timeout_seconds: 60 },
        checkout: { mode: "clone", visible_refs: ["refs/tags/"] },
        claude: { artifact: "/nix/store/claude-runtime" },
      },
    },
    hooks: [
      { on: "workspace_prepare", run: "npm ci", timeout: 600 },
      { on: ["workspace_start", "turn_end"], run: "make dev", kind: "check" },
      { on: "workspace_start", run: "watch", async: true },
      { on: "workspace_start", run: "scoped", project: "~/dev/**" },
      { on: "waiting", run: "notify-send waiting" },
    ],
    surprise: true,
  });
  assert.deepEqual(report.user, {
    version: 1,
    environment: {
      nix: { auto: true },
      timeout_seconds: 60,
      resources: { cpus: 2, memory_mib: 4096 },
      prepare: [{ name: "npm", run: "npm ci", timeout_seconds: 600 }],
      start: [{ name: "make", run: "make dev", timeout_seconds: 30 }],
    },
    access: { network: { presets: ["javascript"], allowed_hosts: ["example.com"] } },
    lifecycle: { workspace: "clone", execution: "vm", idle_stop_minutes: 10 },
  });
  assert.deepEqual(
    report.converted.map((entry) => entry.from + " -> " + entry.to),
    [
      "session.isolation.network.allowed_hosts -> access.network.allowed_hosts",
      "session.isolation.network.presets -> access.network.presets",
      "session.defaults.isolation -> lifecycle.execution",
      "session.defaults.workspace -> lifecycle.workspace",
      "session.environment.auto_nix -> environment.nix.auto",
      "session.environment.timeout_seconds -> environment.timeout_seconds",
      "session.environment.cpus -> environment.resources.cpus",
      "session.environment.memory_mib -> environment.resources.memory_mib",
      "hooks[0] (workspace_prepare) -> environment.prepare",
      "hooks[1] (workspace_start) -> environment.start",
    ],
  );
  assert.deepEqual(
    report.converted.slice(0, 8).map((entry) => entry.note),
    [
      "written as deprecated session.isolation.extra_allowed_hosts",
      "written as deprecated session.isolation.network_presets",
      "written as deprecated session.isolation.enabled",
      "written as deprecated session.worktree.enabled and session.isolation.checkout.mode",
      "written as deprecated session.auto_nix",
      "written as deprecated session.isolation.environment.timeout_seconds",
      "written as deprecated session.isolation.environment.cpus",
      "written as deprecated session.isolation.environment.memory_mib",
    ],
  );
  assert.match(report.converted.at(-1)!.note!, /fails startup/);
  // Loom-owned settings are reported, never dropped silently.
  assert.deepEqual(paths(report.staysInLoomConfig), [
    "default_provider",
    "git",
    "tui",
    "providers",
    "session.auto_resume",
    "session.isolation.runtimes",
    "session.clone",
    "hooks[1] (turn_end)",
    "hooks[4] (waiting)",
  ]);
  // A removed setting is reported as such, not as a stranger.
  assert.deepEqual(paths(report.unsupported), [
    "session.isolation.launcher",
    "surprise",
    "hooks[2] (workspace_start)",
    "hooks[3] (workspace_start)",
  ]);
  assert.match(report.unsupported[0]!.reason, /no longer read/);
  assert.match(report.unsupported[2]!.reason, /async/);
  assert.match(report.unsupported[3]!.reason, /project-scoped/);
});

Deno.test("repo overrides become diffs; appended hooks are listed explicitly", () => {
  const report = convert({
    session: {
      isolation: { extra_allowed_hosts: ["global.example"], environment: { cpus: 2 } },
    },
    hooks: [{ on: "workspace_start", run: "global-start" }],
    repos: [
      {
        path: "/work/a",
        session: {
          worktree: { enabled: false },
          isolation: { extra_allowed_hosts: ["a.example"], environment: { memory_mib: 4096 } },
        },
        hooks: [{ on: "workspace_start", run: "a-start" }],
      },
      { path: "/work/b", base_branch: "trunk" },
      {
        path: "/work/c",
        session: { auto_nix: true, isolation: { environment: { command_prefix: ["nix-shell"] } } },
      },
    ],
  });
  assert.deepEqual(report.user.repos, [
    {
      path: "/work/a",
      environment: {
        resources: { memory_mib: 4096 },
        // Old repo hooks append to inherited ones; new arrays replace, so list both.
        start: [
          { name: "global-start", run: "global-start", timeout_seconds: 30 },
          { name: "a-start", run: "a-start", timeout_seconds: 30 },
        ],
      },
      // Old arrays replace inherited ones, as host network fields do.
      access: { network: { allowed_hosts: ["a.example"] } },
      lifecycle: { workspace: "in-place" },
    },
    { path: "/work/c", environment: { command_prefix: ["nix-shell"] } },
  ]);
  assert.deepEqual(paths(report.staysInLoomConfig), ["repos[1].session.defaults.base_branch"]);
  assert.deepEqual(paths(report.unsupported), ["repos[2].session.environment.auto_nix"]);
  assert.match(
    report.converted.find((entry) => entry.from === "repos[0].hooks[0] (workspace_start)")!.note!,
    /appended/,
  );

  // The output resolves to what Loom resolved for each repository.
  const user = parseEnvironmentUser(JSON.stringify(report.user));
  const empty = parseProjectEnvironment('{"version":1}');
  const a = resolveEnvironmentConfig(empty, user, ["/work/a"]);
  assert.deepEqual(a.extraAllowedHosts, ["a.example"]);
  assert.deepEqual(
    a.start.map((hook) => hook.run),
    ["global-start", "a-start"],
  );
  assert.deepEqual([a.environment.cpus, a.environment.memoryMiB], [2, 4096]);
  const other = resolveEnvironmentConfig(empty, user, ["/work/other"]);
  assert.deepEqual(other.extraAllowedHosts, ["global.example"]);
  assert.deepEqual(
    other.start.map((hook) => hook.run),
    ["global-start"],
  );
});

Deno.test("current names convert without notes; an ignored old name is reported", () => {
  const report = convert({
    session: {
      defaults: { isolation: "vm", workspace: "in-place" },
      isolation: {
        enabled: false,
        network: { allowed_hosts: ["example.com"], presets: ["rust"] },
      },
      titles: { enabled: false },
    },
  });
  assert.deepEqual(report.user, {
    version: 1,
    access: { network: { presets: ["rust"], allowed_hosts: ["example.com"] } },
    lifecycle: { workspace: "in-place", execution: "vm", idle_stop_minutes: 10 },
  });
  assert(report.converted.every((entry) => entry.note === undefined));
  assert.deepEqual(report.unsupported, [
    { path: "session.titles", reason: "no longer read: session titles are always generated" },
    {
      path: "session.isolation.enabled",
      reason: "ignored: session.defaults.isolation is also set",
    },
  ]);
});

Deno.test("a file Loom rejects is not converted", () => {
  assert.throws(
    () => convert({ session: { isolation: { checkout: { mode: "other" } } } }),
    /session\.defaults\.workspace/,
  );
  assert.throws(() => convert({ session: { environment: { nix: true } } }), /auto_nix/);
  assert.throws(() => convert({ repos: [{ path: "relative" }] }), /absolute/);
});

Deno.test("loom config convert reads only; --out never overwrites", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "loom-config-convert-" }));
  try {
    const source = join(root, "config.jsonc");
    const text = '// mine\n{"session":{"isolation":{"enabled":true}},"tui":{},}\n';
    await Deno.writeTextFile(source, text);
    const before = await Deno.stat(source);
    const printed = await configConvert({ file: source });
    assert.match(printed, /"execution": "vm"/);
    assert.match(printed, /stays in Loom config:\n {2}tui: TUI settings/);
    assert.match(printed, /Loom keeps reading/);

    const out = join(root, "environment.jsonc");
    const json = JSON.parse(await configConvert({ file: source, out, json: true }));
    assert.equal(json.written, out);
    assert.deepEqual(JSON.parse(await Deno.readTextFile(out)), json.user);
    parseEnvironmentUser(await Deno.readTextFile(out), out);
    await assert.rejects(configConvert({ file: source, out }), /Refusing to overwrite/);
    await assert.rejects(configConvert({ file: source, out: source }), /Refusing to overwrite/);
    assert.equal(await Deno.readTextFile(source), text);
    assert.equal((await Deno.stat(source)).mtime?.getTime(), before.mtime?.getTime());
    // Loom resolves the old file exactly as before, with the new file beside it.
    assert.equal(loadConfig(root, source).defaults.isolation, "vm");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Loom's daemon config ignores environment.jsonc and loom.json", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "loom-config-unchanged-" }));
  try {
    const repo = join(root, "repo");
    await Deno.mkdir(join(root, "loom"), { recursive: true });
    await Deno.mkdir(repo);
    const old = join(root, "loom/config.jsonc");
    const before = loadConfig(repo, old);
    assert.equal(before.defaults.isolation, "none", "new sessions stay local by default");
    await Deno.writeTextFile(
      join(root, "loom/environment.jsonc"),
      JSON.stringify({
        version: 1,
        lifecycle: { workspace: "clone", execution: "vm" },
        environment: { nix: { auto: true } },
      }),
    );
    await Deno.writeTextFile(
      join(repo, "loom.json"),
      JSON.stringify({ version: 1, environment: { resources: { cpus: 8 } } }),
    );
    assert.deepEqual(loadConfig(repo, old), before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the loom CLI converts without a repository or daemon", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "loom-config-convert-cli-" }));
  try {
    const source = join(root, "config.jsonc");
    await Deno.writeTextFile(source, '{"session":{"auto_nix":true}}');
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--deny-net",
        fileURLToPath(new URL("../cli/src/loom.ts", import.meta.url)),
        "config",
        "convert",
        source,
        "--json",
      ],
      cwd: root,
      env: { XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_STATE_HOME: join(root, "state") },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    const report = JSON.parse(new TextDecoder().decode(result.stdout));
    assert.deepEqual(report.user.environment, { nix: { auto: true } });
    // Nothing was scaffolded or started: no Loom config, no repository state.
    await assert.rejects(Deno.stat(join(root, "xdg-config")), Deno.errors.NotFound);
    await assert.rejects(Deno.stat(join(root, ".loom")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
