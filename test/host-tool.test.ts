import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { normalizeConfig } from "@loom/daemon/config/config";
import { parseConfig as parse } from "@loom/daemon/config/config";
import { readFileSync } from "node:fs";
import { exampleConfigPath } from "@loom/daemon/scaffold";
import { onPath } from "@loom/core/paths";

test("onPath finds a real binary and rejects a bogus one", () => {
  assert.equal(onPath("node"), true);
  assert.equal(onPath("definitely-not-a-real-binary-xyzzy"), false);
  // an explicit path is checked directly
  assert.equal(onPath("/definitely/not/here"), false);
});

test(
  "the example host tilth definition speaks MCP on stdio",
  { skip: onPath("tilth") ? false : "tilth is not installed" },
  async () => {
    const raw = parse(readFileSync(exampleConfigPath(), "utf8"));
    const mount = normalizeConfig({ ...raw, session: { "local-tools": ["tilth"] } }).mcp[0]!;
    assert.ok("command" in mount);
    const { command, args = [] } = mount;
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
