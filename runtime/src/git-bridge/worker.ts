/** One host Git worker per VM session, using the normal worker transport. */
import { FrameWriter, readFrames } from "../worker/transport.ts";
import { startPreparedGitBridge, type PreparedGitBridge } from "./service.ts";
const writer = new FrameWriter(Deno.stdout.writable);
const frames = readFrames(Deno.stdin.readable, (value) => value as PreparedGitBridge);
let server: Awaited<ReturnType<typeof startPreparedGitBridge>> | undefined;
const timer = setTimeout(() => Deno.exit(1), 10_000);
try {
  await writer.send({ kind: "hello", version: 1 });
  const first = await frames.next();
  if (first.done) throw new Error("Missing Git binding");
  clearTimeout(timer);
  let gone = false;
  const parent = frames.next().then(() => {
    gone = true;
  });
  server = await startPreparedGitBridge(first.value);
  if (!gone) await writer.send({ kind: "ready", version: 1, socket: server.socket });
  await parent;
} catch (error) {
  Deno.exitCode = 1;
  await writer
    .send({
      kind: "error",
      version: 1,
      message: error instanceof Error ? error.message : String(error),
    })
    .catch(() => {});
} finally {
  clearTimeout(timer);
  await server?.close();
}
