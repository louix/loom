import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  advertisesBranchesUnder,
  genericBranchPrefix,
  sessionBranch,
} from "../backend/daemon/src/daemon/session-branch.ts";
import { loadConfig, normalizeConfig } from "@loom/daemon/config/config";

const ID = "abcd1234-1111-2222-3333-444444444444";

test("sessionBranch", () => {
  assert.equal(sessionBranch(["loom"], "abcd1234"), "loom/abcd1234");
  assert.equal(sessionBranch(["me", "x"], "fix-login"), "me/x/fix-login");
  assert.equal(sessionBranch([], "fix-login"), "fix-login");
});

test("genericBranchPrefix", () => {
  assert.deepEqual(genericBranchPrefix(ID, "loom/abcd1234"), ["loom"]);
  assert.deepEqual(genericBranchPrefix(ID, `loom/${ID}`), ["loom"]);
  assert.deepEqual(genericBranchPrefix(ID, "me/x/abcd1234"), ["me", "x"]);
  assert.deepEqual(genericBranchPrefix(ID, "abcd1234"), []);
  assert.deepEqual(genericBranchPrefix(ID, ID), []);
  assert.equal(genericBranchPrefix(ID, "loom/fix-login"), null);
  assert.equal(genericBranchPrefix(ID, "fix-login"), null);
  assert.equal(genericBranchPrefix(ID, "loom/abcd12345"), null);
  assert.equal(genericBranchPrefix(ID, "loom/ffff0000"), null);
  assert.equal(genericBranchPrefix(ID, null), null);
});

test("advertisesBranchesUnder", () => {
  assert.equal(advertisesBranchesUnder("refs/heads/loom/", ["loom"]), true);
  assert.equal(advertisesBranchesUnder("refs/heads/loom/abc", ["loom"]), true);
  assert.equal(advertisesBranchesUnder("refs/heads/", ["loom"]), true);
  assert.equal(advertisesBranchesUnder("refs/heads/me", ["me", "x"]), true);
  assert.equal(advertisesBranchesUnder("refs/heads/develop", []), true);
  assert.equal(advertisesBranchesUnder("refs/heads/develop", ["loom"]), false);
  assert.equal(advertisesBranchesUnder("refs/heads/lo", ["loom"]), false);
  assert.equal(advertisesBranchesUnder("refs/heads/me/y", ["me", "x"]), false);
  assert.equal(advertisesBranchesUnder("refs/tags/", []), false);
  assert.equal(advertisesBranchesUnder("refs/heads/fix/", ["fix", "login"]), true);
});

test("session.branch_prefix defaults to loom and accepts nested or empty prefixes", () => {
  assert.deepEqual(normalizeConfig({}).branchPrefix, ["loom"]);
  assert.deepEqual(normalizeConfig({ session: { branch_prefix: "me/x" } }).branchPrefix, [
    "me",
    "x",
  ]);
  assert.deepEqual(normalizeConfig({ session: { branch_prefix: "" } }).branchPrefix, []);
});

test("session.branch_prefix refuses what git check-ref-format refuses, saying what is allowed", () => {
  for (const value of [
    "/loom",
    "loom/",
    "me//loom",
    "a..b",
    ".hidden",
    "-dash",
    "x.lock",
    "@",
    "a@{b",
    "has space",
    "tab\there",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
  ])
    assert.throws(
      () => normalizeConfig({ session: { branch_prefix: value } }),
      /session\.branch_prefix: must be "" \(no prefix\) or Git ref components joined by single slashes, like loom or me\/loom/,
      value,
    );
  assert.throws(
    () => normalizeConfig({ session: { branch_prefix: 3 } }),
    /session\.branch_prefix: expected string/,
  );
});

test("session.clone.visible_refs may not cover the configured prefix's branches", () => {
  assert.deepEqual(
    normalizeConfig({
      session: { branch_prefix: "me/x", clone: { visible_refs: ["refs/heads/loom/"] } },
    }).clone?.visibleRefs,
    ["refs/heads/loom/"],
  );
  assert.throws(
    () => normalizeConfig({ session: { clone: { visible_refs: ["refs/heads/loom/"] } } }),
    /session\.clone\.visible_refs\[0\]: covers the branches of sessions \(session\.branch_prefix "loom"/,
  );
  assert.throws(
    () =>
      normalizeConfig({
        session: { branch_prefix: "", clone: { visible_refs: ["refs/tags/", "refs/heads/dev"] } },
      }),
    /session\.clone\.visible_refs\[1\]: covers the branches of sessions \(session\.branch_prefix ""/,
  );
});

test("a repos[] entry overrides session.branch_prefix for its repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-branch-prefix-"));
  try {
    const repo = join(dir, "repo");
    const config = join(dir, "config.jsonc");
    writeFileSync(
      config,
      JSON.stringify({
        session: { branch_prefix: "me/x" },
        repos: [{ path: repo, session: { branch_prefix: "" } }],
      }),
    );
    assert.deepEqual(loadConfig(repo, config).branchPrefix, []);
    assert.deepEqual(loadConfig(join(dir, "other"), config).branchPrefix, ["me", "x"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
