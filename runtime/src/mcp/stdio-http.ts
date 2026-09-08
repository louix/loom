/** Session-local HTTP facade over one MCP stdio connection; tool schemas pass through. */
import { FrameWriter, readFrames } from "../worker/transport.ts";
type Rpc = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
const MAX_BODY = 1024 * 1024;
export const stdioHttp = async (
  input: WritableStream<Uint8Array>,
  output: ReadableStream<Uint8Array>,
  token: string,
) => {
  const writer = new FrameWriter(input);
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: Rpc) => void; reject: (error: Error) => void }
  >();
  const clientIds = new Map<string | number, number>();
  const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const endStreams = () => {
    for (const stream of subscribers) {
      try {
        stream.close();
      } catch {
        /* disconnected */
      }
    }
    subscribers.clear();
  };
  let dead = false;
  const pump = (async () => {
    try {
      for await (const frame of readFrames(output, (v) => {
        if (!v || typeof v !== "object" || (v as Rpc).jsonrpc !== "2.0")
          throw new Error("Invalid MCP frame");
        return v as Rpc;
      })) {
        if (frame.method) {
          // This tools bridge advertises no sampling/elicitation client capabilities.
          if (frame.id !== undefined)
            await writer.send({
              jsonrpc: "2.0",
              id: frame.id,
              error: { code: -32601, message: "Client capability not supported" },
            });
          else {
            const data = new TextEncoder().encode(
              `event: message\ndata: ${JSON.stringify(frame)}\n\n`,
            );
            for (const stream of subscribers) {
              if ((stream.desiredSize ?? 0) <= 0) {
                stream.error(new Error("MCP event consumer too slow"));
                subscribers.delete(stream);
              } else stream.enqueue(data);
            }
          }
          continue;
        }
        if (typeof frame.id === "number") pending.get(frame.id)?.resolve(frame);
      }
    } finally {
      dead = true;
      endStreams();
      for (const p of pending.values()) p.reject(new Error("MCP process exited"));
      pending.clear();
    }
  })();
  void pump.catch(() => {});
  const request = async (
    method: string,
    params: unknown,
    signal?: AbortSignal,
    clientId?: string | number,
  ) => {
    if (dead) throw new Error("MCP process exited");
    if (pending.size >= 32) throw new Error("Too many MCP requests");
    const id = ++sequence;
    if (clientId !== undefined) {
      if (clientIds.has(clientId)) throw new Error("Duplicate in-flight MCP request id");
      clientIds.set(clientId, id);
    }
    const stop = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
    let aborted: () => void = () => {};
    try {
      const response = new Promise<Rpc>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        aborted = () => {
          reject(new Error("MCP request cancelled or timed out"));
          void writer
            .send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } })
            .catch(() => {});
        };
        stop.addEventListener("abort", aborted, { once: true });
      });
      // Observe rejection if stdin itself breaks before response is awaited.
      void response.catch(() => {});
      if (stop.aborted) aborted();
      else await writer.send({ jsonrpc: "2.0", id, method, params });
      return await response;
    } finally {
      stop.removeEventListener("abort", aborted);
      pending.delete(id);
      if (clientId !== undefined) clientIds.delete(clientId);
    }
  };
  try {
    const hello = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "loom-runtime", version: "1" },
    });
    if (hello.error || !hello.result) throw new Error("Packaged MCP initialization failed");
    await writer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const lifetime = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: lifetime.signal, onListen() {} },
      async (req) => {
        if (
          new URL(req.url).pathname !== "/mcp" ||
          req.headers.get("authorization") !== `Bearer ${token}` ||
          req.headers.has("origin")
        )
          return new Response(null, { status: 403 });
        if (dead) return new Response("MCP process exited", { status: 502 });
        if (req.method === "GET") {
          if (subscribers.size >= 4) return new Response(null, { status: 503 });
          let controller: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>(
            {
              start(c) {
                controller = c;
                subscribers.add(c);
                c.enqueue(new TextEncoder().encode(": connected\n\n"));
              },
              cancel() {
                subscribers.delete(controller);
              },
            },
            { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
          );
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          });
        }
        if (req.method === "DELETE") return new Response(null, { status: 202 });
        if (req.method !== "POST") return new Response(null, { status: 405 });
        if (dead) return new Response("MCP process exited", { status: 502 });
        if (pending.size >= 32) return new Response(null, { status: 503 });
        try {
          let size = 0;
          const chunks: Uint8Array[] = [];
          if (req.body)
            for await (const chunk of req.body.pipeThrough(new TransformStream(), {
              signal: AbortSignal.any([lifetime.signal, req.signal, AbortSignal.timeout(60_000)]),
            })) {
              size += chunk.length;
              if (size > MAX_BODY) return new Response(null, { status: 413 });
              chunks.push(chunk);
            }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Rpc;
          if (
            !frame ||
            frame.jsonrpc !== "2.0" ||
            typeof frame.method !== "string" ||
            (frame.id !== undefined && typeof frame.id !== "string" && typeof frame.id !== "number")
          )
            return new Response(null, { status: 400 });
          if (frame.id === undefined) {
            if (frame.method === "notifications/cancelled") {
              const original = (frame.params as { requestId?: string | number } | undefined)
                ?.requestId;
              const mapped = original === undefined ? undefined : clientIds.get(original);
              if (mapped !== undefined)
                await writer.send({ ...frame, params: { requestId: mapped } });
            } else if (frame.method !== "notifications/initialized") await writer.send(frame);
            return new Response(null, { status: 202 });
          }
          const result =
            frame.method === "initialize"
              ? hello
              : await request(
                  frame.method,
                  frame.params ?? {},
                  AbortSignal.any([lifetime.signal, req.signal]),
                  frame.id,
                );
          return Response.json({ ...result, id: frame.id });
        } catch {
          return new Response("MCP request failed", { status: 502 });
        }
      },
    );
    let closing: Promise<void> | undefined;
    return {
      port: server.addr.port,
      exited: pump,
      close: () =>
        (closing ??= (async () => {
          dead = true;
          lifetime.abort();
          endStreams();
          for (const p of pending.values()) p.reject(new Error("MCP connection closed"));
          await writer.close().catch(() => {});
          await server.finished;
        })()),
    };
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
};
