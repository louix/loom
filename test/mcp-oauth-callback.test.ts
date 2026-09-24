import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { listenOAuthCallback } from "../backend/daemon/src/daemon/mcp-oauth-callback.ts";
import { McpOAuthError } from "../backend/daemon/src/daemon/mcp-oauth-model.ts";
const code = (c: string) => (e: unknown) => e instanceof McpOAuthError && e.code === c;
const issuer = "https://issuer.test/tenant";
test("OAuth callback ignores invalid requests and accepts one exact state/issuer-bound code", async () => {
  const callback = listenOAuthCallback({ issuer, state: "fixture-state", requireIssuer: true });
  try {
    const good = new URLSearchParams({ state: "fixture-state", iss: issuer, code: "fixture-code" });
    for (const query of [
      new URLSearchParams({ ...Object.fromEntries(good), state: "wrong" }),
      new URLSearchParams({ ...Object.fromEntries(good), iss: "https://ISSUER.test/tenant" }),
      new URLSearchParams({ state: "fixture-state", code: "fixture-code" }),
      new URLSearchParams([...good, ["code", "duplicate"]]),
      new URLSearchParams([...good, ["error", "denied"]]),
    ]) {
      const response = await fetch(callback.redirectUri + "?" + query);
      assert.equal(response.status, 400);
      assert(!(await response.text()).includes("fixture"));
    }
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = request(
        callback.redirectUri + "?" + good,
        { headers: { host: "evil.test" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(badHost, 400);
    const response = await fetch(callback.redirectUri + "?" + good);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert(!(await response.text()).includes("fixture-code"));
    assert.equal((await callback.result).get("code"), "fixture-code");
  } finally {
    await callback.close();
  }
  await assert.rejects(fetch(callback.redirectUri));
});
test("OAuth callback validates issuer on errors and releases ports on rejection, timeout and abort", async () => {
  const callback = listenOAuthCallback({ issuer, state: "s", requireIssuer: false });
  const bad = await fetch(callback.redirectUri + "?state=s&error=denied&iss=wrong");
  assert.equal(bad.status, 400);
  await bad.text();
  const rejected = await fetch(
    callback.redirectUri + "?state=s&error=denied&error_description=fixture-secret",
  );
  await rejected.text();
  await assert.rejects(callback.result, code("authorization_rejected"));
  await callback.close();
  const timeout = listenOAuthCallback({ issuer, state: "s", requireIssuer: false, timeoutMs: 15 });
  await assert.rejects(timeout.result, code("login_timeout"));
  await timeout.close();
  const abort = new AbortController();
  const cancelled = listenOAuthCallback({
    issuer,
    state: "s",
    requireIssuer: false,
    signal: abort.signal,
  });
  const port = Number(new URL(cancelled.redirectUri).port);
  assert.throws(
    () => listenOAuthCallback({ issuer, state: "s", requireIssuer: false, port }),
    code("callback_unavailable"),
  );
  abort.abort("fixture-secret");
  await assert.rejects(cancelled.result, code("cancelled"));
  await cancelled.close();
  const rebound = listenOAuthCallback({ issuer, state: "s", requireIssuer: false, port });
  await rebound.close();
});
