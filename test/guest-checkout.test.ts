import assert from "node:assert/strict";
import { join } from "node:path";
import { gitRelayFixture } from "../scripts/lib/git-relay-fixture.ts";
import {
  CheckoutError,
  checkoutSchema,
  prepareCheckout,
  publishCheckout,
  pushCheckout,
} from "../runtime/src/session-vm/checkout.ts";

const identity = { name: "Loom (test-model)", email: "loom+test-model@localhost" };

const setup = async () => {
  const f = await gitRelayFixture();
  const env = {
    HOME: f.root,
    PATH: Deno.env.get("PATH") ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const options = { remote: f.url, env };
  const path = join(f.root, "checkout");
  const spec = { path, branch: "loom/own", base: "main", identity };
  // The agent's commits carry no author environment, so the configured identity applies.
  const commit = async (cwd: string, name: string) => {
    await Deno.writeTextFile(join(cwd, name), `${name}\n`);
    for (const args of [
      ["add", name],
      ["commit", "-qm", name],
    ]) {
      const done = await new Deno.Command("git", { args, cwd, clearEnv: true, env }).output();
      assert.ok(done.success, new TextDecoder().decode(done.stderr));
    }
  };
  return { f, options, path, spec, commit };
};

Deno.test("first start builds the clone beside provider files and publishes commits", async () => {
  const { f, options, path, spec, commit } = await setup();
  try {
    // Codex creates its directories in the workspace before the guest starts.
    await Deno.mkdir(join(path, ".codex"), { recursive: true });
    const first = await prepareCheckout(spec, options);
    assert.equal(first.created, true);
    assert.equal(first.head, await f.git(f.host, "rev-parse", "loom/own"));
    assert.equal(await f.git(path, "symbolic-ref", "--short", "HEAD"), "loom/own");
    assert.equal(await Deno.readTextFile(join(path, "file.txt")), "base\n");
    assert.equal(
      await f.git(path, "branch", "-r", "--format=%(refname:short)"),
      "origin/loom/own\norigin/main",
    );
    assert.equal(await f.git(path, "config", "user.name"), identity.name);
    assert.equal(await f.git(path, "config", "user.email"), identity.email);
    assert.equal(await f.git(path, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/loom/own");

    assert.deepEqual(await pushCheckout(spec, options), { pushed: false, head: first.head });
    await commit(path, "work.txt");
    const pushed = await pushCheckout(spec, options);
    assert.equal(pushed.pushed, true);
    assert.equal(await f.git(f.host, "rev-parse", "loom/own"), pushed.head);
    assert.equal(
      await f.git(f.host, "log", "-1", "--format=%an <%ae>", "loom/own"),
      `${identity.name} <${identity.email}>`,
    );
    // A plain `git push` from the agent lands on the same ref.
    await commit(path, "more.txt");
    await f.git(path, "push", "-q");
    assert.equal(await f.git(f.host, "log", "-1", "--format=%s", "loom/own"), "more.txt");
    assert.equal((await pushCheckout(spec, options)).pushed, false);
  } finally {
    await f.close();
  }
});

Deno.test("resume keeps unpublished work and repairs the remote", async () => {
  const { f, options, path, spec, commit } = await setup();
  try {
    await prepareCheckout(spec, options);
    await commit(path, "unpushed.txt");
    await Deno.writeTextFile(join(path, "dirty.txt"), "dirty\n");
    await f.git(path, "remote", "set-url", "origin", "git://127.0.0.1:1/elsewhere");
    await f.git(path, "config", "user.name", "Someone else");
    const head = await f.git(path, "rev-parse", "HEAD");

    const again = await prepareCheckout(
      { ...spec, identity: { ...identity, name: "Loom (next)" } },
      options,
    );
    assert.deepEqual(again, { created: false, head });
    assert.equal(await Deno.readTextFile(join(path, "dirty.txt")), "dirty\n");
    assert.equal(await f.git(path, "remote", "get-url", "origin"), f.url);
    assert.equal(await f.git(path, "config", "user.name"), "Loom (next)");
    assert.equal((await pushCheckout(spec, options)).pushed, true);
    assert.equal(await f.git(f.host, "rev-parse", "loom/own"), head);
  } finally {
    await f.close();
  }
});

Deno.test("an interrupted first start continues", async () => {
  const { f, options, path, spec } = await setup();
  try {
    await Deno.mkdir(path);
    await f.git(path, "init", "-q");
    const result = await prepareCheckout(spec, options);
    assert.equal(result.created, true);
    assert.equal(await f.git(path, "symbolic-ref", "--short", "HEAD"), "loom/own");
  } finally {
    await f.close();
  }
});

Deno.test("a host rename moves the local branch with its unpublished commits", async () => {
  const { f, options, path, spec, commit } = await setup();
  try {
    await prepareCheckout(spec, options);
    await commit(path, "unpushed.txt");
    const head = await f.git(path, "rev-parse", "HEAD");
    await f.git(f.host, "branch", "-m", "loom/own", "loom/fix-login");
    await f.setPolicy({ branch: "loom/fix-login", base: "main" });

    const renamed = { ...spec, branch: "loom/fix-login" };
    assert.deepEqual(await prepareCheckout(renamed, options), { created: false, head });
    assert.equal(await f.git(path, "symbolic-ref", "--short", "HEAD"), "loom/fix-login");
    assert.equal(await f.git(path, "branch", "--format=%(refname:short)"), "loom/fix-login");
    assert.equal(
      await f.git(path, "branch", "-r", "--format=%(refname:short)"),
      "origin/loom/fix-login\norigin/main",
    );
    assert.equal((await pushCheckout(renamed, options)).pushed, true);
    assert.equal(await f.git(f.host, "rev-parse", "loom/fix-login"), head);
    assert.equal(
      await f.git(path, "rev-parse", "--abbrev-ref", "@{upstream}"),
      "origin/loom/fix-login",
    );
  } finally {
    await f.close();
  }
});

Deno.test("turn end follows a rename made while the session runs", async () => {
  const { f, options, path, spec, commit } = await setup();
  try {
    await prepareCheckout(spec, options);
    await commit(path, "first.txt");
    assert.equal((await publishCheckout(spec, options)).pushed, true);
    // The title arrives mid-session: the host renames its ref and republishes the spec.
    await f.git(f.host, "branch", "-m", "loom/own", "loom/fix-login");
    await f.setPolicy({ branch: "loom/fix-login", base: "main" });
    await commit(path, "second.txt");
    const renamed = {
      ...spec,
      branch: "loom/fix-login",
      identity: { ...identity, name: "Loom (b)" },
    };
    const published = await publishCheckout(renamed, options);
    assert.equal(published.pushed, true);
    assert.equal(await f.git(f.host, "rev-parse", "loom/fix-login"), published.head);
    assert.equal(await f.git(path, "symbolic-ref", "--short", "HEAD"), "loom/fix-login");
    assert.equal(await f.git(path, "config", "user.name"), "Loom (b)");
    assert.equal((await publishCheckout(renamed, options)).pushed, false);
  } finally {
    await f.close();
  }
});

Deno.test("a copied parent clone becomes the fork's own branch", async () => {
  const { f, options, path, spec, commit } = await setup();
  try {
    await prepareCheckout(spec, options);
    await commit(path, "parent.txt");
    await pushCheckout(spec, options);
    await Deno.writeTextFile(join(path, "dirty.txt"), "dirty\n");
    const parentTip = await f.git(f.host, "rev-parse", "loom/own");

    // The daemon copies the directory and creates the child's ref at the parent's tip.
    const child = join(f.root, "child");
    const copied = await new Deno.Command("cp", { args: ["-a", path, child] }).output();
    assert.ok(copied.success);
    await f.git(f.host, "branch", "loom/child", parentTip);
    await f.setPolicy({ branch: "loom/child", base: "main" });

    const fork = { ...spec, path: child, branch: "loom/child" };
    assert.deepEqual(await prepareCheckout(fork, options), { created: false, head: parentTip });
    assert.equal(await f.git(child, "symbolic-ref", "--short", "HEAD"), "loom/child");
    assert.equal(await Deno.readTextFile(join(child, "dirty.txt")), "dirty\n");
    // The parent's branch is a hidden sibling now, so its tracking ref is pruned.
    assert.equal(
      await f.git(child, "branch", "-r", "--format=%(refname:short)"),
      "origin/loom/child\norigin/main",
    );
    await commit(child, "child.txt");
    await pushCheckout(fork, options);
    assert.equal(await f.git(f.host, "log", "-1", "--format=%s", "loom/child"), "child.txt");
    assert.equal(await f.git(f.host, "rev-parse", "loom/own"), parentTip);
  } finally {
    await f.close();
  }
});

Deno.test("setup reports Git's own failure and rejects unsafe input", async () => {
  const { f, options, path, spec } = await setup();
  try {
    await f.setPolicy({ branch: "loom/missing", base: "main" });
    await assert.rejects(
      prepareCheckout({ ...spec, branch: "loom/missing" }, options),
      (error) => error instanceof CheckoutError && /git checkout failed/.test(error.message),
    );
    await f.relay.close();
    await assert.rejects(prepareCheckout(spec, options), CheckoutError);
    for (const bad of [
      { ...spec, path: "relative" },
      { ...spec, path: "/" },
      { ...spec, branch: "--upload-pack=sh" },
      { ...spec, base: "a..b" },
      { ...spec, extra: true },
    ])
      assert.ok(!checkoutSchema.safeParse(bad).success);
    assert.ok(path.startsWith(f.root));
  } finally {
    await f.close();
  }
});
