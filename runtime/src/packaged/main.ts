/** One session's VM supervisor. Parent EOF owns its lifetime, including startup. */
import { FrameWriter, readFrames } from "../worker/transport.ts";
import { stdioHttp } from "../mcp/stdio-http.ts";
import { decodeManifest } from "./artifact.ts";
import {
  vmCreateArguments,
  vmExecArguments,
  sessionVmName,
  vmEnvironment,
  reapVm,
  stageGuestImage,
  type VmBinding,
} from "./vm.ts";
const writer = new FrameWriter(Deno.stdout.writable);
const frames = readFrames(Deno.stdin.readable, (v) => v as VmBinding);
let binding: VmBinding | undefined;
let child: Deno.ChildProcess | undefined;
let bridge: Awaited<ReturnType<typeof stdioHttp>> | undefined;
let starting: Promise<Awaited<ReturnType<typeof stdioHttp>>> | undefined;
const bootstrap = setTimeout(() => Deno.exit(1), 10_000);
let diagnostics = "";
try {
  await writer.send({ kind: "hello", version: 1 });
  const first = await frames.next();
  if (first.done) throw new Error("Missing VM binding");
  const b = first.value;
  if (
    !b ||
    b.version !== 1 ||
    typeof b.token !== "string" ||
    b.token.length < 32 ||
    typeof b.workspace !== "string" ||
    typeof b.state !== "string" ||
    typeof b.smolvm !== "string" ||
    typeof b.artifact !== "string"
  )
    throw new Error("Invalid VM binding");
  b.manifest = decodeManifest(b.manifest);
  binding = b;
  clearTimeout(bootstrap);
  await stageGuestImage(b);
  const parent = frames.next().then((next) => {
    if (!next.done) throw new Error("VM worker already bound");
  });
  {
    for (const args of [vmCreateArguments(b), ["machine", "start", "--name", sessionVmName]]) {
      child = new Deno.Command(b.smolvm, {
        args,
        cwd: b.state,
        clearEnv: true,
        env: vmEnvironment(b.state),
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const output = child.output();
      void output.catch(() => {});
      const result = await Promise.race([output, parent.then(() => undefined)]);
      if (!result) throw new Error("Parent closed during VM startup");
      if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    }
  }
  child = new Deno.Command(b.smolvm, {
    args: vmExecArguments(b),
    cwd: b.state,
    clearEnv: true,
    env: vmEnvironment(b.state),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  void child.stderr
    .pipeTo(
      new WritableStream({
        write(chunk) {
          diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(-4096);
        },
      }),
    )
    .catch(() => {});
  starting = stdioHttp(child.stdin, child.stdout, b.token).then((value) => (bridge = value));
  void starting.catch(() => {});
  const ready = await Promise.race([starting, parent.then(() => undefined)]);
  if (ready) {
    await writer.send({ kind: "ready", version: 1, port: ready.port });
    await Promise.race([parent, ready.exited, child.status]);
  }
} catch (error) {
  Deno.exitCode = 1;
  await writer
    .send({
      kind: "error",
      version: 1,
      message: `Packaged MCP VM failed: ${error instanceof Error ? error.message : String(error)}${diagnostics ? `\n${diagnostics}` : ""}`,
    })
    .catch(() => {});
} finally {
  clearTimeout(bootstrap);
  // Give cooperative MCP EOF a short grace, then explicitly stop the private VM.
  const closing = bridge?.close();
  void closing?.catch(() => {});
  if (child) await Promise.race([child.status, new Promise((r) => setTimeout(r, 500))]);
  // Stop the CLI before inspecting the registry: it must not create a new VM
  // after a reaper has observed an empty registry during cold startup.
  if (child) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* exited */
    }
    await child.status;
  }
  let reaped = false;
  try {
    if (binding) {
      await reapVm(binding);
      reaped = true;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
  await starting?.catch(() => {});
  await bridge?.close().catch(() => {});
  if (reaped) await writer.send({ kind: "closed", version: 1 }).catch(() => {});
}
