import assert from "node:assert/strict";
import { join } from "node:path";
import {
  ClaudeAuthOwner,
  ClaudeAuthError,
  type ClaudeAccess,
} from "../backend/daemon/src/daemon/claude-auth.ts";
import { sessionAuth, writeSessionAuth } from "../runtime/src/session-vm/auth.ts";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = async () => {
  const profile = await Deno.makeTempDir();
  const write = async (token: string, expiresAt = Date.now() + 3600_000) => {
    await Deno.writeTextFile(
      join(profile, "next.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: token,
          refreshToken: "test-refresh-secret",
          expiresAt,
          scopes: ["user:inference"],
        },
      }),
    );
    await Deno.rename(join(profile, "next.json"), join(profile, ".credentials.json"));
  };
  await write("initial");
  return { profile, write, close: () => Deno.remove(profile, { recursive: true }) };
};
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition did not settle");
    await pause(10);
  }
};
Deno.test("Claude forced refresh coalesces within and across owners and strips refresh secrets", async () => {
  const f = await fixture();
  let calls = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refresh = async () => {
    calls++;
    entered.resolve();
    await release.promise;
    await f.write("renewed");
  };
  const a = new ClaudeAuthOwner({ profile: f.profile, cli: "unused", refresh });
  const b = new ClaudeAuthOwner({ profile: f.profile, cli: "unused", refresh });
  try {
    const first = a.current(true);
    await entered.promise;
    const second = b.current(true);
    const third = a.current(true);
    await pause(30);
    release.resolve();
    const values = await Promise.all([first, second, third]);
    assert.equal(calls, 1);
    assert(values.every((v) => v.claudeAiOauth.accessToken === "renewed"));
    assert(!JSON.stringify(values).includes("refresh-secret"));
  } finally {
    release.resolve();
    await a.close();
    await b.close();
    await f.close();
  }
});
Deno.test("Claude refresh retries preserve an unexpired access token and apply backoff", async () => {
  const f = await fixture();
  let calls = 0;
  await f.write("initial", Date.now() + 60_000);
  const owner = new ClaudeAuthOwner({
    profile: f.profile,
    cli: "unused",
    refresh: async () => {
      calls++;
      throw new ClaudeAuthError("refresh_failed");
    },
  });
  try {
    assert.equal((await owner.current()).claudeAiOauth.accessToken, "initial");
    await owner.current();
    assert.equal(calls, 1);
    await assert.rejects(owner.current(true), ClaudeAuthError);
    assert.equal(calls, 2);
  } finally {
    await owner.close();
    await f.close();
  }
});
Deno.test("Claude invalid refresh stops automatic retries until credentials change", async () => {
  const f = await fixture();
  let calls = 0;
  await f.write("initial", Date.now() + 60_000);
  const owner = new ClaudeAuthOwner({
    profile: f.profile,
    cli: "unused",
    refresh: async () => {
      calls++;
      throw new ClaudeAuthError("needs_login");
    },
  });
  try {
    await owner.current();
    await owner.current();
    assert.equal(calls, 1);
    await f.write("replacement");
    assert.equal((await owner.current()).claudeAiOauth.accessToken, "replacement");
  } finally {
    await owner.close();
    await f.close();
  }
});
Deno.test("Claude fan-out retries a failed subscriber without withholding other updates", async () => {
  const f = await fixture();
  const received: string[] = [];
  let fail = true,
    attempts = 0;
  const owner = new ClaudeAuthOwner({ profile: f.profile, cli: "unused", pollMs: 10 });
  let one: (() => Promise<void>) | undefined, two: (() => Promise<void>) | undefined;
  try {
    one = await owner.subscribe(
      async (s) => {
        if (s.claudeAiOauth.accessToken === "replacement") {
          attempts++;
          if (fail) throw new Error("disk failure");
        }
      },
      () => {},
    );
    two = await owner.subscribe(
      async (s) => {
        received.push(s.claudeAiOauth.accessToken);
      },
      () => {},
    );
    await f.write("replacement");
    await until(() => received.includes("replacement") && attempts > 0);
    fail = false;
    const previous = attempts;
    await until(() => attempts > previous);
    await one();
    one = undefined;
    await two();
    two = undefined;
    const count = received.length;
    await f.write("later");
    await pause(30);
    assert.equal(received.length, count);
  } finally {
    await one?.();
    await two?.();
    await owner.close();
    await f.close();
  }
});
Deno.test("Claude expiry revokes sessions even while refresh is blocked", async () => {
  const f = await fixture();
  await f.write("initial", Date.now() + 200);
  const blocked = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let expired = false;
  const owner = new ClaudeAuthOwner({
    profile: f.profile,
    cli: "unused",
    pollMs: 10,
    refreshAheadMs: 0,
    refresh: async () => {
      entered.resolve();
      await blocked.promise;
      throw new ClaudeAuthError("refresh_failed");
    },
  });
  let unsubscribe: (() => Promise<void>) | undefined;
  try {
    unsubscribe = await owner.subscribe(
      async () => {},
      () => {
        expired = true;
      },
    );
    const refreshing = owner.current(true);
    void refreshing.catch(() => {});
    await entered.promise;
    await until(() => expired);
    blocked.resolve();
    await refreshing.catch(() => {});
  } finally {
    blocked.resolve();
    await unsubscribe?.();
    await owner.close();
    await f.close();
  }
});
Deno.test("Claude owner closure cancels waiting for another process's refresh lock", async () => {
  const f = await fixture();
  const lock = await Deno.open(join(f.profile, ".loom-auth-refresh.lock"), {
    create: true,
    read: true,
    write: true,
  });
  await lock.lock(true);
  const owner = new ClaudeAuthOwner({ profile: f.profile, cli: "unused" });
  try {
    const pending = owner.current(true);
    void pending.catch(() => {});
    await pause(20);
    await owner.close();
    await assert.rejects(pending, ClaudeAuthError);
  } finally {
    lock.close();
    await f.close();
  }
});
Deno.test("Session credential publication is atomic, private and never recreates removed state", async () => {
  const dir = await Deno.makeTempDir();
  const token: ClaudeAccess & { refreshToken: string } = {
    accessToken: "test-access",
    expiresAt: Date.now() + 3600_000,
    scopes: ["user:inference"],
    refreshToken: "never-copy",
  };
  try {
    await writeSessionAuth(dir, { claudeAiOauth: token });
    const data = await Deno.readTextFile(join(dir, "auth.json"));
    assert(!data.includes("never-copy"));
    assert.equal((await Deno.stat(join(dir, "auth.json"))).mode! & 0o777, 0o600);
    assert.throws(() =>
      sessionAuth({ claudeAiOauth: token, CLAUDE_CODE_OAUTH_TOKEN: "ambiguous" }),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  await assert.rejects(writeSessionAuth(dir, { claudeAiOauth: token }), Deno.errors.NotFound);
  await assert.rejects(Deno.stat(dir), Deno.errors.NotFound);
});

Deno.test("Claude accepts persisted rotation even if a later login step fails", async () => {
  const f = await fixture();
  const owner = new ClaudeAuthOwner({
    profile: f.profile,
    cli: "unused",
    refresh: async () => {
      await f.write("persisted-rotation");
      throw new ClaudeAuthError("refresh_failed");
    },
  });
  try {
    assert.equal((await owner.current(true)).claudeAiOauth.accessToken, "persisted-rotation");
  } finally {
    await owner.close();
    await f.close();
  }
});

Deno.test("Claude watcher renews before expiry and publishes the new access token", async () => {
  const f = await fixture();
  let calls = 0;
  const values: string[] = [];
  const owner = new ClaudeAuthOwner({
    profile: f.profile,
    cli: "unused",
    pollMs: 10,
    refresh: async () => {
      calls++;
      await f.write("automatic");
    },
  });
  let unsubscribe: (() => Promise<void>) | undefined;
  try {
    unsubscribe = await owner.subscribe(
      async (value) => {
        values.push(value.claudeAiOauth.accessToken);
      },
      () => {},
    );
    await f.write("nearly-expired", Date.now() + 60_000);
    await until(() => values.includes("automatic"));
    assert.equal(calls, 1);
  } finally {
    await unsubscribe?.();
    await owner.close();
    await f.close();
  }
});

Deno.test({
  name: "Claude refresh rejection is actionable without leaking native diagnostics",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const f = await fixture();
    const cli = join(f.profile, "fake-claude");
    await Deno.writeTextFile(
      cli,
      '#!/bin/sh\necho "Login failed: Request failed with status code 400" >&2\necho "$CLAUDE_CODE_OAUTH_REFRESH_TOKEN" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    const owner = new ClaudeAuthOwner({ profile: f.profile, cli });
    try {
      await assert.rejects(owner.current(true), (error: unknown) => {
        assert(error instanceof ClaudeAuthError);
        assert.equal(error.code, "needs_login");
        assert(error.message.includes("HTTP 400"));
        assert(!error.message.includes("test-refresh-secret"));
        return true;
      });
    } finally {
      await owner.close();
      await f.close();
    }
  },
});
