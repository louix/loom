import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { CodexAuthOwner, readCodexAccess } from "../backend/daemon/src/daemon/codex-auth.ts";
import { writeSessionAuth } from "../runtime/src/session-vm/auth.ts";

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
  await write(Date.now() + 1000, "old");
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
