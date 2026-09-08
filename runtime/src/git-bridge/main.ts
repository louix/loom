/** Private host worker: binding is host-created; stdin EOF revokes the endpoint. */
import { startPreparedGitBridge, type PreparedGitBridge } from "./service.ts";

if (Deno.args.length !== 1) throw new Error("Expected a host Git binding file");
const options = JSON.parse(await Deno.readTextFile(Deno.args[0]!)) as PreparedGitBridge;
let bridge: Awaited<ReturnType<typeof startPreparedGitBridge>> | undefined;
let stopping = false;
const stop = () => {
  stopping = true;
};
// Watch the parent before initialization, so EOF during startup cannot orphan a service.
const input = (async () => {
  const buffer = new Uint8Array(1024);
  try {
    while ((await Deno.stdin.read(buffer)) !== null) {
      /* no client requests on stdin */
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.BadResource)) throw error;
  } finally {
    stop();
  }
})();
const signal = () => {
  stop();
  try {
    Deno.stdin.close();
  } catch {
    /* closed */
  }
};
Deno.addSignalListener("SIGTERM", signal);
try {
  bridge = await startPreparedGitBridge(options);
  if (!stopping) console.log(JSON.stringify({ version: 1, socket: bridge.socket }));
  await input;
} finally {
  Deno.removeSignalListener("SIGTERM", signal);
  await bridge?.close();
}
