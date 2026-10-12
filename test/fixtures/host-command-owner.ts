/**
 * A daemon stand-in that relays the host command fixture, reports the processes
 * involved on stdout, then waits to be killed: what a daemon crash leaves behind.
 */
import { fileURLToPath } from "node:url";
import { startHostCommandMcp } from "../../backend/daemon/src/daemon/host-command-mcp.ts";

const fixture = fileURLToPath(new URL("./host-command-mcp.ts", import.meta.url));
const worker = await startHostCommandMcp("fixture", {
  transport: "stdio",
  command: Deno.execPath(),
  args: ["run", "--quiet", "-A", fixture],
  env: { LOOM_TEST_STUBBORN: "1" },
});
if (worker.handle.spec.transport !== "http") throw new Error("expected an HTTP endpoint");
const response = await fetch(worker.handle.spec.url, {
  method: "POST",
  headers: { ...worker.handle.spec.headers, "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } }),
});
const { result } = (await response.json()) as { result: { content: [{ text: string }] } };
console.log(JSON.stringify({ worker: worker.pid, ...JSON.parse(result.content[0].text) }));
setInterval(() => {}, 60_000);
