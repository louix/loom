import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { makeHarness } from "@loom/harness";
import { LoomClient } from "@loom/client";
import { FakeProvider } from "@loom/connector-mock";
import type { ConnectorManifest } from "@loom/core/connector";
import type { SessionSnapshot } from "@loom/core/wire";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";

test("VM and local sessions share a provider, keep modes across restart, and fork across modes", async () => {
  const state = mkdtempSync(join(tmpdir(), "loom-isolation-"));
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", state);
  const calls: Array<{ id: string; mode: "vm" | "local"; operation: "create" | "resume" }> = [];
  const instances = new Map<string, FakeProvider>();
  const builds: string[] = [];
  const connectors: ConnectorManifest = {
    "@loom/connector-claude": async () => ({
      createProvider: (ctx) => {
        const mode = ctx.config.sessionVm ? "vm" : "local";
        builds.push(mode);
        const fake = new FakeProvider();
        const ready = async (id: string, session: ReturnType<FakeProvider["createSession"]>) => {
          const s = await session;
          Object.defineProperty(s, "providerRef", { value: id });
          instances.set(id, fake);
          if (ctx.config.sessionVm) {
            const history = join(
              sessionVmDirectory(ctx.config.sessionVm.repoRoot, id),
              "profile/projects/loom-session",
            );
            mkdirSync(history, { recursive: true });
            writeFileSync(join(history, `${id}.jsonl`), "saved VM history");
          }
          return s;
        };
        return {
          id: ctx.id,
          capabilities: fake.capabilities,
          listPersistedSessions: () => fake.listPersistedSessions(),
          createSession: (opts) => {
            calls.push({ id: opts.sessionId, mode, operation: "create" });
            return ready(opts.sessionId, fake.createSession(opts));
          },
          resumeSession: (opts) => {
            calls.push({ id: opts.sessionId, mode, operation: "resume" });
            return ready(opts.sessionId, fake.resumeSession(opts));
          },
        };
      },
    }),
  };
  const config = (enabled: boolean) =>
    `[titles]\nenabled=false\n[auto_resume]\nenabled=false\n[isolation.claude]\nartifact="/test-runtime"\nenabled=${enabled}\n`;
  const h = await makeHarness({ connectors, config: config(true) });
  let c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  const idle = async (s: SessionSnapshot) => {
    instances.get(s.id)!.session(s.id)!.finishTurn();
    for (let i = 0; i < 100; i++) {
      if ((await c.request<SessionSnapshot>("session.get", { id: s.id })).status.kind === "idle")
        return;
      await delay(5);
    }
    throw new Error("session did not become idle");
  };
  try {
    const vm = await c.request<SessionSnapshot>("session.create", {
      prompt: "VM default",
      provider: "claude",
    });
    const local = await c.request<SessionSnapshot>("session.create", {
      prompt: "local override",
      provider: "claude",
      isolation: "local",
    });
    const local2 = await c.request<SessionSnapshot>("session.create", {
      prompt: "local too",
      provider: "claude",
      isolation: "local",
    });
    assert.equal(vm.isolation, "vm");
    assert.equal(local.isolation, "local");
    assert.ok(local.worktree, "local execution still has Git isolation");
    assert.deepEqual(
      builds,
      ["vm", "local"],
      "cache is separated by mode, shared within each mode",
    );
    await idle(vm);
    await idle(local);
    await idle(local2);
    const fork = await c.request<SessionSnapshot>("session.fork", {
      id: vm.id,
      isolation: "local",
    });
    assert.equal(fork.isolation, "local");
    assert.equal(
      calls.find((x) => x.id === fork.id)?.operation,
      "create",
      "cross-mode forks do not resume native history",
    );
    await idle(fork);
    const inherited = await c.request<SessionSnapshot>("session.fork", { id: vm.id });
    assert.equal(inherited.isolation, "vm");
    await idle(inherited);
    await assert.rejects(
      c.request("session.create", {
        prompt: "bad",
        provider: "claude",
        isolation: "vm",
        worktree: false,
      }),
      /requires a worktree/,
    );
    await assert.rejects(
      c.request("session.create", { prompt: "bad", provider: "claude", isolation: "other" }),
      /invalid parameters/,
    );

    // Upgrade rows predating the mode column using saved history, not the new default.
    h.daemon.db
      .prepare("UPDATE sessions SET isolation = NULL WHERE id IN (?, ?)")
      .run(inherited.id, local2.id);
    await c.close();
    writeFileSync(h.configPath, config(false));
    await h.restart();
    c = await LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });
    assert.equal(h.daemon.registry.get(inherited.id)?.isolation, "vm");
    assert.equal(h.daemon.registry.get(local2.id)?.isolation, "local");
    for (const s of [vm, local]) {
      const resumed = await c.request<SessionSnapshot>("session.resume", { id: s.id });
      assert.equal(resumed.isolation, s.isolation);
      assert.equal(calls.filter((x) => x.id === s.id).at(-1)?.mode, s.isolation);
    }
    const newDefault = await c.request<SessionSnapshot>("session.create", {
      prompt: "now local",
      provider: "claude",
    });
    assert.equal(newDefault.isolation, "local");
    const explicitVm = await c.request<SessionSnapshot>("session.create", {
      prompt: "still available",
      provider: "claude",
      isolation: "vm",
    });
    assert.equal(explicitVm.isolation, "vm");
  } finally {
    await c.close();
    await h.cleanup();
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    rmSync(state, { recursive: true, force: true });
  }
});

test("VM selection without a runtime fails before allocating a session", async () => {
  const h = await makeHarness({ config: "[titles]\nenabled=false\n" });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    await assert.rejects(
      c.request("session.create", { prompt: "no runtime", provider: "claude", isolation: "vm" }),
      /No VM runtime/,
    );
    assert.deepEqual(await c.request("session.list"), []);
  } finally {
    await c.close();
    await h.cleanup();
  }
});

test("Claude, Codex and AI SDK providers select independent runtimes and cache capabilities by mode", async () => {
  const { normalizeConfig } = await import("@loom/daemon/config/config");
  const { ProviderRegistry } = await import("@loom/daemon/daemon/provider-registry");
  const { ProviderMessageStore } = await import("@loom/daemon/store/provider-messages");
  const { openDb } = await import("@loom/daemon/store/db");
  const config = normalizeConfig({
    providers: {
      generic: { adapter: "aisdk", model: "fixture", base_url: "https://example.com" },
      codex: {
        adapter: "aisdk",
        sdk: "chatgpt",
        model: "fixture",
        codex_cli_path: Deno.execPath(),
      },
    },
    isolation: {
      claude: { enabled: false, artifact: "/claude", smolvm: Deno.execPath() },
      codex: { enabled: false, artifact: "/codex", smolvm: Deno.execPath() },
      aisdk: { enabled: false, artifact: "/aisdk", smolvm: Deno.execPath() },
    },
  });
  const seen: Array<{ id: string; artifact: string | undefined }> = [];
  const load: ConnectorManifest[string] = async () => ({
    createProvider: (ctx) => {
      const fake = new FakeProvider();
      seen.push({ id: ctx.id, artifact: ctx.config.sessionVm?.artifact });
      Object.defineProperty(fake, "capabilities", {
        value: { ...fake.capabilities, rewind: !!ctx.config.sessionVm },
      });
      return fake;
    },
  });
  const db = openDb(":memory:");
  const registry = new ProviderRegistry(config, new ProviderMessageStore(db), {
    "@loom/connector-claude": load,
    "@loom/connector-chatgpt": load,
    "@loom/connector-generic": load,
  });
  try {
    for (const [id, artifact] of [
      ["claude", "/claude"],
      ["codex", "/codex"],
      ["generic", "/aisdk"],
    ]) {
      assert.equal(registry.defaultIsolation(id!), "local");
      const local = await registry.get(id!, "local");
      const vm = await registry.get(id!, "vm");
      assert.notEqual(vm, local);
      assert.equal(await registry.get(id!), local);
      assert.deepEqual(
        seen.filter((x) => x.id === id).map((x) => x.artifact),
        [undefined, artifact],
      );
      assert.equal(registry.capsOf(id!, "local")?.rewind, false);
      assert.equal(registry.capsOf(id!, "vm")?.rewind, true);
    }
  } finally {
    for (const provider of registry.live()) await provider.close?.();
    db.close();
  }
});
