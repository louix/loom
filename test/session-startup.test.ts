import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  readStartupProgress,
  classifyStartupFailure,
  startupFailures,
  startupMessage,
} from "../runtime/src/session-vm/progress.ts";
import { discardSessionDisks } from "../runtime/src/session-vm/disks.ts";
import { launchSessionVm } from "../backend/daemon/src/daemon/session-vm-worker.ts";
import { normalizeSessionEnvironment } from "../core/src/session-environment.ts";
import { repoBaseDirectory } from "../runtime/src/session-vm/repo-base.ts";
import { environmentPreparationRuntimes, environmentProviders } from "../cli/src/environment.ts";
import { normalizeConfig } from "../backend/daemon/src/config/config.ts";

test("environment warnings cover enabled runtimes once across provider profiles", () => {
  const config = normalizeConfig({
    providers: {
      codex: {
        profiles: {
          default: {},
          second: {},
        },
      },
      openai_compatible: {
        profiles: {
          generic: {
            base_url: "https://example.com/v1",
          },
        },
      },
    },
    session: {
      isolation: {
        enabled: true,
        claude: {
          artifact: "/claude",
          smolvm: "/backend",
        },
        codex: {
          artifact: "/codex",
          smolvm: "/backend",
        },
        aisdk: {
          artifact: "/aisdk",
          smolvm: "/backend",
        },
      },
    },
  });
  const providers = environmentProviders(config);
  assert(providers.some((id) => id.startsWith("claude")));
  assert(providers.includes("codex"));
  assert(providers.includes("generic"));
  assert.equal(providers.filter((id) => config.providers.aisdk[id]?.sdk === "chatgpt").length, 1);
  config.providerAccess.only = ["codex"];
  assert.deepEqual(environmentProviders(config), ["codex"]);
  config.providerAccess.disabled = ["codex"];
  assert.deepEqual(environmentProviders(config), []);
  config.providerAccess = { disabled: [] };
  config.isolation.codex = config.isolation.claude!;
  config.isolation.aisdk = config.isolation.claude!;
  assert.deepEqual(environmentProviders(config), [providers[0]]);
});

test("preparation uses available images with local defaults and no provider profiles", () => {
  const shared = { artifact: "/shared", smolvm: "/backend" };
  const custom = { artifact: "/custom", smolvm: "/backend" };
  const config = normalizeConfig({
    session: {
      isolation: {
        enabled: false,
        claude: shared,
        codex: shared,
        aisdk: custom,
      },
      provider_access: { only: ["codex"], disabled: ["codex"] },
    },
  });
  config.claudeProfiles = [];
  config.providers.aisdk = {};
  assert.deepEqual(environmentProviders(config), []);
  assert.deepEqual(environmentPreparationRuntimes(config), [shared, custom]);

  // Enabling isolation must not prepare shared images again via the active policies.
  Object.assign(config.isolation, config.isolation.runtimes);
  config.isolation.enabled = true;
  assert.deepEqual(environmentPreparationRuntimes(config), [shared, custom]);
});

test("preparation has no images when no runtime is available", () => {
  const config = normalizeConfig({ session: { isolation: { enabled: false } } });
  config.isolation.runtimes = {};
  assert.deepEqual(environmentPreparationRuntimes(config), []);
});

test("missing or incompatible Nix caches do not block session startup", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", root);
  const progress: string[] = [];
  let credentialsRead = false;
  const options = {
    artifact: root,
    smolvm: Deno.execPath(),
    workspace: root,
    repoRoot: root,
    sessionDirectory: join(root, "session"),
    environment: normalizeSessionEnvironment(undefined, true),
    onProgress: (message: string) => progress.push(message),
    authOwner: {
      current: () => {
        credentialsRead = true;
        throw new Error("credentials requested");
      },
      subscribe: async () => async () => {},
    },
  };
  try {
    const missing = /credentials requested/;
    await assert.rejects(launchSessionVm(options), missing);
    const home = repoBaseDirectory(root);
    await Deno.mkdir(join(home, "base-old/disks"), { recursive: true });
    await Deno.writeTextFile(join(home, "current.json"), JSON.stringify({ directory: "base-old" }));
    await Deno.writeTextFile(
      join(home, "base-old/disks/identity.json"),
      JSON.stringify({ version: 0 }),
    );
    await assert.rejects(launchSessionVm(options), missing);
    const { repoRoot: _repoRoot, ...withoutRepo } = options;
    await assert.rejects(launchSessionVm(withoutRepo), missing);
    assert.equal(credentialsRead, true);
    assert.deepEqual(progress, []);
    await assert.rejects(Deno.stat(options.sessionDirectory), Deno.errors.NotFound);
    await assert.rejects(Deno.stat(join(root, ".loom")), Deno.errors.NotFound);

    // Ordinary sessions and explicit preparation may still use the generic runtime.
    await assert.rejects(
      launchSessionVm({ ...options, environment: normalizeSessionEnvironment(undefined) }),
      /credentials requested/,
    );
    const { authOwner: _authOwner, ...preparation } = options;
    await assert.rejects(
      launchSessionVm({ ...preparation, preparationOnly: true, workspace: join(root, "absent") }),
      Deno.errors.NotFound,
    );
  } finally {
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    await Deno.remove(root, { recursive: true });
  }
});

test("startup phases survive fragmented stderr without publishing vendor output", async () => {
  const chunks = [
    'private-token\n{"loomStart',
    'up":"boot"}\n',
    "x".repeat(1000),
    '\n{"loomStartup":"toString"}\n{"loomStartup":"activate","secret":"ignored"}\n',
    '{"loomStartup":"prepare"}\n',
  ];
  const stages: string[] = [];
  await readStartupProgress(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    (stage) => stages.push(stage),
  );
  assert.deepEqual(stages, ["boot", "activate", "prepare"]);
});

test("startup diagnostics expose only known causes and bounded elapsed times", async () => {
  const messages: string[] = [];
  const failures: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const value of [
        { loomStartup: "boot", elapsedSeconds: 30 },
        { loomStartup: "boot", elapsedSeconds: "secret-token" },
        { loomStartupFailure: "devices", stderr: "secret-token" },
        { loomStartupFailure: "secret-token" },
        { loomStartupFailure: "toString" },
      ])
        c.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
      c.close();
    },
  });
  await readStartupProgress(
    stream,
    (stage, elapsed) => messages.push(startupMessage(stage, elapsed)),
    (code) => failures.push(startupFailures[code]),
  );
  assert.deepEqual(messages, ["Starting VM… (30s elapsed)", "Starting VM…"]);
  assert.deepEqual(failures, [startupFailures.devices]);
  assert.equal(
    classifyStartupFailure(new Error("no more IRQs are available: secret-token")),
    "devices",
  );
  assert.equal(classifyStartupFailure(new Error("ENOSPC: secret-token")), "space");
  assert.equal(classifyStartupFailure(new Error("Permission denied: secret-token")), "permission");
  assert.equal(classifyStartupFailure(new Error("unrecognized: secret-token")), "backend");
});

test("discarding legacy guest disks preserves host profiles and worktree changes", async () => {
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(home, "session/disks"), { recursive: true });
    await Deno.mkdir(join(home, "session/profile"));
    await Deno.writeTextFile(join(home, "session/disks/storage.raw"), "guest-only");
    await Deno.writeTextFile(join(home, "session/profile/history"), "conversation");
    await Deno.writeTextFile(join(home, "unstaged"), "host change");
    await discardSessionDisks(join(home, "session"));
    await discardSessionDisks(join(home, "session"));
    await assert.rejects(Deno.stat(join(home, "session/disks")), Deno.errors.NotFound);
    assert.equal(await Deno.readTextFile(join(home, "session/profile/history")), "conversation");
    assert.equal(await Deno.readTextFile(join(home, "unstaged")), "host change");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
