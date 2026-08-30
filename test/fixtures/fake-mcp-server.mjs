/**
 * A minimal MCP server over stdio for tests — newline-delimited JSON-RPC 2.0.
 * Implements just enough of the protocol for `@ai-sdk/mcp`'s client to
 * initialize, list tools, and call them:
 *
 *   - `echo_text`  — returns its `text` argument (readonly-looking name)
 *   - `write_note` — writes `content` to `path`, returns a confirmation
 *
 * No dependencies; deterministic; no network.
 */
import { writeFileSync } from "node:fs";

// This file is a fixture, not a test. `npm test` globs `test/*.test.ts` and
// never loads it, but a bare `node --test` matches `**/test/**/*.mjs` and would
// execute it — then hang forever on stdin. Bail when the test runner is our
// parent. (When the MCP stdio transport spawns us for real, it uses a minimal
// allow-list environment that never carries NODE_TEST_CONTEXT.)
if (process.env["NODE_TEST_CONTEXT"]) process.exit(0);

const TOOLS = [
  {
    name: "echo_text",
    description: "Echo the given text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "write_note",
    description: "Write content to a file path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const { name, arguments: args = {} } = params ?? {};
    try {
      if (name === "echo_text") {
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: String(args.text ?? "") }] },
        });
        return;
      }
      if (name === "write_note") {
        writeFileSync(args.path, args.content ?? "");
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `wrote ${args.path}` }] },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true },
      });
    } catch (err) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(err) } });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore malformed input
    }
  }
});
process.stdin.on("end", () => process.exit(0));
