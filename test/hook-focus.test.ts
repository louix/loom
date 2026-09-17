import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { normalizeConfig } from "@loom/daemon/config/config";
import { HookRunner } from "@loom/daemon/daemon/hooks";
import { makeLogger } from "@loom/core/logger";
import { SocketServer } from "@loom/daemon/daemon/server";
import { RpcDispatcher } from "@loom/daemon/daemon/rpc";
import { LoomClient } from "@loom/client";
import { makeHarness } from "@loom/harness";
import type { FakeProvider } from "@loom/connector-mock";
import { terminalFocus } from "../frontend/tui/src/terminal-focus.ts";

test("hook delivery conditions validate and default to always", () => {
  const hook = { on: ["waiting", "turn_end"], run: "true" };
  assert.equal(normalizeConfig({ hooks: [hook] }).hooks[0]?.when, "always");
  for (const when of ["always", "unfocused", "disconnected"]) {
    assert.equal(normalizeConfig({ hooks: [{ ...hook, when }] }).hooks[0]?.when, when);
  }
  assert.throws(() => normalizeConfig({ hooks: [{ ...hook, when: "typo" }] }));
  assert.throws(() =>
    normalizeConfig({
      hooks: [
        {
          kind: "check",
          on: "turn_end",
          run: "true",
          when: "unfocused",
        },
      ],
    }),
  );
});

test("waiting and turn_end hooks use current presence without replaying skipped events", async () => {
  const dir = await Deno.makeTempDir();
  const output = join(dir, "hooks");
  let presence = { connected: false, focused: false };
  const runner = new HookRunner({
    repoRoot: dir,
    log: makeLogger("test"),
    onFeedback: async () => {},
    onNotice: () => {},
    tuiPresence: () => presence,
  });
  runner.setHooks(
    normalizeConfig({
      hooks: ["always", "unfocused", "disconnected"].map((when) => ({
        name: when,
        when,
        on: ["waiting", "turn_end"],
        run: `echo "$LOOM_HOOK $LOOM_HOOK_EVENT" >> ${output}`,
      })),
    }).hooks,
  );
  const session = {
    id: "s",
    title: null,
    provider: "fake",
    model: null,
    status: "idle",
    worktree: dir,
    branch: null,
  };
  try {
    for (const [connected, focused, expected] of [
      [false, false, ["always", "unfocused", "disconnected"]],
      [true, false, ["always", "unfocused"]],
      [true, true, ["always"]],
      [true, false, ["always", "unfocused"]],
    ] as const) {
      presence = { connected, focused };
      for (const event of ["waiting", "turn_end"] as const) {
        Deno.writeTextFileSync(output, "");
        if (event === "waiting") runner.waiting(session, "permission");
        else runner.turnEnded(session);
        const deadline = Date.now() + 3000;
        while (runner.isRunning(session.id)) {
          assert.ok(Date.now() < deadline);
          await delay(10);
        }
        assert.deepEqual(
          readFileSync(output, "utf8").trim().split("\n").sort(),
          expected.map((name) => `${name} ${event}`).sort(),
        );
      }
    }
  } finally {
    runner.close();
    await Deno.remove(dir, { recursive: true });
  }
});

test("TUI focus belongs to a connection, aggregates, and disappears on disconnect", async () => {
  const dir = await Deno.makeTempDir();
  const dispatcher = new RpcDispatcher();
  const server = new SocketServer({ sockPath: join(dir, "sock"), dispatcher });
  dispatcher.register("tui.focus", (params, ctx) => {
    ctx.conn.tuiFocused = params.focused;
  });
  await server.listen();
  const a = await Deno.connect({ transport: "unix", path: join(dir, "sock") });
  const b = await Deno.connect({ transport: "unix", path: join(dir, "sock") });
  const send = async (conn: Deno.UnixConn, focused: boolean | null) => {
    await conn.write(
      new TextEncoder().encode(
        JSON.stringify({
          kind: "req",
          id: 1,
          method: "tui.focus",
          params: { focused },
        }) + "\n",
      ),
    );
    const response = new Uint8Array(1024);
    await conn.read(response);
  };
  try {
    await send(a, false);
    assert.deepEqual(server.tuiPresence, { connected: true, focused: false });
    await send(b, true);
    assert.deepEqual(server.tuiPresence, { connected: true, focused: true });
    b.close();
    const deadline = Date.now() + 3000;
    while (server.tuiPresence.focused) {
      assert.ok(Date.now() < deadline);
      await delay(10);
    }
    assert.deepEqual(server.tuiPresence, { connected: true, focused: false });
    await send(a, null);
    assert.deepEqual(server.tuiPresence, { connected: false, focused: false });
  } finally {
    a.close();
    try {
      b.close();
    } catch {
      /* already closed */
    }
    await server.close();
    await Deno.remove(dir, { recursive: true });
  }
});

test("terminal focus reports initial state, changes, reconnects and cleanup", () => {
  const reports: unknown[] = [];
  let reconnect: (() => void) | undefined;
  const focus = terminalFocus({
    request: <T>(_method: string, params?: unknown): Promise<T> => {
      reports.push(params);
      return Promise.resolve(undefined as T);
    },
    on: (_event, fn) => {
      reconnect = fn;
      return () => {
        reconnect = undefined;
      };
    },
  });
  const stop = focus.start();
  focus.set(false);
  focus.set(false);
  reconnect?.();
  focus.set(true);
  stop();
  assert.equal(reconnect, undefined);
  assert.deepEqual(
    reports,
    [true, false, false, true, null].map((focused) => ({ focused })),
  );
});

test("daemon wires TUI focus to notification hooks; ordinary CLI subscribers do not count", async () => {
  const dir = await Deno.makeTempDir();
  const output = join(dir, "hooks");
  const h = await makeHarness({
    config: JSON.stringify({
      hooks: [
        {
          on: "turn_end",
          when: "unfocused",
          run: `echo fired >> ${output}`,
        },
      ],
    }),
  });
  const client = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    await assert.rejects(client.request("tui.focus", { focused: "false" }));
    const fire = async () => {
      const s = await client.request<{ id: string }>("session.create", {
        prompt: "hello",
        provider: "fake",
      });
      const provider = (await h.daemon.providers.get("fake")) as FakeProvider;
      provider.session(s.id)!.finishTurn();
      await delay(100);
    };
    await client.request("tui.focus", { focused: true });
    await fire();
    assert.equal(existsSync(output), false);
    await client.request("tui.focus", { focused: false });
    await fire();
    assert.equal(readFileSync(output, "utf8").trim(), "fired");
    await client.request("tui.focus", { focused: null });
    await fire();
    assert.equal(readFileSync(output, "utf8").trim(), "fired\nfired");
  } finally {
    await client.close();
    await h.cleanup();
    await Deno.remove(dir, { recursive: true });
  }
});
