import { gitFixture } from "../scripts/lib/git-fixture.ts";
import { join } from "node:path";
import { ipcPermissions } from "../core/src/network-permissions.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
Deno.test("a network-denied host runs provider turns in a worker with host transcript persistence", async () => {
  let requests = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    if (new URL(request.url).pathname.endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    await request.json();
    requests++;
    const chunks = [
      {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
      },
      {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    return new Response(
      chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--deny-net",
        fileURLToPath(new URL("../scripts/test-provider-worker.ts", import.meta.url)),
        `http://127.0.0.1:${server.addr.port}/v1`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    assert.equal(requests, 1);
    const fixture = await gitFixture();
    try {
      const configFile = join(fixture.root, "config.jsonc");
      await Deno.writeTextFile(
        configFile,
        `{
  "providers": {
    "openai_compatible": {
      "profiles": {
        "fixture": {
          "base_url": "http://127.0.0.1:${server.addr.port}/v1",
          "api_key": "fixture"
        }
      }
    }
  },
  "session": {
    "provider_access": {
      "only": [
        "fixture"
      ]
    },
    "worktree": {
      "enabled": false
    }
  }
}`,
      );
      const daemon = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...ipcPermissions(join(fixture.repo, ".loom/daemon.sock")),
          fileURLToPath(new URL("../scripts/test-daemon-network.ts", import.meta.url)),
          `http://127.0.0.1:${server.addr.port}/v1`,
          fixture.repo,
          configFile,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(daemon.success, new TextDecoder().decode(daemon.stderr));
      assert(requests >= 2);
    } finally {
      await fixture.close();
    }
  } finally {
    await server.shutdown();
  }
});
