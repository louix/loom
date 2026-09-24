import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { createMcpOAuthStore } from "../backend/daemon/src/daemon/mcp-oauth-store.ts";

test(
  "public CLI logs in without a browser, reports safe status and logs out removed definitions",
  { skip: Deno.build.os !== "linux" },
  async () => {
    const root = await Deno.makeTempDir();
    let exchanges = 0;
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        if (path === "/mcp")
          return new Response(null, {
            status: 401,
            headers: { "www-authenticate": 'Bearer resource_metadata="' + origin + '/metadata"' },
          });
        if (path === "/metadata")
          return Response.json({ resource: origin + "/mcp", authorization_servers: [origin] });
        if (path === "/.well-known/oauth-authorization-server")
          return Response.json({
            issuer: origin,
            authorization_endpoint: origin + "/authorize",
            token_endpoint: origin + "/token",
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        if (path === "/token") {
          const body = new URLSearchParams(await request.text());
          assert.equal(body.get("resource"), origin + "/mcp");
          assert.equal(body.get("code"), "fixture-code");
          assert(body.get("code_verifier"));
          exchanges++;
          return Response.json({
            access_token: "fixture-access",
            refresh_token: "fixture-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        return new Response(null, { status: 404 });
      },
    );
    const origin = "http://127.0.0.1:" + server.addr.port;
    const cli = new URL("../cli/src/loom.ts", import.meta.url).pathname;
    const env = {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
    };
    const args = [
      "run",
      "-A",
      "--deny-net",
      "--cached-only",
      cli,
      "--repo",
      new URL("../", import.meta.url).pathname,
      "mcp",
    ];
    let child: Deno.ChildProcess | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Deno.mkdir(join(env.XDG_CONFIG_HOME, "loom"), { recursive: true });
      const path = join(env.XDG_CONFIG_HOME, "loom", "config.jsonc");
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          mcp_servers: {
            work: {
              source: { kind: "http", url: origin + "/mcp" },
              auth: { oauth: { client_id: "public-client" } },
            },
          },
        }),
      );
      child = new Deno.Command(Deno.execPath(), {
        args: [...args, "login", "work", "--no-browser", "--json"],
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const process = child;
      timeout = setTimeout(() => {
        try {
          process.kill("SIGKILL");
        } catch {
          /* exited */
        }
      }, 15000);
      const output = new Response(child.stdout).text();
      let stderr = "";
      let callbackSent = false;
      for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) {
        stderr += chunk;
        const line = stderr.split("\n").find((line) => line.startsWith(origin + "/authorize?"));
        if (line && !callbackSent) {
          const url = new URL(line);
          const callback = new URL(url.searchParams.get("redirect_uri")!);
          callback.searchParams.set("state", url.searchParams.get("state")!);
          callback.searchParams.set("code", "fixture-code");
          callbackSent = true;
          const result = await fetch(callback);
          assert.equal(result.status, 200);
          await result.text();
        }
      }
      assert.equal((await child.status).code, 0, stderr + (await output));
      clearTimeout(timeout);
      assert(callbackSent);
      const stdout = await output;
      assert.equal(JSON.parse(stdout).status, "ready");
      assert.doesNotMatch(stdout + stderr, /fixture-access|fixture-refresh/);
      assert.equal(exchanges, 1);
      const status = await new Deno.Command(Deno.execPath(), {
        args: [...args, "status", "work", "--json"],
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(status.code, 0, new TextDecoder().decode(status.stderr));
      const statusText = new TextDecoder().decode(status.stdout);
      assert.equal(JSON.parse(statusText)[0].auth.state, "ready");
      assert.doesNotMatch(statusText, /fixture-access|fixture-refresh|authorize\?/);
      assert.equal(exchanges, 1); // status cannot refresh
      await Deno.writeTextFile(path, "{}");
      const logout = await new Deno.Command(Deno.execPath(), {
        args: [...args, "logout", "work", "--json"],
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(logout.code, 0, new TextDecoder().decode(logout.stderr));
      assert.equal(JSON.parse(new TextDecoder().decode(logout.stdout)).invalidated, true);
      assert.equal(
        (await createMcpOAuthStore("work", join(env.XDG_STATE_HOME, "loom", "mcp-auth")).read())
          .credential,
        undefined,
      );
    } finally {
      clearTimeout(timeout);
      try {
        child?.kill("SIGKILL");
      } catch {
        /* exited */
      }
      await child?.status;
      await server.shutdown();
      await Deno.remove(root, { recursive: true });
    }
  },
);
