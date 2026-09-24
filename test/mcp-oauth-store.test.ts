import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  createMcpOAuthStore,
  matchingOAuthCredential,
} from "../backend/daemon/src/daemon/mcp-oauth-store.ts";
import {
  McpOAuthError,
  mcpOAuthIdentity,
  oauthHash,
  parseMcpOAuthConfig,
  type McpOAuthCredential,
} from "../backend/daemon/src/daemon/mcp-oauth-model.ts";

const code = (c: string) => (e: unknown) => e instanceof McpOAuthError && e.code === c;
const linux = { skip: Deno.build.os !== "linux" };
const credential = (name = "work"): McpOAuthCredential => ({
  identity: mcpOAuthIdentity(name, "https://mcp.test/mcp", {}),
  issuer: "https://issuer.test",
  endpoints: { authorization: "https://issuer.test/auth", token: "https://issuer.test/token" },
  client: {
    id: "fixture-client",
    dynamic: true,
    authMethod: "none",
    redirectUri: "http://127.0.0.1:8990/callback",
  },
  accessToken: "fixture-access",
  refreshToken: "fixture-refresh",
});
test("OAuth identity binds URL and config, normalizes scope sets and validates descriptors", () => {
  const first = mcpOAuthIdentity("work", "https://MCP.test:443/mcp?q=1", {
    scopes: ["write", "read", "read"],
  });
  assert.deepEqual(
    first,
    mcpOAuthIdentity("work", "https://mcp.test/mcp?q=1", { scopes: ["read", "write"] }),
  );
  for (const config of [
    { client_secret_env: "SECRET" },
    { client_id: "id", client_secret_env: "S", client_secret_command: ["cmd"] },
    { client_secret: "fixture-secret" },
    { redirect_port: 0 },
    { redirect_port: 65536 },
    { client_secret_command: [] },
    { scopes: ["read write"] },
  ])
    assert.throws(() => parseMcpOAuthConfig(config), code("invalid_config"));
  const c = credential();
  const state = { version: 1 as const, generation: 1, credential: c };
  for (const identity of [
    mcpOAuthIdentity("work", "https://mcp.test/mcp?different", {}),
    mcpOAuthIdentity("work", "https://mcp.test/mcp", { scopes: [] }),
    mcpOAuthIdentity("other", "https://mcp.test/mcp", {}),
    mcpOAuthIdentity("work", "https://mcp.test/mcp", { client_id: "other" }),
  ])
    assert.throws(() => matchingOAuthCredential(state, identity), code("config_changed"));
});
test(
  "OAuth store persists private atomic records and tombstones prevent stale publication",
  linux,
  async () => {
    const root = await Deno.makeTempDir();
    try {
      const name = "../raw-name";
      const store = createMcpOAuthStore(name, root);
      assert.deepEqual(await store.read(), { version: 1, generation: 0 });
      const c = credential(name);
      await store.commit(0, c);
      const path = join(root, oauthHash(name), "credential.json");
      assert.equal((await Deno.stat(path)).mode! & 0o777, 0o600);
      assert.equal((await Deno.stat(join(root, oauthHash(name)))).mode! & 0o777, 0o700);
      assert.deepEqual((await createMcpOAuthStore(name, root).read()).credential, c);
      const loggedOut = await store.clear();
      assert.deepEqual(loggedOut, { version: 1, generation: 2 });
      assert(!(await Deno.readTextFile(path)).includes("fixture-access"));
      await assert.rejects(store.commit(1, c), code("stale_login"));
      assert.equal((await store.read()).generation, 2);
      assert.deepEqual(
        Array.from(Deno.readDirSync(join(root, oauthHash(name))))
          .map((e) => e.name)
          .sort(),
        ["credential.json", "lock"],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);
test(
  "OAuth store serializes concurrent writers and cancellation cannot mutate state",
  linux,
  async () => {
    const root = await Deno.makeTempDir();
    try {
      const a = createMcpOAuthStore("work", root),
        b = createMcpOAuthStore("work", root);
      const results = await Promise.allSettled([
        a.commit(0, credential()),
        b.commit(0, credential()),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        results.filter((r) => r.status === "rejected" && code("stale_login")(r.reason)).length,
        1,
      );
      await assert.rejects(a.clear(AbortSignal.abort("fixture-secret")), code("cancelled"));
      assert.equal((await a.read()).generation, 1);
      const file = await Deno.open(join(root, oauthHash("work"), "lock"), {
        read: true,
        write: true,
      });
      await file.lock(true);
      try {
        const controller = new AbortController();
        const pending = b.clear(controller.signal);
        controller.abort();
        await assert.rejects(pending, code("cancelled"));
      } finally {
        file.close();
      }
      assert.equal((await a.read()).generation, 1);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);
test(
  "OAuth store rejects corrupt, oversized, insecure and symlink records without overwriting them",
  linux,
  async () => {
    for (const mode of [
      "corrupt",
      "version",
      "size",
      "permissions",
      "symlink",
      "directory",
      "identity",
    ]) {
      const root = await Deno.makeTempDir();
      try {
        const store = createMcpOAuthStore("work", root);
        await store.commit(0, credential());
        const path = join(root, oauthHash("work"), "credential.json");
        if (mode === "corrupt") await Deno.writeTextFile(path, "fixture-secret");
        if (mode === "version") await Deno.writeTextFile(path, '{"version":2,"generation":1}');
        if (mode === "size") await Deno.writeTextFile(path, "x".repeat(300000));
        if (mode === "permissions") await Deno.chmod(path, 0o644);
        if (mode === "directory") await Deno.chmod(join(root, oauthHash("work")), 0o755);
        if (mode === "identity")
          await Deno.writeTextFile(
            path,
            JSON.stringify({ version: 1, generation: 1, credential: credential("other") }),
          );
        if (mode === "symlink") {
          await Deno.rename(path, path + ".original");
          await Deno.symlink(path + ".original", path);
        }
        const expected = ["permissions", "directory", "symlink"].includes(mode)
          ? "storage_unsafe"
          : "storage_corrupt";
        await assert.rejects(store.read(), code(expected));
        await assert.rejects(store.clear(), code(expected));
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
);

test("OAuth publication lock coordinates independent host processes", linux, async () => {
  const root = await Deno.makeTempDir();
  try {
    const run = async () => {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--deny-net",
          "--cached-only",
          new URL("fixtures/mcp-oauth-store-child.ts", import.meta.url).pathname,
          root,
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(credential())));
      await writer.close();
      const result = await child.output();
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
      return JSON.parse(new TextDecoder().decode(result.stdout));
    };
    const results = await Promise.all([run(), run()]);
    assert.equal(results.filter((r) => r.generation === 1).length, 1);
    assert.equal(results.filter((r) => r.error === "stale_login").length, 1);
    assert.equal((await createMcpOAuthStore("work", root).read()).generation, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
