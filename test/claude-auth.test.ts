import assert from "node:assert/strict";
import { join } from "node:path";
import {
  ClaudeAuthOwner,
  ClaudeAuthError,
  type ClaudeAccess,
} from "../backend/daemon/src/daemon/claude-auth.ts";
import { sessionAuth, writeSessionAuth } from "../runtime/src/session-vm/auth.ts";
import {
  refreshClaudeProfile,
  CLAUDE_TOKEN_URL,
} from "../backend/daemon/src/daemon/claude-refresh.ts";
import { withClaudeRefreshLock } from "../backend/daemon/src/daemon/claude-refresh-lock.ts";
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

const renewedResponse = () =>
  Response.json({
    access_token: "renewed",
    refresh_token: "rotated-refresh",
    expires_in: 28800,
    scope: "user:profile user:inference",
  });
const refreshWith =
  (request: typeof fetch) =>
  (profile: string, _cli: string, credential: ClaudeAccess, signal: AbortSignal) =>
    refreshClaudeProfile(profile, credential.accessToken, signal, request);

Deno.test("Claude direct renewal preserves account, unrelated credentials, and private storage", async () => {
  const f = await fixture();
  const path = join(f.profile, ".credentials.json");
  const account = '{"oauthAccount":{"organizationUuid":"work"},"hasCompletedOnboarding":true}';
  await Deno.writeTextFile(join(f.profile, ".claude.json"), account);
  const original = JSON.parse(await Deno.readTextFile(path));
  original.claudeAiOauth.subscriptionType = "team";
  original.claudeAiOauth.rateLimitTier = "tier";
  original.mcpOAuth = { other: "keep" };
  await Deno.writeTextFile(path, JSON.stringify(original));
  let requests = 0;
  const request: typeof fetch = async (url, init) => {
    requests++;
    assert.equal(url, CLAUDE_TOKEN_URL);
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(init?.body as string);
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "test-refresh-secret");
    assert(body.scope.includes("user:inference"));
    assert(body.scope.includes("user:file_upload"));
    assert((await Deno.stat((await Deno.realPath(f.profile)) + ".lock")).isDirectory);
    assert.deepEqual(
      JSON.parse(await Deno.readTextFile(path)),
      original,
      "No logout before exchange",
    );
    // Simulate another subsystem adding an unrelated credential.
    await Deno.writeTextFile(path, JSON.stringify({ ...original, added: "preserve" }));
    return renewedResponse();
  };
  const owner = new ClaudeAuthOwner({ profile: f.profile, refresh: refreshWith(request) });
  try {
    const fresh = await owner.current(true);
    assert.equal(requests, 1);
    assert.equal(fresh.claudeAiOauth.accessToken, "renewed");
    assert(!JSON.stringify(fresh).includes("rotated-refresh"));
    const saved = JSON.parse(await Deno.readTextFile(path));
    assert.equal(saved.claudeAiOauth.refreshToken, "rotated-refresh");
    assert.deepEqual(saved.claudeAiOauth.scopes, ["user:profile", "user:inference"]);
    assert.equal(saved.claudeAiOauth.subscriptionType, "team");
    assert.equal(saved.claudeAiOauth.rateLimitTier, "tier");
    assert.deepEqual(saved.mcpOAuth, original.mcpOAuth);
    assert.equal(saved.added, "preserve");
    assert.equal(await Deno.readTextFile(join(f.profile, ".claude.json")), account);
    if (Deno.build.os !== "windows") assert.equal((await Deno.stat(path)).mode! & 0o777, 0o600);
    await assert.rejects(Deno.stat(f.profile + ".lock"), Deno.errors.NotFound);
  } finally {
    await owner.close();
    await f.close();
  }
});

for (const status of [400, 401]) {
  Deno.test(
    "Claude retries ambiguous HTTP " + status + " and reports only safe fields",
    async () => {
      const f = await fixture();
      await f.write("initial", Date.now() + 60_000);
      const reports: Array<{ code: string; detail: string | undefined }> = [];
      let calls = 0;
      const owner = new ClaudeAuthOwner({
        profile: f.profile,
        refresh: refreshWith(async () => {
          calls++;
          return calls === 1
            ? Response.json({ error_description: "test-refresh-secret" }, { status })
            : renewedResponse();
        }),
        report: (code, detail) => {
          reports.push({ code, detail });
        },
      });
      try {
        assert.equal((await owner.current()).claudeAiOauth.accessToken, "initial");
        assert.deepEqual(reports, [{ code: "refresh_failed", detail: "HTTP " + status }]);
        await owner.current();
        assert.equal(calls, 1);
        await pause(1100);
        assert.equal((await owner.current()).claudeAiOauth.accessToken, "renewed");
        assert.equal(calls, 2);
      } finally {
        await owner.close();
        await f.close();
      }
    },
  );
}

Deno.test("Claude classifies structured grant rejection without modifying credentials", async () => {
  const f = await fixture();
  const path = join(f.profile, ".credentials.json");
  const before = await Deno.readTextFile(path);
  try {
    for (const [status, error, code] of [
      [400, "invalid_grant", "needs_login"],
      [401, "invalid_grant", "needs_login"],
      [400, "invalid_scope", "refresh_failed"],
      [500, "invalid_grant", "refresh_failed"],
      [429, "rate_limited", "refresh_failed"],
    ] as const) {
      await assert.rejects(
        refreshClaudeProfile(f.profile, "initial", new AbortController().signal, async () =>
          Response.json({ error, error_description: "test-refresh-secret" }, { status }),
        ),
        (e: unknown) => {
          assert(e instanceof ClaudeAuthError);
          assert.equal(e.code, code);
          assert(!e.message.includes("test-refresh-secret"));
          return true;
        },
      );
      assert.equal(await Deno.readTextFile(path), before);
    }
  } finally {
    await f.close();
  }
});

Deno.test("Claude reuses a concurrent native renewal after waiting for the shared directory lock", async () => {
  const f = await fixture();
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const native = withClaudeRefreshLock(f.profile, new AbortController().signal, async () => {
    locked.resolve();
    await release.promise;
    await f.write("native-renewal");
  });
  await locked.promise;
  let calls = 0;
  const renewal = refreshClaudeProfile(
    f.profile,
    "initial",
    new AbortController().signal,
    async () => {
      calls++;
      return renewedResponse();
    },
  );
  try {
    await pause(30);
    assert.equal(calls, 0);
    release.resolve();
    await native;
    await renewal;
    assert.equal(calls, 0);
  } finally {
    release.resolve();
    await native;
    await renewal;
    await f.close();
  }
});

Deno.test("Claude renewal recovers stale native locks and preserves refresh token when unrotated", async () => {
  const f = await fixture();
  const path = (await Deno.realPath(f.profile)) + ".lock";
  await Deno.mkdir(path);
  await Deno.utime(path, new Date(0), new Date(0));
  try {
    await refreshClaudeProfile(f.profile, "initial", new AbortController().signal, async () =>
      Response.json({ access_token: "renewed", expires_in: 3600, scope: "user:inference" }),
    );
    const value = JSON.parse(await Deno.readTextFile(join(f.profile, ".credentials.json")));
    assert.equal(value.claudeAiOauth.refreshToken, "test-refresh-secret");
    await assert.rejects(Deno.stat(path), Deno.errors.NotFound);
  } finally {
    await f.close();
  }
});

Deno.test("Claude waiting for a native lock can be cancelled without deleting it", async () => {
  const f = await fixture();
  const path = (await Deno.realPath(f.profile)) + ".lock";
  await Deno.mkdir(path);
  const abort = new AbortController();
  try {
    const pending = refreshClaudeProfile(f.profile, "initial", abort.signal, async () => {
      throw new Error("must not exchange");
    });
    const rejected = assert.rejects(pending);
    await pause(20);
    abort.abort();
    await rejected;
    assert((await Deno.stat(path)).isDirectory);
  } finally {
    await Deno.remove(path);
    await f.close();
  }
});

Deno.test("Claude does not overwrite an explicit login racing with renewal", async () => {
  const f = await fixture();
  try {
    await refreshClaudeProfile(f.profile, "initial", new AbortController().signal, async () => {
      await f.write("different-login");
      return renewedResponse();
    });
    const value = JSON.parse(await Deno.readTextFile(join(f.profile, ".credentials.json")));
    assert.equal(value.claudeAiOauth.accessToken, "different-login");
  } finally {
    await f.close();
  }
});

Deno.test("Claude invalid token responses leave the credential store intact", async () => {
  const f = await fixture();
  const path = join(f.profile, ".credentials.json");
  const before = await Deno.readTextFile(path);
  try {
    for (const body of [
      {},
      { access_token: "new", expires_in: -1, scope: "user:inference" },
      { access_token: "new", expires_in: 3600, scope: "user:inference", refresh_token: "" },
    ]) {
      await assert.rejects(
        refreshClaudeProfile(f.profile, "initial", new AbortController().signal, async () =>
          Response.json(body),
        ),
        ClaudeAuthError,
      );
      assert.equal(await Deno.readTextFile(path), before);
    }
  } finally {
    await f.close();
  }
});

Deno.test("Claude detects a replaced native lock before writing credentials", async () => {
  const f = await fixture();
  const path = f.profile + ".lock";
  const before = await Deno.readTextFile(join(f.profile, ".credentials.json"));
  try {
    await assert.rejects(
      refreshClaudeProfile(f.profile, "initial", new AbortController().signal, async () => {
        // A non-cooperating process changes the lock's ownership marker.
        await Deno.utime(path, new Date(0), new Date(0));
        return renewedResponse();
      }),
      (e: unknown) => {
        assert(e instanceof ClaudeAuthError);
        assert.equal(e.detail, "Claude lock lost");
        return true;
      },
    );
    assert.equal(await Deno.readTextFile(join(f.profile, ".credentials.json")), before);
    assert((await Deno.stat(path)).isDirectory, "Do not remove another owner's lock");
  } finally {
    await Deno.remove(path);
    await f.close();
  }
});

Deno.test("Claude lock heartbeat keeps a slow exchange from appearing stale", async () => {
  const f = await fixture();
  const path = f.profile + ".lock";
  try {
    await withClaudeRefreshLock(f.profile, new AbortController().signal, async () => {
      const first = (await Deno.stat(path)).mtime!.getTime();
      await pause(5200);
      assert((await Deno.stat(path)).mtime!.getTime() > first);
    });
    await assert.rejects(Deno.stat(path), Deno.errors.NotFound);
  } finally {
    await f.close();
  }
});

Deno.test("Claude refresh subprocess cancellation reaps the worker and preserves a native lock", async () => {
  const f = await fixture();
  const path = f.profile + ".lock";
  await Deno.mkdir(path);
  const owner = new ClaudeAuthOwner({ profile: f.profile });
  try {
    const pending = owner.current(true);
    const rejected = assert.rejects(pending, (e: unknown) => {
      assert(e instanceof ClaudeAuthError);
      assert.equal(e.code, "closed");
      return true;
    });
    await pause(200);
    await owner.close();
    await rejected;
    assert((await Deno.stat(path)).isDirectory);
  } finally {
    await owner.close();
    await Deno.remove(path);
    await f.close();
  }
});
