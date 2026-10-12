/**
 * One VM session's host command MCP server, bridged to loopback HTTP for the guest relay.
 * Parent EOF owns its lifetime: the command is in this worker's process group, which
 * exitWorker ends on the way out, so a daemon that dies leaves nothing behind.
 */
import {
  decodeHostCommandBinding,
  HOST_COMMAND_WORKER_VERSION,
} from "../../../core/src/mcp-worker.ts";
import { FrameWriter, readFrames } from "../worker/transport.ts";
import { exitWorker } from "../worker/shutdown.ts";
import { stdioHttp } from "./stdio-http.ts";

const DIAGNOSTICS_chars = 4096;

const writer = new FrameWriter(Deno.stdout.writable);
const frames = readFrames(Deno.stdin.readable, (value) => value);
const bootstrap = setTimeout(() => void exitWorker(1), 10_000);
let diagnostics = "";
let code = 0;
try {
  await writer.send({ kind: "hello", version: HOST_COMMAND_WORKER_VERSION });
  const first = await frames.next();
  if (first.done) throw new Error("missing binding");
  clearTimeout(bootstrap);
  const binding = decodeHostCommandBinding(first.value);
  const parent = frames.next().then((next) => {
    if (!next.done) throw new Error("host command worker already bound");
  });
  void parent.catch(() => {});
  const child = new Deno.Command(binding.command, {
    args: binding.args,
    cwd: binding.cwd,
    clearEnv: true,
    env: binding.env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  void child.stderr
    .pipeTo(
      new WritableStream({
        write(chunk) {
          diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(-DIAGNOSTICS_chars);
        },
      }),
    )
    .catch(() => {});
  const starting = stdioHttp(
    child.stdin,
    child.stdout,
    binding.token,
    binding.requestTimeoutMs,
    binding.maxServerFrameBytes,
  );
  void starting.catch(() => {});
  const bridge = await Promise.race([
    starting,
    parent.then(() => undefined),
    child.status.then((status) => {
      throw new Error(`exited with code ${status.code} before it initialized`);
    }),
  ]);
  if (bridge) {
    await writer.send({ kind: "ready", version: HOST_COMMAND_WORKER_VERSION, port: bridge.port });
    await Promise.race([parent, bridge.exited, child.status]);
    await bridge.close();
  }
} catch (error) {
  code = 1;
  await writer
    .send({
      kind: "error",
      version: HOST_COMMAND_WORKER_VERSION,
      message: `${error instanceof Error ? error.message : String(error)}${diagnostics ? `\n${diagnostics}` : ""}`,
    })
    .catch(() => {});
}
await exitWorker(code);
