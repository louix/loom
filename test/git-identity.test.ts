// test-run: own-process — replaces the Git identity variables every git subprocess in the process inherits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, normalizeConfig } from "../backend/daemon/src/config/config.ts";
import { resolveGitIdentity } from "../backend/daemon/src/config/git-identity.ts";
import { ProviderRegistry } from "../backend/daemon/src/daemon/provider-registry.ts";
import { WorkerProvider } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import type { AgentSession } from "../core/src/types.ts";

const IDENTITY_ENV = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
];

/** A repository whose ordinary identity is "Repo User", isolated from the host's Git config. */
const fixture = async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "loom-git-identity-" }));
  const saved = Object.fromEntries(
    [...IDENTITY_ENV, "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].map((k) => [k, Deno.env.get(k)]),
  );
  for (const key of IDENTITY_ENV) Deno.env.delete(key);
  Deno.env.set("GIT_CONFIG_GLOBAL", "/dev/null");
  Deno.env.set("GIT_CONFIG_NOSYSTEM", "1");
  const repo = join(root, "repo");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Repo User");
  git(repo, "config", "user.email", "repo@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  return {
    root,
    repo,
    git,
    /** `author|committer` of a commit, read from the commit object itself. */
    people: (cwd: string, rev = "HEAD") => {
      const object = git(cwd, "cat-file", "-p", rev);
      const person = (role: string) =>
        object.match(new RegExp(`^${role} (.+ <[^>]*>) \\d+ [+-]\\d{4}$`, "m"))?.[1];
      return `${person("author")}|${person("committer")}`;
    },
    async close() {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      await Deno.remove(root, { recursive: true });
    },
  };
};

Deno.test("host identity resolution keeps Git's author/committer and environment precedence", async () => {
  const f = await fixture();
  try {
    f.git(f.repo, "config", "author.name", "Original Author");
    const env = resolveGitIdentity(
      f.repo,
      undefined,
      {},
      {
        GIT_COMMITTER_NAME: "Environment Committer",
      },
    );
    assert.deepEqual(env, {
      GIT_AUTHOR_NAME: "Original Author",
      GIT_AUTHOR_EMAIL: "repo@example.com",
      GIT_COMMITTER_NAME: "Environment Committer",
      GIT_COMMITTER_EMAIL: "repo@example.com",
    });
    // EMAIL is Git's last resort for an address.
    f.git(f.repo, "config", "--unset", "user.email");
    assert.equal(
      resolveGitIdentity(f.repo, undefined, {}, { EMAIL: "fallback@example.com" })
        .GIT_COMMITTER_EMAIL,
      "fallback@example.com",
    );
    assert.equal(resolveGitIdentity(f.repo, undefined, {}, {}).GIT_AUTHOR_EMAIL, undefined);
    // An explicit Loom setting outranks every inherited source.
    assert.equal(
      resolveGitIdentity(
        f.repo,
        { committer: { name: "Configured" } },
        {},
        {
          GIT_COMMITTER_NAME: "Environment Committer",
        },
      ).GIT_COMMITTER_NAME,
      "Configured",
    );
    // The exact values commit in a checkout with no inherited identity at all.
    const clone = join(f.root, "clone");
    execFileSync("git", ["init", "-q", clone]);
    execFileSync(
      "git",
      ["-C", clone, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "x"],
      {
        env: { ...Deno.env.toObject(), ...env },
      },
    );
    assert.equal(
      f.people(clone),
      "Original Author <repo@example.com>|Environment Committer <repo@example.com>",
    );
  } finally {
    await f.close();
  }
});

Deno.test("host default < global < repository settings, per role and field", async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "config.jsonc");
    const resolve = async (config: unknown, environment: Record<string, string> = {}) => {
      await Deno.writeTextFile(file, JSON.stringify(config));
      return resolveGitIdentity(
        f.repo,
        loadConfig(f.repo, file).git,
        { model: "openai/gpt-6:astra" },
        environment,
      );
    };
    const host = {
      GIT_AUTHOR_NAME: "Repo User",
      GIT_AUTHOR_EMAIL: "repo@example.com",
      GIT_COMMITTER_NAME: "Repo User",
      GIT_COMMITTER_EMAIL: "repo@example.com",
    };
    assert.deepEqual(await resolve({}), host);
    // A custom committer leaves the author alone.
    assert.deepEqual(await resolve({ git: { committer: { name: "Loom ({model})" } } }), {
      ...host,
      GIT_COMMITTER_NAME: "Loom (openai/gpt-6:astra)",
    });
    // Author-only, and only the email.
    assert.deepEqual(await resolve({ git: { author: { email: "me@work.example" } } }), {
      ...host,
      GIT_AUTHOR_EMAIL: "me@work.example",
    });
    // Shared fields apply to both roles and beat the environment.
    const global = { name: "Global", email: "global@example.com" };
    assert.deepEqual(await resolve({ git: global }, { GIT_AUTHOR_NAME: "Environment" }), {
      GIT_AUTHOR_NAME: "Global",
      GIT_AUTHOR_EMAIL: "global@example.com",
      GIT_COMMITTER_NAME: "Global",
      GIT_COMMITTER_EMAIL: "global@example.com",
    });
    // A matching repository merges over the global settings field by field.
    assert.deepEqual(
      await resolve({
        git: { ...global, committer: { name: "Global Committer" } },
        repos: [
          {
            path: f.repo,
            git: { email: "repo-override@example.com", author: { name: "Repo Author" } },
          },
        ],
      }),
      {
        GIT_AUTHOR_NAME: "Repo Author",
        GIT_AUTHOR_EMAIL: "repo-override@example.com",
        GIT_COMMITTER_NAME: "Global Committer",
        GIT_COMMITTER_EMAIL: "repo-override@example.com",
      },
    );
    // Another repository's override does not apply here.
    assert.deepEqual(
      await resolve({ repos: [{ path: f.root, git: { name: "Elsewhere" } }] }),
      host,
    );
  } finally {
    await f.close();
  }
});

Deno.test("identity templates are literal, validated, and rejected when unknown", async () => {
  const f = await fixture();
  try {
    const config = normalizeConfig({
      git: { name: "Loom ({model}) via {profile}", email: "loom+{modelSlug}@localhost" },
    }).git;
    const env = resolveGitIdentity(
      f.repo,
      config,
      { model: "openai/gpt-6:astra", profile: "codex" },
      {},
    );
    assert.equal(env.GIT_AUTHOR_NAME, "Loom (openai/gpt-6:astra) via codex");
    assert.equal(env.GIT_COMMITTER_EMAIL, "loom+openai-gpt-6-astra@localhost");
    assert.equal(
      resolveGitIdentity(f.repo, config, {}, {}).GIT_AUTHOR_NAME,
      "Loom (unknown) via unknown",
    );
    // `$(...)` is text, never a shell expression.
    assert.equal(
      resolveGitIdentity(f.repo, { name: "$(id) {model}" }, { model: "m" }, {}).GIT_AUTHOR_NAME,
      "$(id) m",
    );
    assert.throws(
      () => resolveGitIdentity(f.repo, config, { model: "bad\nname" }, {}),
      /Invalid Git/,
    );
    assert.throws(
      () => resolveGitIdentity(f.repo, { name: "{typo}" }, {}, {}),
      /Unknown Git identity placeholder/,
    );
    for (const git of [
      { name: "{typo}" },
      { name: "Bad <name>" },
      { email: "" },
      { committer: { name: "ok", signingkey: "ABC" } },
      { gpgsign: true },
    ])
      assert.throws(() => normalizeConfig({ git }), /git\./);
  } finally {
    await f.close();
  }
});

Deno.test("local sessions commit as the resolved identity through the commit tool and the shell", async () => {
  const f = await fixture();
  const sessions: AgentSession[] = [];
  const registries: ProviderRegistry[] = [];
  const project = fileURLToPath(new URL("../", import.meta.url));
  const start = async (config: Record<string, unknown>, cwd: string, model?: string) => {
    // The trusted user file, with its repository overrides, as the daemon loads it.
    const file = join(f.root, "config.jsonc");
    await Deno.writeTextFile(file, JSON.stringify(config));
    const registry = new ProviderRegistry(
      loadConfig(f.repo, file),
      { load: () => [], count: () => 0, append() {}, replaceFrom() {}, clear() {}, copyTo() {} },
      {
        "@loom/connector-mock": async () => ({
          createProvider: () =>
            WorkerProvider.create("fake", (workspace) => ({
              ...mockLaunchSpec(workspace),
              entrypoint: fileURLToPath(new URL("./fixtures/commit-worker.ts", import.meta.url)),
              // A clean worker: no host Git config and no inherited identity.
              env: { PATH: Deno.env.get("PATH")!, HOME: f.root, GIT_CONFIG_NOSYSTEM: "1" },
              permissions: {
                read: [project, f.root],
                write: [f.root],
                run: true,
                env: true,
                net: [],
              },
            })),
        }),
      },
      f.repo,
    );
    registries.push(registry);
    const provider = await registry.get("fake");
    sessions.push(
      await provider.createSession({
        sessionId: crypto.randomUUID(),
        cwd,
        prompt: "commit",
        mode: "default",
        mcpServers: [],
        ...(model ? { model } : {}),
      }),
    );
  };
  try {
    // A session tree still carrying the identity older versions pinned there.
    const tree = join(f.root, "tree");
    f.git(f.repo, "config", "extensions.worktreeConfig", "true");
    f.git(f.repo, "worktree", "add", "-q", "-b", "loom/tree", tree);
    f.git(tree, "config", "--worktree", "user.name", "Loom (stale)");
    f.git(tree, "config", "--worktree", "user.email", "loom+stale@localhost");
    // Default: the user's own identity, with Git's environment overrides honoured.
    Deno.env.set("GIT_COMMITTER_EMAIL", "committer-env@example.com");
    await start({}, tree);
    for (const rev of ["HEAD", "HEAD~1"])
      assert.equal(
        f.people(tree, rev),
        "Repo User <repo@example.com>|Repo User <committer-env@example.com>",
      );
    assert.equal(f.git(tree, "log", "-2", "--format=%s"), "shell commit\ntool commit");
    Deno.env.delete("GIT_COMMITTER_EMAIL");

    // A custom committer only, in place: the author is still the user.
    await start(
      {
        git: {
          committer: { name: "Loom ({model}) via {profile}", email: "loom+{modelSlug}@localhost" },
        },
        repos: [{ path: f.repo, git: { author: { email: "me@work.example" } } }],
      },
      f.repo,
      "openai/gpt-6:astra",
    );
    for (const rev of ["HEAD", "HEAD~1"])
      assert.equal(
        f.people(f.repo, rev),
        "Repo User <me@work.example>|Loom (openai/gpt-6:astra) via fake <loom+openai-gpt-6-astra@localhost>",
      );
    // Propagation never rewrites the user's own repository configuration.
    assert.equal(
      f.git(f.repo, "config", "--local", "--get-regexp", "^(user|author|committer)\\."),
      "user.name Repo User\nuser.email repo@example.com",
    );
  } finally {
    for (const session of sessions) await session.close();
    for (const registry of registries) await registry.close();
    await f.close();
  }
});
