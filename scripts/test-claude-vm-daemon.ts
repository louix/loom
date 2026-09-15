/** Live acceptance: daemon routing, socket MCP, restart, archive/resume, deletion. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { Daemon } from "../backend/daemon/src/daemon/daemon.ts";
import { createClaudeWorkerProvider } from "../backend/daemon/src/daemon/claude-worker.ts";
import { sessionVmDirectory } from "../backend/daemon/src/daemon/session-vm-state.ts";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import { setLogLevel } from "@loom/core/logger";
import { gitFixture } from "./lib/git-fixture.ts";
const [artifact, smolvm, cli] = Deno.args;
assert(artifact && smolvm && cli, "Pass runtime artifact, smolvm and host Claude executable");
setLogLevel("error");
const f = await gitFixture();
Deno.env.set("XDG_CONFIG_HOME", join(f.root, "config"));
Deno.env.set("XDG_STATE_HOME", join(f.root, "persistent"));
const nonce = `MEMORY_${crypto.randomUUID().slice(0, 8)}`;
const marker = `MCP_${crypto.randomUUID().slice(0, 8)}`;
let calls = 0;
const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const message = await request.json();
  if (message.id === undefined) return new Response(null, { status: 202 });
  let result: unknown = {};
  if (message.method === "initialize")
    result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "probe", version: "1" },
    };
  if (message.method === "tools/list")
    result = {
      tools: [
        {
          name: "session_probe",
          description: "Return the acceptance test marker",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  if (message.method === "tools/call") {
    calls++;
    result = { content: [{ type: "text", text: marker }] };
  }
  return Response.json({ jsonrpc: "2.0", id: message.id, result });
});
await Deno.mkdir(join(f.root, "config/loom"), { recursive: true });
await Deno.writeTextFile(
  join(f.root, "config/loom/config.jsonc"),
  `{
  "session": {
    "remote-tools": [
      "probe"
    ]
  },
  "providers": {
    "claude": {
      "cli_path": ${JSON.stringify(cli)},
      "model": "haiku",
      "models": [
        "haiku"
      ],
      "setting_sources": []
    }
  },
  "isolation": {
    "enabled": true,
    "claude": {
      "artifact": ${JSON.stringify(artifact)},
      "smolvm": ${JSON.stringify(smolvm)}
    }
  },
  "titles": {
    "enabled": false
  },
  "search": {
    "backend": "none"
  },
  "remote-tools": {
    "probe": {
      "url": "http://127.0.0.1:${server.addr.port}/mcp"
    }
  }
}`,
);
let daemon: Daemon | undefined, client: LoomClient | undefined;
let text = "";
const start = async () => {
  daemon = await Daemon.start({
    repoRoot: f.repo,
    standalone: true,
    connectors: {
      "@loom/connector-claude": async () => ({ createProvider: createClaudeWorkerProvider }),
    },
  });
  client = await LoomClient.connect({
    repoRoot: f.repo,
    sockPath: daemon.sockPath,
    autospawn: false,
  });
  client.onPush((frame) => {
    if (frame.type !== "event") return;
    const event = frame.event;
    if (event.type === "assistant_text") text += event.text;
    if (event.type === "permission_request")
      void client!
        .request("session.respondPermission", {
          id: event.sessionId,
          requestId: event.id,
          decision: event.tool.includes("session_probe") ? "allow" : "deny",
        })
        .catch(() => {});
  });
};
const idle = async (id: string) => {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const snap = await client!.request<SessionSnapshot>("session.get", { id });
    if (snap.status.kind === "idle") return snap;
    assert(snap.status.kind !== "error", `Session failed: ${JSON.stringify(snap.status)}`);
    assert(Date.now() < deadline, "Timed out waiting for Claude turn");
    await new Promise((r) => setTimeout(r, 200));
  }
};
try {
  await start();
  const s = await client!.request<SessionSnapshot>(
    "session.create",
    {
      provider: "claude",
      model: "haiku",
      prompt: `Remember ${nonce}. Call the session_probe MCP tool once and repeat its result. Do not use any other tools.`,
    },
    150_000,
  );
  await idle(s.id);
  assert(calls > 0, "Guest did not call forwarded MCP");
  assert(text.includes(marker), "MCP result missing from reply");
  const dir = sessionVmDirectory(f.repo, s.id);
  const ref = daemon!.registry.store.providerRef(s.id);
  assert(ref);
  const history = join(dir, "profile/projects/loom-session", `${ref}.jsonl`);
  assert((await Deno.stat(history)).size > 0, "Native history was not persisted");
  console.log(JSON.stringify({ created: true, mcpForwarded: true, historyPersisted: true }));
  await client!.close();
  await daemon!.stop("acceptance-restart");
  await start();
  text = "";
  await client!.request(
    "session.send",
    {
      id: s.id,
      text: "What MEMORY_ value did I ask you to remember? Reply with only the value. Do not use tools.",
    },
    150_000,
  );
  await idle(s.id);
  assert(text.includes(nonce), "Daemon restart lost Claude history");
  await client!.request("session.markDone", { id: s.id, force: true }, 150_000);
  await assert.rejects(Deno.stat(s.worktree!), Deno.errors.NotFound);
  assert((await Deno.stat(history)).size > 0);
  console.log(JSON.stringify({ restartResumed: true, archived: true }));
  // Occupy the old path so reattachment must choose a different one.
  await Deno.mkdir(s.worktree!, { recursive: true });
  text = "";
  await client!.request(
    "session.send",
    { id: s.id, text: "Repeat the MEMORY_ value from earlier. No tools." },
    150_000,
  );
  const revived = await idle(s.id);
  assert.notEqual(revived.worktree, s.worktree);
  assert(text.includes(nonce), "Worktree path change lost Claude history");
  await client!.request("session.remove", { id: s.id, force: true }, 150_000);
  await assert.rejects(Deno.stat(join(dir, "profile")), Deno.errors.NotFound);
  await assert.rejects(Deno.stat(join(dir, "active.json")), Deno.errors.NotFound);
  assert(!daemon!.registry.get(s.id));
  console.log(JSON.stringify({ passed: true, resumedAtNewPath: true, deletedProfile: true }));
} finally {
  await client?.close();
  await daemon?.stop("acceptance-cleanup");
  await server.shutdown();
  if (Deno.env.get("LOOM_KEEP_FIXTURE")) console.error(`Retained fixture: ${f.root}`);
  else await f.close();
}
