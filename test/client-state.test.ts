import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, test as nodeTest } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type ClientState, LoomClient } from "@loom/client";
import { PROTOCOL_VERSION } from "@loom/core/wire";
import type { SessionInteraction } from "@loom/core/interaction";
import type { FakeProvider } from "@loom/connector-mock";
import type { DaemonSnapshot, SessionSnapshot } from "@loom/core/wire";
import { makeHarness, type Harness } from "@loom/harness";

const ctx = new AsyncLocalStorage<{ h: Harness }>();

const client = (reconnect = false): Promise<LoomClient> => {
  const { h } = ctx.getStore()!;
  return LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
    reconnect,
  });
};

const withHarness = async (fn: () => Promise<void>): Promise<void> => {
  const h = await makeHarness();
  try {
    await ctx.run({ h }, fn);
  } finally {
    await h.cleanup();
  }
};

const test = (name: string, fn: () => Promise<void>) => nodeTest(name, () => withHarness(fn));

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(5);
  }
};

/** The fleet as the client's current snapshot sees it, or null while pending. */
const fleet = (c: LoomClient): DaemonSnapshot | null => {
  const s = c.getState();
  return s.tag === "data" ? s.value : null;
};

const sessionIds = (c: LoomClient): string[] => (fleet(c)?.sessions ?? []).map((s) => s.id).sort();

describe("client state subscription", { concurrency: 4 }, () => {
  test("connect installs one complete snapshot; no session.list needed", async () => {
    const c = await client();
    const stub = await c.request<SessionSnapshot>("session.createStub", { prompt: "one" });

    await waitFor(() => sessionIds(c).includes(stub.id));
    const snap = fleet(c);
    assert.ok(snap, "a snapshot is installed");
    assert.equal(snap.daemon.repoRoot, ctx.getStore()!.h.repoRoot);
    assert.ok(snap.providers.length > 0, "providers ride the same snapshot");
    assert.equal(snap.sessions.find((s) => s.id === stub.id)?.title, "one");
    await c.close();
  });

  test("subscribe fires immediately with the current value, then on every change", async () => {
    const c = await client();
    const seen: ClientState[] = [];
    const unsubscribe = c.subscribe((s) => seen.push(s));
    assert.equal(seen.length, 1, "fires synchronously on subscribe");
    assert.equal(seen[0]?.tag, "data");

    const stub = await c.request<SessionSnapshot>("session.createStub", { prompt: "two" });
    await waitFor(() =>
      seen.some((s) => s.tag === "data" && s.value.sessions.some((x) => x.id === stub.id)),
    );

    unsubscribe();
    const countAtUnsubscribe = seen.length;
    await c.request("session.createStub", { prompt: "three" });
    await delay(50);
    assert.equal(seen.length, countAtUnsubscribe, "no deliveries after unsubscribe");
    await c.close();
  });

  test("additions and removals reach two clients through snapshots alone", async () => {
    const a = await client();
    const b = await client();

    const stub = await a.request<SessionSnapshot>("session.createStub", { prompt: "shared" });
    await waitFor(() => sessionIds(a).includes(stub.id) && sessionIds(b).includes(stub.id));

    await a.request("session.remove", { id: stub.id, force: true });
    await waitFor(() => !sessionIds(a).includes(stub.id) && !sessionIds(b).includes(stub.id));

    await a.close();
    await b.close();
  });

  test("a disconnect goes pending; reconnect carries changes made while away", async () => {
    const observer = await client(true);
    const driver = await client();
    // Record every transition — the reconnect can complete inside a poll
    // interval, so `pending` is only reliably observable as a state the client
    // passed *through*.
    const tags: Array<ClientState["tag"]> = [];
    observer.subscribe((s) => tags.push(s.tag));

    const before = await driver.request<SessionSnapshot>("session.createStub", {
      prompt: "before",
    });
    await waitFor(() => sessionIds(observer).includes(before.id));

    observer.dropForTest();

    // Both an addition and a removal land while the observer has no connection.
    const during = await driver.request<SessionSnapshot>("session.createStub", {
      prompt: "during",
    });
    await driver.request("session.remove", { id: before.id, force: true });

    await waitFor(() => {
      const ids = sessionIds(observer);
      return ids.includes(during.id) && !ids.includes(before.id);
    });

    assert.ok(tags.includes("pending"), `expected a pending state; saw ${tags.join(",")}`);
    // The first snapshot after reconnect is the whole current fleet, not a
    // patch applied to the stale one.
    assert.deepEqual(sessionIds(observer), sessionIds(driver));

    await observer.close();
    await driver.close();
  });

  test("no post-reconnect snapshot ever repopulates the pre-drop fleet", async () => {
    const observer = await client(true);
    const driver = await client();

    const before = await driver.request<SessionSnapshot>("session.createStub", {
      prompt: "before",
    });
    await waitFor(() => sessionIds(observer).includes(before.id));

    observer.dropForTest();
    await driver.request("session.remove", { id: before.id, force: true });
    const after = await driver.request<SessionSnapshot>("session.createStub", { prompt: "after" });
    await waitFor(() => sessionIds(observer).includes(after.id));

    // From here on, a frame from the superseded socket — or a stale response
    // settling late — could only show up as the removed session coming back.
    const regressions: string[][] = [];
    observer.subscribe((s) => {
      if (s.tag === "data" && s.value.sessions.some((x) => x.id === before.id)) {
        regressions.push(s.value.sessions.map((x) => x.id));
      }
    });
    await driver.request("session.createStub", { prompt: "settle" });
    await delay(100);

    assert.deepEqual(regressions, [], "the removed session never reappeared");
    assert.deepEqual(sessionIds(observer), sessionIds(driver));

    await observer.close();
    await driver.close();
  });

  test("close returns the state to idle", async () => {
    const c = await client();
    await waitFor(() => c.getState().tag === "data");
    await c.close();
    assert.equal(c.getState().tag, "idle");
  });
});

// ---------------------------------------------------------------------------
// protocol mismatch — terminal, in both directions
// ---------------------------------------------------------------------------

/** One accepted socket, from the stub daemon's side. */
interface StubConn {
  /** 1 for the first connection this stub accepted, 2 for the next, … */
  readonly nth: number;
  /** Write one raw line, exactly as given — malformed frames included. */
  send(line: string): Promise<void>;
  close(): void;
}

/**
 * A socket that speaks just enough of the wire protocol to be driven by hand:
 * the test decides what each `hello` is answered with, whether an opening
 * snapshot follows it and when, and what raw lines go out afterwards. A real
 * daemon can hold none of that back.
 *
 * `handshakes` counts accepted connections, which is how a client that retries
 * something no amount of retrying can fix gives itself away.
 */
const mkStubDaemon = async (
  sockPath: string,
  onHello: (helloId: number, conn: StubConn) => void | Promise<void>,
): Promise<{
  handshakes: () => number;
  received: () => ReadonlyArray<{ id: number; method: string }>;
  dropAll: () => void;
  close: () => Promise<void>;
}> => {
  const listener = Deno.listen({ transport: "unix", path: sockPath });
  let accepted = 0;
  const conns = new Set<Deno.Conn>();
  const enc = new TextEncoder();
  const received: Array<{ id: number; method: string }> = [];
  const loop = (async () => {
    for await (const conn of listener) {
      accepted++;
      const nth = accepted;
      conns.add(conn);
      const stub: StubConn = {
        nth,
        send: async (line) => {
          try {
            await conn.write(enc.encode(line + "\n"));
          } catch {
            /* the client hung up */
          }
        },
        close: () => {
          try {
            conn.close();
          } catch {
            /* already gone */
          }
          conns.delete(conn);
        },
      };
      void (async () => {
        const buf = new Uint8Array(64 * 1024);
        const dec = new TextDecoder();
        let acc = "";
        try {
          for (;;) {
            const n = await conn.read(buf);
            if (n === null) break;
            acc += dec.decode(buf.subarray(0, n), { stream: true });
            let nl: number;
            while ((nl = acc.indexOf("\n")) !== -1) {
              const line = acc.slice(0, nl);
              acc = acc.slice(nl + 1);
              // Every line as it arrived, so a test can check the client's own
              // framing rather than only what it does with the answers.
              const frame = JSON.parse(line) as { id: number; method: string };
              received.push(frame);
              if (frame.method !== "hello") continue;
              await onHello(frame.id, stub);
            }
          }
        } catch {
          // the client hanging up is the normal end of this
        }
      })();
    }
  })();
  const dropAll = (): void => {
    for (const c of conns) {
      try {
        c.close();
      } catch {
        /* already gone */
      }
    }
    conns.clear();
  };
  return {
    handshakes: () => accepted,
    received: (): ReadonlyArray<{ id: number; method: string }> => received,
    dropAll,
    close: async () => {
      dropAll();
      listener.close();
      await loop.catch(() => {});
    },
  };
};

const stubDaemonInfo = (repoRoot: string) => ({
  pid: 1,
  version: "x",
  startedAt: 0,
  repoRoot,
  epoch: "e",
});

/** A well-formed `hello` response, `over` patching the result. */
const helloLine = (id: number, repoRoot: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: "res",
    id,
    ok: true,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      seq: 0,
      daemon: stubDaemonInfo(repoRoot),
      replaying: false,
      ...over,
    },
  });

/** The opening snapshot a real daemon writes before its `hello` response. */
const stateLine = (repoRoot: string, state?: unknown): string =>
  JSON.stringify({
    kind: "push",
    type: "state",
    state: state ?? { daemon: stubDaemonInfo(repoRoot), providers: [], sessions: [] },
  });

const mismatchOf = (c: LoomClient): { daemon: number; client: number } | null => {
  const s = c.getState();
  return s.tag === "error" && s.error.kind === "protocol_mismatch"
    ? { daemon: s.error.daemon, client: s.error.client }
    : null;
};

nodeTest("a daemon that comes back on a different wire version stops the reconnect", async () => {
  const dir = await Deno.makeTempDir();
  const sockPath = `${dir}/loom.sock`;
  // First connection agrees, and completes properly — snapshot first, then the
  // hello response, which is the order a real daemon writes them in. The one
  // after a restart doesn't agree: the upgrade the user just installed brought a
  // daemon this client can't talk to. That is the lenient direction — the hello
  // succeeds and the *answer* is incompatible, so every frame shape from here
  // on is unknowable.
  const stub = await mkStubDaemon(sockPath, async (id, conn) => {
    if (conn.nth === 1) {
      await conn.send(stateLine(dir));
      await conn.send(helloLine(id, dir));
      return;
    }
    await conn.send(helloLine(id, dir, { protocolVersion: PROTOCOL_VERSION + 7 }));
  });
  const c = await LoomClient.connect({
    repoRoot: dir,
    sockPath,
    autospawn: false,
    reconnect: true,
  });
  try {
    assert.equal(stub.handshakes(), 1);
    stub.dropAll();

    await waitFor(() => mismatchOf(c) !== null, 5000);
    assert.deepEqual(mismatchOf(c), { daemon: PROTOCOL_VERSION + 7, client: PROTOCOL_VERSION });

    // The whole point: a mismatch is not a transient failure, so the loop must
    // not keep dialling — and must not fall back to a `pending` spinner that
    // says "reconnecting…" about something no amount of waiting will fix.
    const settled = stub.handshakes();
    await delay(500);
    assert.equal(stub.handshakes(), settled, "no further reconnect attempts");
    assert.deepEqual(mismatchOf(c), { daemon: PROTOCOL_VERSION + 7, client: PROTOCOL_VERSION });
  } finally {
    await c.close();
    await stub.close();
    await Deno.remove(dir, { recursive: true });
  }
});

nodeTest("a daemon that rejects our wire version reports its own, terminally", async () => {
  const dir = await Deno.makeTempDir();
  const sockPath = `${dir}/loom.sock`;
  // The strict direction, which is what a real daemon does: it refuses the
  // hello outright and names its version in the error's `data`.
  const stub = await mkStubDaemon(sockPath, (id, conn) =>
    conn.send(
      JSON.stringify({
        kind: "res",
        id,
        ok: false,
        error: {
          code: "protocol_mismatch",
          message: `client protocol ${PROTOCOL_VERSION} != daemon 99`,
          data: { daemon: 99 },
        },
      }),
    ),
  );
  try {
    await assert.rejects(
      () => LoomClient.connect({ repoRoot: dir, sockPath, autospawn: false, reconnect: true }),
      /wire protocol v99/,
      "the daemon's own version reaches the message the user reads",
    );
    const settled = stub.handshakes();
    await delay(400);
    assert.equal(stub.handshakes(), settled, "no reconnect attempts after the mismatch");
  } finally {
    await stub.close();
    await Deno.remove(dir, { recursive: true });
  }
});

nodeTest("a real daemon rejects a stale client version and says which it speaks", async () => {
  const h = await makeHarness();
  try {
    const c = await LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
    });
    try {
      await assert.rejects(
        () => c.request("hello", { protocolVersion: PROTOCOL_VERSION - 1, clientId: "old" }),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "protocol_mismatch");
          assert.deepEqual((err as { data?: unknown }).data, { daemon: PROTOCOL_VERSION });
          return true;
        },
      );
    } finally {
      await c.close();
    }
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// two clients over one authoritative request set
// ---------------------------------------------------------------------------

const requestsOf = (c: LoomClient, id: string): SessionInteraction[] =>
  (fleet(c)?.sessions.find((s) => s.id === id)?.requests ?? []) as SessionInteraction[];

nodeTest("a client attaching mid-request gets the whole thing in its first snapshot", async () => {
  const h = await makeHarness();
  const first = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  try {
    const provider = (await h.daemon.providers.get("fake")) as FakeProvider;
    const s = await first.request<SessionSnapshot>("session.create", {
      prompt: "mid-request attach",
      provider: "fake",
    });
    const fs = provider.session(s.id);
    assert.ok(fs);
    // Two outstanding requests of different kinds, raised long before the
    // second client existed — so nothing about them is on its push stream.
    fs.emit({ type: "permission_request", id: "p1", tool: "Bash", input: { command: "ls -la" } });
    fs.emit({ type: "plan_review", id: "pr1", plan: "1. carve the seam" });
    await waitFor(() => requestsOf(first, s.id).length === 2, 5000);

    const late = await LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
    });
    try {
      // Its very first snapshot — no history fetched, nothing replayed — has to
      // be enough to render and answer both requests. Reconstructing them from
      // the transcript was what made a second window show a blank request panel.
      const got = requestsOf(late, s.id);
      assert.deepEqual(
        got.map((r) => r.kind),
        ["permission", "plan_review"],
      );
      const perm = got[0];
      assert.ok(perm?.kind === "permission");
      assert.equal(perm.tool, "Bash");
      assert.deepEqual(perm.input, { command: "ls -la" });
      const plan = got[1];
      assert.ok(plan?.kind === "plan_review");
      assert.equal(plan.plan, "1. carve the seam");
      assert.deepEqual(got, requestsOf(first, s.id), "both windows show the same thing");
    } finally {
      await late.close();
    }
  } finally {
    await first.close();
    await h.cleanup();
  }
});

nodeTest(
  "answering one of several permissions retires exactly that one, in both clients",
  async () => {
    const h = await makeHarness();
    const a = await LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
    });
    const b = await LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
    });
    try {
      const provider = (await h.daemon.providers.get("fake")) as FakeProvider;
      const s = await a.request<SessionSnapshot>("session.create", {
        prompt: "parallel tools",
        provider: "fake",
      });
      const fs = provider.session(s.id);
      assert.ok(fs);
      // Parallel tool calls each raise their own gate; the turn stays blocked
      // until the last is answered.
      for (const id of ["p1", "p2", "p3"]) {
        fs.emit({ type: "permission_request", id, tool: "Bash", input: { command: id } });
      }
      await waitFor(
        () => requestsOf(a, s.id).length === 3 && requestsOf(b, s.id).length === 3,
        5000,
      );

      // One window answers the middle one.
      await b.request("session.respondPermission", {
        id: s.id,
        requestId: "p2",
        decision: "allow",
      });

      const ids = (c: LoomClient) => requestsOf(c, s.id).map((r) => r.id);
      await waitFor(() => ids(a).length === 2 && ids(b).length === 2, 5000);
      assert.deepEqual(ids(a), ["p1", "p3"], "exactly the answered one went");
      assert.deepEqual(ids(b), ["p1", "p3"]);
      assert.deepEqual(
        fs.permissionResponses.map((r) => r.id),
        ["p2"],
        "answered once, not thrice",
      );
    } finally {
      await a.close();
      await b.close();
      await h.cleanup();
    }
  },
);

nodeTest(
  "a connection dropped mid-create does not resubmit it, and the snapshot says what happened",
  async () => {
    const h = await makeHarness();
    const c = await LoomClient.connect({
      repoRoot: h.repoRoot,
      sockPath: h.sockPath,
      autospawn: false,
      reconnect: true,
    });
    try {
      const provider = (await h.daemon.providers.get("fake")) as FakeProvider;
      const release = provider.blockCreate();
      const creating = c.request<SessionSnapshot>("session.create", {
        prompt: "dropped-mid-create",
        provider: "fake",
      });
      // The row exists from the moment the daemon starts the create, so we know
      // the request arrived before pulling the socket out from under it.
      await waitFor(() => sessionIds(c).length === 1, 5000);
      c.dropForTest();

      // The caller is told the operation may have completed — and is *not* told
      // it failed, because a retry here is how you get two sessions.
      await assert.rejects(
        () => creating,
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "disconnected");
          return true;
        },
      );
      release();

      await waitFor(() => c.getState().tag === "data", 5000);
      const rows = fleet(c)?.sessions ?? [];
      assert.equal(
        rows.filter((r) => r.title === "dropped-mid-create").length,
        1,
        "the reconnect re-read the fleet; it did not create a second session",
      );
    } finally {
      await c.close();
      await h.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// §3: the transport and startup contract
// ---------------------------------------------------------------------------

/** A temp dir + socket path, cleaned up after `fn`. */
const withSock = async (fn: (dir: string, sockPath: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir, `${dir}/loom.sock`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
};

/** Has `p` settled either way within `ms`? For asserting it is still waiting. */
const settledWithin = async (p: Promise<unknown>, ms: number): Promise<boolean> => {
  const stillWaiting = Symbol("pending");
  const done = () => "settled" as const;
  return (await Promise.race([p.then(done, done), delay(ms, stillWaiting)])) !== stillWaiting;
};

nodeTest("connect waits for the opening snapshot, not just the hello response", async () => {
  await withSock(async (dir, sockPath) => {
    let release: (() => Promise<void>) | null = null;
    const stub = await mkStubDaemon(sockPath, async (id, conn) => {
      // Answer the handshake, but hold the snapshot back.
      await conn.send(helloLine(id, dir));
      release = () => conn.send(stateLine(dir));
    });
    try {
      const connecting = LoomClient.connect({ repoRoot: dir, sockPath, autospawn: false });
      await waitFor(() => release !== null);
      assert.equal(
        await settledWithin(connecting, 150),
        false,
        "connect is still waiting on the snapshot",
      );

      await release!();
      const c = await connecting;
      try {
        assert.equal(c.getState().tag, "data", "and resolves only once state is installed");
      } finally {
        await c.close();
      }
    } finally {
      await stub.close();
    }
  });
});

nodeTest("a handshake with no snapshot behind it fails and closes its socket", async () => {
  await withSock(async (dir, sockPath) => {
    // Never sends a snapshot at all. `connect()` must not hand back a client
    // whose fleet is permanently unknown.
    const stub = await mkStubDaemon(sockPath, (id, conn) => conn.send(helloLine(id, dir)));
    try {
      await assert.rejects(
        () =>
          LoomClient.connect({
            repoRoot: dir,
            sockPath,
            autospawn: false,
            reconnect: true,
            firstSnapshotMs: 250,
          }),
        /no state snapshot/,
      );
      // And it gave up rather than reconnecting into the same wait forever.
      const after = stub.handshakes();
      await delay(400);
      assert.equal(stub.handshakes(), after, "no reconnect attempts after the deadline");
    } finally {
      await stub.close();
    }
  });
});

nodeTest("malformed hello contents are rejected at the boundary", async () => {
  await withSock(async (dir, sockPath) => {
    // Valid JSON, valid envelope, but the result is not a hello: no `daemon`
    // block to read a repo root or an epoch from.
    const stub = await mkStubDaemon(sockPath, (id, conn) =>
      conn.send(JSON.stringify({ kind: "res", id, ok: true, result: { protocolVersion: 2 } })),
    );
    try {
      await assert.rejects(
        () => LoomClient.connect({ repoRoot: dir, sockPath, autospawn: false }),
        /malformed hello/,
      );
    } finally {
      await stub.close();
    }
  });
});

nodeTest("a malformed snapshot is never installed as current state", async () => {
  await withSock(async (dir, sockPath) => {
    let bad: (() => Promise<void>) | null = null;
    const stub = await mkStubDaemon(sockPath, async (id, conn) => {
      await conn.send(stateLine(dir));
      await conn.send(helloLine(id, dir));
      bad = async () => {
        // Valid JSON and a valid `state` discriminant, but `sessions` is not a
        // list of sessions — installing it would put a shape the fleet cannot
        // render behind every `tag === "data"` check in the app.
        await conn.send(
          stateLine(dir, { daemon: stubDaemonInfo(dir), providers: [], sessions: 7 }),
        );
      };
    });
    try {
      const c = await LoomClient.connect({
        repoRoot: dir,
        sockPath,
        autospawn: false,
        reconnect: false,
      });
      try {
        assert.equal(fleet(c)?.sessions.length, 0, "the good snapshot is installed");
        await waitFor(() => bad !== null);
        await bad!();

        // The frame is refused *and* the stream it came on is dropped: a peer
        // sending shapes we cannot read has already sent us frames we will
        // never know we missed.
        await waitFor(() => c.getState().tag !== "data", 3000);
        assert.equal(fleet(c), null, "no stale snapshot is presented as current");
      } finally {
        await c.close();
      }
    } finally {
      await stub.close();
    }
  });
});

nodeTest("a line the client cannot parse drops the connection", async () => {
  await withSock(async (dir, sockPath) => {
    let garbage: (() => Promise<void>) | null = null;
    const stub = await mkStubDaemon(sockPath, async (id, conn) => {
      await conn.send(stateLine(dir));
      await conn.send(helloLine(id, dir));
      garbage = () => conn.send("{not json");
    });
    try {
      const c = await LoomClient.connect({
        repoRoot: dir,
        sockPath,
        autospawn: false,
        reconnect: false,
      });
      try {
        assert.equal(c.getState().tag, "data");
        await waitFor(() => garbage !== null);
        await garbage!();
        await waitFor(() => c.getState().tag !== "data", 3000);
      } finally {
        await c.close();
      }
    } finally {
      await stub.close();
    }
  });
});

nodeTest("a dial that lands after close cannot reopen the client", async () => {
  await withSock(async (dir, sockPath) => {
    const stub = await mkStubDaemon(sockPath, async (id, conn) => {
      await conn.send(stateLine(dir));
      await conn.send(helloLine(id, dir));
    });
    const c = await LoomClient.connect({
      repoRoot: dir,
      sockPath,
      autospawn: false,
      reconnect: true,
    });
    try {
      // Take the daemon away entirely, so the reconnect loop is parked in its
      // backoff with a dial it cannot complete.
      await stub.close();
      await Deno.remove(sockPath).catch(() => {});
      await waitFor(() => c.getState().tag === "pending");

      // The caller finishes with the client while that loop is still running.
      await c.close();
      assert.equal(c.getState().tag, "idle");

      // Now the daemon comes back. A dial completing after `close()` is not a
      // reconnection — nothing may install a socket on a closed client.
      const revived = await mkStubDaemon(sockPath, async (id, conn) => {
        await conn.send(stateLine(dir));
        await conn.send(helloLine(id, dir));
      });
      try {
        await delay(600);
        assert.equal(revived.handshakes(), 0, "the closed client did not dial the new daemon");
        assert.equal(c.getState().tag, "idle", "and stayed closed");
      } finally {
        await revived.close();
      }
    } finally {
      await c.close().catch(() => {});
    }
  });
});

nodeTest("concurrent requests reach the daemon whole and in issue order", async () => {
  await withSock(async (dir, sockPath) => {
    const stub = await mkStubDaemon(sockPath, async (id, conn) => {
      await conn.send(stateLine(dir));
      await conn.send(helloLine(id, dir));
    });
    try {
      const c = await LoomClient.connect({
        repoRoot: dir,
        sockPath,
        autospawn: false,
        reconnect: false,
      });
      try {
        // Fifty fat frames issued in one turn. Unserialized, `writeAll`'s
        // partial writes interleave their halves and neither frame parses; the
        // stub's own reader would throw on the first corrupted line.
        const bulk = "z".repeat(64 * 1024);
        for (let i = 0; i < 50; i++) {
          void c.request("noop", { i, bulk }).catch(() => {}); // never answered
        }
        await waitFor(() => stub.received().filter((f) => f.method === "noop").length === 50, 5000);

        const ids = stub
          .received()
          .filter((f) => f.method === "noop")
          .map((f) => f.id);
        assert.deepEqual(
          ids,
          [...ids].sort((a, b) => a - b),
          "every frame arrived whole, exactly once, in the order it was issued",
        );
      } finally {
        await c.close();
      }
    } finally {
      await stub.close();
    }
  });
});
