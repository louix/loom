import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMcpCommand, TILTH_FALLBACK } from "../src/daemon/mcp-fallback.ts";
import { onPath } from "../src/util/paths.ts";

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
  const r = resolveMcpCommand("tilth mcp --edit", (c) => c === "tilth");
  assert.deepEqual(r, { command: "tilth", args: ["mcp", "--edit"] });
});

test("resolveMcpCommand: tilth missing but npx present → pinned npx fallback", () => {
  const r = resolveMcpCommand("tilth mcp --edit", (c) => c === "npx");
  assert.equal(r.command, "npx");
  assert.deepEqual(r.args, ["-y", TILTH_FALLBACK, "mcp", "--edit"]);
  assert.match(r.note ?? "", /npx/);
});

test("resolveMcpCommand: tilth and npx both missing → left as-is with a note", () => {
  const r = resolveMcpCommand("tilth mcp --edit", () => false);
  assert.equal(r.command, "tilth");
  assert.deepEqual(r.args, ["mcp", "--edit"]);
  assert.match(r.note ?? "", /both missing/);
});
