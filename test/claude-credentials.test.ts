import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  claudeCredentialServices,
  readClaudeCredentials,
} from "../backend/daemon/src/daemon/claude-credentials.ts";

test("Claude Keychain names match the native CLI and never fall back across profiles", () => {
  assert.deepEqual(claudeCredentialServices("/Users/louix/.claude-personal", "/Users/louix"), [
    "Claude Code-credentials-b3a9e189",
  ]);
  assert.equal(
    claudeCredentialServices("/Users/louix/.claude", "/Users/louix").at(-1),
    "Claude Code-credentials",
  );
});
test("Claude uses Keychain credentials before a stale file and falls back when locked", async () => {
  const profile = await Deno.makeTempDir();
  try {
    const old = { claudeAiOauth: { accessToken: "old" } };
    const current = { claudeAiOauth: { accessToken: "current" } };
    await Deno.writeTextFile(join(profile, ".credentials.json"), JSON.stringify(old));
    assert.deepEqual(await readClaudeCredentials(profile, async () => current), current);
    assert.deepEqual(
      await readClaudeCredentials(profile, async () => {
        throw new Error("locked");
      }),
      old,
    );
    const services: string[] = [];
    await readClaudeCredentials(profile, async (service) => {
      services.push(service);
    });
    assert.equal(services.length, 1);
    assert(!services.includes("Claude Code-credentials"));
  } finally {
    await Deno.remove(profile, { recursive: true });
  }
});
