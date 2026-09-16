import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  availableRepositories,
  readRecentRepositories,
  rememberRepository,
} from "../cli/src/recent-repositories.ts";

test("repository history is ordered, deduplicated, validated and tolerant of corruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-recent-"));
  const history = join(dir, "state", "repositories.json");
  try {
    const repos = ["one", "two"].map((name) => {
      const repo = join(dir, name);
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", repo]);
      return repo;
    });
    assert.deepEqual(readRecentRepositories(history), []);
    rememberRepository(repos[0]!, history);
    rememberRepository(repos[1]!, history);
    rememberRepository(repos[0]!, history);
    assert.deepEqual(readRecentRepositories(history), repos);
    rmSync(repos[1]!, { recursive: true });
    assert.deepEqual(availableRepositories(history), [repos[0]]);
    writeFileSync(history, '{"broken"');
    assert.deepEqual(readRecentRepositories(history), []);
    rememberRepository(repos[0]!, history);
    assert.deepEqual(availableRepositories(history), [repos[0]]);
    writeFileSync(history, JSON.stringify([null, 42, "../relative", repos[0], repos[0]]));
    assert.deepEqual(readRecentRepositories(history), [repos[0]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository launcher replaces scoped clients across switches", async () => {
  const { launchRepositoryTui } = await import("../cli/src/tui-launcher.ts");
  const dir = mkdtempSync(join(tmpdir(), "loom-switch-"));
  try {
    const repos = ["one", "two"].map((name) => {
      const path = join(dir, name);
      mkdirSync(path);
      execFileSync("git", ["init", "-q", path]);
      return path;
    });
    const entry = join(dir, "client.ts");
    const trace = join(dir, "trace.jsonl");
    writeFileSync(
      entry,
      `
      const repo = Deno.args[1];
      const socket = repo + "/.loom/daemon.sock";
      const exact = await Deno.permissions.query({ name: "net", host: "unix:" + socket });
      const broad = await Deno.permissions.query({ name: "net" });
      if (exact.state !== "granted" || broad.state === "granted") Deno.exit(9);
      await Deno.writeTextFile(${JSON.stringify(trace)}, JSON.stringify({ repo, parent: Deno.ppid }) + "\\n", { append: true });
      if (repo === ${JSON.stringify(repos[0])}) {
        await Deno.writeTextFile(Deno.env.get("LOOM_TUI_HANDOFF")!, ${JSON.stringify(repos[1])});
      }
    `,
    );
    assert.equal(await launchRepositoryTui(entry, repos[0]!), 0);
    const rows = (await Deno.readTextFile(trace))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows,
      repos.map((repo) => ({ repo, parent: Deno.pid })),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
