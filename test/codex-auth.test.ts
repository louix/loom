import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { CodexAuthOwner, readCodexAccess } from "../backend/daemon/src/daemon/codex-auth.ts";
import { sessionAuth, writeSessionAuth } from "../runtime/src/session-vm/auth.ts";

test("sessions sharing an image receive separate single-provider credential files", async () => {
  const root = await Deno.makeTempDir();
  const claude = { CLAUDE_CODE_OAUTH_TOKEN: "claude-session-only" };
  const codex = {
    codexOauth: {
      accessToken: "codex-session-only",
      idToken: "identity",
      accountId: "account",
      expiresAt: Date.now() + 3600000,
    },
  };
  try {
    assert.throws(() => sessionAuth({ ...claude, ...codex }), /one session authentication source/);
    for (const name of ["claude", "codex", "preparation"]) await Deno.mkdir(join(root, name));
    await writeSessionAuth(join(root, "claude"), claude);
    await writeSessionAuth(join(root, "codex"), codex);
    await writeSessionAuth(join(root, "preparation"), {});
    assert.deepEqual(JSON.parse(await Deno.readTextFile(join(root, "claude/auth.json"))), claude);
    assert.deepEqual(JSON.parse(await Deno.readTextFile(join(root, "codex/auth.json"))), codex);
    assert.deepEqual(JSON.parse(await Deno.readTextFile(join(root, "preparation/auth.json"))), {});
    await assert.rejects(Deno.stat(join(root, "claude/codex.json")), Deno.errors.NotFound);
    await assert.rejects(Deno.stat(join(root, "preparation/codex.json")), Deno.errors.NotFound);
    const native = JSON.parse(await Deno.readTextFile(join(root, "codex/codex.json")));
    assert.equal(native.tokens.access_token, codex.codexOauth.accessToken);
    assert.equal(native.tokens.refresh_token, "");
    assert(!JSON.stringify(native).includes(claude.CLAUDE_CODE_OAUTH_TOKEN));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("Codex credential owner renews once and publishes access-only snapshots", async () => {
  const profile = await Deno.makeTempDir();
  const target = await Deno.makeTempDir();
  const write = async (expiry: number, revision: string) => {
    const jwt = `header.${Buffer.from(JSON.stringify({ exp: expiry / 1000 })).toString("base64url")}.${revision}`;
    await Deno.writeTextFile(
      join(profile, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: jwt,
          id_token: "identity",
          account_id: "account",
          refresh_token: "host-only-refresh",
        },
      }),
    );
  };
  // Refresh before native Codex enters its own five-minute refresh window.
  await write(Date.now() + 8 * 60_000, "old");
  let refreshes = 0;
  const owner = new CodexAuthOwner({
    profile,
    cli: "unused",
    refresh: async () => {
      refreshes++;
      await write(Date.now() + 3600000, "new");
    },
  });
  try {
    const [a, b] = await Promise.all([owner.current(), owner.current()]);
    assert.equal(refreshes, 1);
    assert.deepEqual(a, b);
    assert(!JSON.stringify(a).includes("host-only-refresh"));
    await writeSessionAuth(target, a);
    const native = JSON.parse(await Deno.readTextFile(join(target, "codex.json")));
    assert.equal(native.tokens.refresh_token, "");
    assert.equal(native.tokens.access_token, a.codexOauth.accessToken);
    assert.equal(native.tokens.account_id, "account");
    await Deno.writeTextFile(join(profile, "auth.json"), "{}");
    await assert.rejects(readCodexAccess(profile));
  } finally {
    await owner.close();
    await Deno.remove(profile, { recursive: true });
    await Deno.remove(target, { recursive: true });
  }
});
