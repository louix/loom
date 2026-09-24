/** A fixed-endpoint Streamable HTTP relay. No SDK, filesystem, env or subprocess authority. */
import {
  decodeMcpBinding,
  MCP_WORKER_VERSION,
  mcpOAuthUpdateSchema,
} from "../../../core/src/mcp-worker.ts";
import { FrameWriter, readFrames } from "../worker/transport.ts";

const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 8 * MAX_BODY;
const stop = new AbortController();
const writer = new FrameWriter(Deno.stdout.writable);
const frames = readFrames(Deno.stdin.readable, (value) => value);
const bootstrap = setTimeout(() => Deno.exit(1), 10_000);
let server: Deno.HttpServer<Deno.NetAddr> | undefined;
let active = 0;
try {
  await writer.send({ kind: "hello", version: MCP_WORKER_VERSION });
  const first = await frames.next();
  if (first.done) throw new Error("missing binding");
  clearTimeout(bootstrap);
  const binding = decodeMcpBinding(first.value);
  let auth = binding.oauth;
  let authStop = new AbortController();
  let reported401 = -1;
  let reportedSuccess = -1;
  server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: stop.signal, onListen() {} },
    async (request) => {
      if (
        new URL(request.url).pathname !== "/mcp" ||
        request.headers.get("authorization") !== `Bearer ${binding.token}` ||
        request.headers.has("origin")
      )
        return new Response(null, { status: 403 });
      if (!["GET", "POST", "DELETE"].includes(request.method))
        return new Response(null, { status: 405 });
      if (active >= 32) return new Response(null, { status: 503 });
      const usedAuth = auth;
      if (
        usedAuth &&
        (!usedAuth.accessToken ||
          (usedAuth.expiresAt !== undefined && usedAuth.expiresAt <= Date.now()))
      )
        return new Response("MCP login required", { status: 503 });
      active++;
      let streaming = false;
      const signal = AbortSignal.any([
        stop.signal,
        authStop.signal,
        request.signal,
        AbortSignal.timeout(60_000),
      ]);
      try {
        const headers = new Headers();
        for (const name of [
          "accept",
          "content-type",
          "mcp-session-id",
          "mcp-protocol-version",
          "last-event-id",
        ]) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        for (const [name, value] of Object.entries(binding.headers)) headers.set(name, value);
        if (usedAuth?.accessToken) headers.set("authorization", `Bearer ${usedAuth.accessToken}`);
        let body: Uint8Array<ArrayBuffer> | undefined;
        if (request.body) {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of request.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>(),
            { signal },
          )) {
            size += chunk.length;
            if (size > MAX_BODY) return new Response(null, { status: 413 });
            chunks.push(chunk);
          }
          body = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
          }
        }
        if (
          usedAuth &&
          ((usedAuth.expiresAt !== undefined && usedAuth.expiresAt <= Date.now()) ||
            (auth?.generation === usedAuth.generation && !auth.accessToken))
        )
          return new Response("MCP login required", { status: 503 });
        const upstream = await fetch(binding.url, {
          method: request.method,
          headers,
          ...(body ? { body } : {}),
          redirect: "error",
          signal,
        });
        if (usedAuth && upstream.status === 401 && reported401 !== usedAuth.generation) {
          reported401 = usedAuth.generation;
          if (auth?.generation === usedAuth.generation) auth = { generation: usedAuth.generation };
          await writer.send({ kind: "unauthorized", generation: usedAuth.generation });
        } else if (usedAuth && upstream.ok && reportedSuccess !== usedAuth.generation) {
          reportedSuccess = usedAuth.generation;
          await writer.send({ kind: "authorized", generation: usedAuth.generation });
        }
        const responseHeaders = new Headers();
        for (const name of [
          "content-type",
          "mcp-session-id",
          "mcp-protocol-version",
          "retry-after",
        ]) {
          const value = upstream.headers.get(name);
          if (value) responseHeaders.set(name, value);
        }
        if (!upstream.body)
          return new Response(null, { status: upstream.status, headers: responseHeaders });
        const reader = upstream.body.getReader();
        let size = 0;
        let finished = false;
        const finish = () => {
          if (!finished) {
            finished = true;
            active--;
          }
        };
        streaming = true;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                finish();
                controller.close();
                return;
              }
              size += next.value.length;
              if (size > MAX_RESPONSE) throw new Error("MCP response too large");
              controller.enqueue(next.value);
            } catch {
              finish();
              await reader.cancel().catch(() => {});
              controller.error(new Error("MCP upstream stream failed"));
            }
          },
          async cancel() {
            finish();
            await reader.cancel().catch(() => {});
          },
        });
        return new Response(stream, { status: upstream.status, headers: responseHeaders });
      } catch {
        return new Response("External MCP request failed", { status: 502 });
      } finally {
        if (!streaming) active--;
      }
    },
  );
  await writer.send({ kind: "ready", version: MCP_WORKER_VERSION, port: server.addr.port });
  // Only authorization can rotate. Destination and guest capability remain immutable.
  for await (const frame of frames) {
    const update = mcpOAuthUpdateSchema.parse(frame);
    if (!auth) throw new Error("OAuth is not configured");
    if (update.state.generation <= auth.generation) {
      await writer.send({ kind: "token_ack", generation: update.state.generation });
      continue;
    }
    if (update.abortActive) {
      authStop.abort();
      authStop = new AbortController();
    }
    auth = update.state;
    await writer.send({ kind: "token_ack", generation: auth.generation });
  }
} catch {
  Deno.exitCode = 1;
} finally {
  clearTimeout(bootstrap);
  stop.abort();
  const forcedExit = setTimeout(() => Deno.exit(Deno.exitCode), 1000);
  await server?.finished.catch(() => {});
  clearTimeout(forcedExit);
}
