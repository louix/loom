/**
 * A stdio MCP server standing in for a relayed host command. It starts a `sleep`
 * grandchild, as a server starting a browser would, so tests can watch both end.
 *
 *   - `whoami` — its pid, the grandchild's, its cwd and $LOOM_TEST_MARKER
 *   - `big`    — a text result of $LOOM_TEST_BIG_BYTES characters
 *   - `slow`   — answers after $LOOM_TEST_SLOW_MS milliseconds
 *
 * $LOOM_TEST_STUBBORN set: it ignores SIGTERM and stdin EOF, so only a SIGKILL ends it.
 */
import { readFrames } from "../../runtime/src/framing.ts";

const stubborn = Deno.env.get("LOOM_TEST_STUBBORN") !== undefined;
if (stubborn) Deno.addSignalListener("SIGTERM", () => {});
const grandchild = new Deno.Command("sleep", {
  args: ["1000"],
  stdin: "null",
  stdout: "null",
  stderr: "null",
}).spawn();
// Not FrameWriter: its 1 MiB cap is the worker protocol's, not this server's.
const writer = Deno.stdout.writable.getWriter();
const text = (value: string) => ({ content: [{ type: "text", text: value }] });
type Request = { id?: number | string; method: string; params?: { name?: string } };
const respond: Record<string, (tool: string | undefined) => unknown> = {
  initialize: () => ({
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "host-command-fixture", version: "1" },
  }),
  "tools/list": () => ({
    tools: ["whoami", "big", "slow"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    })),
  }),
  "tools/call": (tool) =>
    tool === "big"
      ? text("x".repeat(Number(Deno.env.get("LOOM_TEST_BIG_BYTES") ?? "0")))
      : text(
          JSON.stringify({
            pid: Deno.pid,
            grandchild: grandchild.pid,
            cwd: Deno.cwd(),
            marker: Deno.env.get("LOOM_TEST_MARKER") ?? null,
          }),
        ),
};
for await (const frame of readFrames(
  Deno.stdin.readable,
  (v) => v as Request,
  undefined,
  64 * 1024 * 1024,
)) {
  if (frame.id === undefined) continue;
  const answer = (result: unknown) =>
    writer.write(
      new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n"),
    );
  if (frame.method === "tools/call" && frame.params?.name === "slow")
    setTimeout(
      () => void answer(text("slow")).catch(() => {}),
      Number(Deno.env.get("LOOM_TEST_SLOW_MS") ?? "0"),
    );
  else await answer(respond[frame.method]?.(frame.params?.name) ?? {});
}
if (stubborn) setInterval(() => {}, 60_000);
else grandchild.kill("SIGKILL");
