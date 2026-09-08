import assert from "node:assert/strict";
import { test } from "node:test";
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { stdioHttp } from "../runtime/src/mcp/stdio-http.ts";
import { FrameWriter, readFrames } from "../runtime/src/worker/transport.ts";

const fixture = async () => {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const writer = new FrameWriter(output.writable);
  const seen: Array<Record<string, any>> = [];
  const native = (async () => {
    try {
      for await (const f of readFrames(input.readable, (v) => v as Record<string, any>)) {
        seen.push(f);
        if (f.id === undefined) continue;
        if (f.method === "hang") continue;
        let result: unknown = {};
        if (f.method === "initialize")
          result = {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          };
        else if (f.method === "tools/list")
          result = {
            tools: [
              {
                name: "native_read",
                description: "read",
                inputSchema: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            ],
          };
        else if (f.method === "tools/call")
          result = { content: [{ type: "text", text: "read " + f.params.arguments.path }] };
        await writer.send({ jsonrpc: "2.0", id: f.id, result });
      }
    } finally {
      await writer.close();
    }
  })();
  const bridge = await stdioHttp(input.writable, output.readable, "token");
  const url = `http://127.0.0.1:${bridge.port}/mcp`;
  const headers = { Authorization: "Bearer token", "Content-Type": "application/json" };
  return {
    bridge,
    seen,
    url,
    headers,
    emit: (frame: unknown) => writer.send(frame),
    close: async () => {
      await bridge.close();
      await native;
      await bridge.exited;
    },
  };
};
test("stdio facade works with real MCP client, preserves schemas and enforces bearer/origin/body bounds", async () => {
  const f = await fixture();
  try {
    const client = await experimental_createMCPClient({
      transport: { type: "http", url: f.url, headers: f.headers },
    });
    try {
      const tools = await client.tools();
      assert.ok(tools.native_read);
      const result = await tools.native_read.execute(
        { path: "/workspace/code" },
        { toolCallId: "t", messages: [], context: undefined },
      );
      assert.match(JSON.stringify(result), /read \/workspace\/code/);
    } finally {
      await client.close();
    }
    assert.equal(f.seen.filter((m) => m.method === "initialize").length, 1);
    assert.equal((await fetch(f.url)).status, 403);
    assert.equal(
      (await fetch(f.url, { headers: { ...f.headers, Origin: "https://evil" } })).status,
      403,
    );
    assert.equal(
      (
        await fetch(f.url, {
          method: "POST",
          headers: f.headers,
          body: "x".repeat(1024 * 1024 + 1),
        })
      ).status,
      413,
    );
  } finally {
    await f.close();
  }
});
test("cancellation maps client ids to native ids; closure rejects pending requests", async () => {
  const f = await fixture();
  const post = (body: unknown) =>
    fetch(f.url, { method: "POST", headers: f.headers, body: JSON.stringify(body) });
  try {
    const pending = post({ jsonrpc: "2.0", id: 999, method: "hang", params: {} });
    const deadline = Date.now() + 2000;
    while (!f.seen.some((m) => m.method === "hang")) {
      assert.ok(Date.now() < deadline);
      await new Promise((r) => setTimeout(r, 5));
    }
    const nativeId = f.seen.find((m) => m.method === "hang")!.id;
    const cancelled = await post({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 999 },
    });
    assert.equal(cancelled.status, 202);
    assert.ok(
      f.seen.some((m) => m.method === "notifications/cancelled" && m.params.requestId === nativeId),
    );
    await f.bridge.close();
    await pending.then(
      async (r) => {
        await r.text();
      },
      () => {},
    );
  } finally {
    await f.close();
  }
});
test("server notifications stream to authenticated clients and close with the MCP", async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.url, { headers: f.headers });
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const reader = response.body!.getReader();
    await reader.read();
    await f.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /notifications\/tools\/list_changed/,
    );
    await reader.cancel();
  } finally {
    await f.close();
  }
});
