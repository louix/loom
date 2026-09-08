import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  assertNoActiveVm,
  finishSessionState,
  lockSessionState,
} from "../runtime/src/session-vm/persistence.ts";
import {
  sessionVmDirectory,
  stoppedSessionVm,
} from "../backend/daemon/src/daemon/session-vm-state.ts";
import { startMcpRelay } from "../runtime/src/session-vm/mcp-relay.ts";

test("persistent VM ownership blocks cleanup and preserves a newer owner's marker", async () => {
  const root = await Deno.makeTempDir();
  const previous = Deno.env.get("XDG_STATE_HOME");
  Deno.env.set("XDG_STATE_HOME", root);
  const dir = sessionVmDirectory(root, "session-1");
  let lock: Deno.FsFile | undefined;
  try {
    assert.throws(() => sessionVmDirectory(root, "../escape"));
    lock = await lockSessionState(dir);
    await Deno.mkdir(join(dir, "profile"));
    await Deno.writeTextFile(join(dir, "profile/history"), "retained");
    await Deno.writeTextFile(join(dir, "active.json"), JSON.stringify({ token: "first" }));
    await assert.rejects(stoppedSessionVm(root, "session-1", true), /still running/);
    lock.close();
    lock = undefined;
    await assert.rejects(stoppedSessionVm(root, "session-1", true), /cleanup is incomplete/);
    await finishSessionState(dir, "other");
    await assert.rejects(assertNoActiveVm(dir), /cleanup is incomplete/);
    await finishSessionState(dir, "first");
    await stoppedSessionVm(root, "session-1");
    assert.equal(await Deno.readTextFile(join(dir, "profile/history")), "retained");
    await stoppedSessionVm(root, "session-1", true);
    await assert.rejects(Deno.stat(join(dir, "profile")), Deno.errors.NotFound);
    assert((await Deno.stat(join(dir, "owner.lock"))).isFile);
  } finally {
    lock?.close();
    if (previous === undefined) Deno.env.delete("XDG_STATE_HOME");
    else Deno.env.set("XDG_STATE_HOME", previous);
    await Deno.remove(root, { recursive: true });
  }
});

test("MCP socket forwards to its fixed loopback endpoint and shutdown disconnects clients", async () => {
  const dir = await Deno.makeTempDir();
  const host = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const relay = startMcpRelay(join(dir, "mcp.sock"), host.addr.port);
  let client: Deno.UnixConn | undefined, upstream: Deno.TcpConn | undefined;
  try {
    client = await Deno.connect({ transport: "unix", path: join(dir, "mcp.sock") });
    upstream = await host.accept();
    await client.write(new TextEncoder().encode("request with bearer header"));
    const buf = new Uint8Array(100);
    const size = await upstream.read(buf);
    assert.equal(new TextDecoder().decode(buf.subarray(0, size!)), "request with bearer header");
    await upstream.write(new TextEncoder().encode("response"));
    assert.equal(new TextDecoder().decode(buf.subarray(0, (await client.read(buf))!)), "response");
    await relay.close();
    assert.equal(await client.read(buf), null);
  } finally {
    await relay.close();
    for (const conn of [client, upstream])
      try {
        conn?.close();
      } catch {
        /*closed*/
      }
    host.close();
    await Deno.remove(dir, { recursive: true });
  }
});
