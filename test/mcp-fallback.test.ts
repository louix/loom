import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { resolveMcpCommand } from "@loom/daemon/daemon/mcp-fallback";
import { DEFAULT_CONFIG } from "@loom/daemon/config/config";
import { onPath } from "@loom/core/paths";

test("onPath finds a real binary and rejects a bogus one", () => {
  assert.equal(onPath("node"), true);
  assert.equal(onPath("definitely-not-a-real-binary-xyzzy"), false);
  // an explicit path is checked directly
  assert.equal(onPath("/definitely/not/here"), false);
});

test("resolveMcpCommand: a non-tilth command is split, never rewritten", () => {
  const r = resolveMcpCommand("fff-mcp --stdio", () => false);
  assert.deepEqual(r, { command: "fff-mcp", args: ["--stdio"] });
});

test("resolveMcpCommand: tilth present → used as-is", () => {
  const r = resolveMcpCommand("tilth --mcp --edit", (c) => c === "tilth");
  assert.deepEqual(r, { command: "tilth", args: ["--mcp", "--edit"] });
});

test("resolveMcpCommand: legacy `tilth mcp …` is healed to the `--mcp` flag", () => {
  const r = resolveMcpCommand("tilth mcp --edit", (c) => c === "tilth");
  assert.equal(r.command, "tilth");
  assert.deepEqual(r.args, ["--mcp", "--edit"]);
  assert.match(r.note ?? "", /--mcp/);
});

test("resolveMcpCommand: tilth missing → left as-is with a note", () => {
  const r = resolveMcpCommand("tilth mcp --edit", () => false);
  assert.equal(r.command, "tilth");
  assert.deepEqual(r.args, ["--mcp", "--edit"]);
  assert.match(r.note ?? "", /not installed/);
});

// The default `[[mcp]]` command is a contract with tilth's CLI — a syntax
// drift (e.g. `tilth mcp` vs the `--mcp` flag) makes the server exit
// instantly and its tools silently vanish from every session. Pin the
// shipped default to a live MCP handshake.
test(
  "the shipped default tilth command speaks MCP on stdio",
  { skip: onPath("tilth") ? false : "tilth is not installed" },
  async () => {
    const mount = DEFAULT_CONFIG.mcp[0]!;
    assert.ok("command" in mount);
    const { command, args: prefixArgs } = resolveMcpCommand(mount.command);
    const args = [...prefixArgs, ...(mount.args ?? [])];
    assert.equal(command, "tilth");
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    try {
      const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "loom-test", version: "0" },
        },
      });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

      const names = await new Promise<string[]>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for tools/list")),
          10_000,
        );
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`tilth exited early (code ${code})`));
        });
        child.stdout.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          for (const line of buf.split("\n").slice(0, -1)) {
            buf = buf.slice(line.length + 1);
            let msg: { id?: number; result?: { tools?: Array<{ name: string }> } };
            try {
              msg = JSON.parse(line);
            } catch {
              continue; // tilth may interleave non-JSON banner output
            }
            if (msg.id === 2) {
              clearTimeout(timer);
              resolve((msg.result?.tools ?? []).map((t) => t.name));
              return;
            }
          }
        });
      });

      assert.ok(names.includes("tilth_search"), `expected tilth_search, got: ${names.join(", ")}`);
      assert.ok(names.includes("tilth_write"), "--edit should enable the write tool");
    } finally {
      child.kill();
    }
  },
);
