import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readClaudeAccount } from "@loom/daemon/config/claude-profile";

const mkProfile = (files: { credentials?: unknown; claudeJson?: unknown } = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "loom-claude-profile-"));
  if (files.credentials !== undefined) {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify(files.credentials));
  }
  if (files.claudeJson !== undefined) {
    writeFileSync(join(dir, ".claude.json"), JSON.stringify(files.claudeJson));
  }
  return dir;
};

test("readClaudeAccount maps subscriptionType to a login method and pulls the org", () => {
  const dir = mkProfile({
    credentials: { claudeAiOauth: { subscriptionType: "max" } },
    claudeJson: { oauthAccount: { organizationName: "Acme Corp", emailAddress: "a@acme.test" } },
  });
  try {
    assert.deepEqual(readClaudeAccount(dir), {
      loginMethod: "Claude Max account",
      org: "Acme Corp",
      email: "a@acme.test",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown subscriptionType degrades to a generic label", () => {
  const dir = mkProfile({ credentials: { claudeAiOauth: { subscriptionType: "galaxy" } } });
  try {
    assert.equal(readClaudeAccount(dir)?.loginMethod, "Claude account");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no readable files → null (when no ANTHROPIC_API_KEY in the env)", () => {
  const saved = process.env["ANTHROPIC_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];
  const dir = mkProfile({ credentials: "{ not json", claudeJson: "also broken" });
  try {
    assert.equal(readClaudeAccount(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
  }
});

test("the per-dir cache re-reads once a backing file's mtime moves", () => {
  const dir = mkProfile({
    credentials: { claudeAiOauth: { subscriptionType: "pro" } },
    claudeJson: { oauthAccount: { organizationName: "First" } },
  });
  try {
    assert.equal(readClaudeAccount(dir)?.org, "First");
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { organizationName: "Second" } }),
    );
    // bump mtime explicitly so the change is visible even at coarse fs resolution
    const future = new Date(Date.now() + 5_000);
    utimesSync(join(dir, ".claude.json"), future, future);
    assert.equal(readClaudeAccount(dir)?.org, "Second");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
