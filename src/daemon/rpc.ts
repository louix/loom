import type { Connection } from "./connection.ts";
import type { RequestFrame, ResponseFrame, WireError } from "../protocol/wire.ts";
import { makeLogger } from "../util/logger.ts";

const log = makeLogger("rpc");

export interface RpcContext {
  conn: Connection;
}

export type RpcHandler = (params: unknown, ctx: RpcContext) => unknown | Promise<unknown>;

/** Throw from a handler to return a structured wire error to the client. */
export class RpcError extends Error {
  code: string;
  data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export class RpcDispatcher {
  #handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    if (this.#handlers.has(method)) throw new Error(`duplicate RPC handler: ${method}`);
    this.#handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.#handlers.has(method);
  }

  async handle(req: RequestFrame, ctx: RpcContext): Promise<ResponseFrame> {
    const handler = this.#handlers.get(req.method);
    if (!handler) {
      return errFrame(req.id, { code: "method_not_found", message: `unknown method: ${req.method}` });
    }
    try {
      const result = await handler(req.params, ctx);
      return { kind: "res", id: req.id, ok: true, result: result ?? null };
    } catch (err) {
      if (err instanceof RpcError) {
        const e: WireError = { code: err.code, message: err.message };
        if (err.data !== undefined) e.data = err.data;
        return errFrame(req.id, e);
      }
      log.error("handler threw", { method: req.method, err: String(err) });
      return errFrame(req.id, {
        code: "internal",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function errFrame(id: number, error: WireError): ResponseFrame {
  return { kind: "res", id, ok: false, error };
}
