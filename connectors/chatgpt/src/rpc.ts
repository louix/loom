/**
 * Typed JSONL RPC transport for one `codex app-server` process. Shared by the
 * long-lived `CodexAppServerSession` and short-lived discovery calls — owns
 * request/response correlation, startup/request deadlines, bounded stderr
 * diagnostics and reliable cleanup, not the app-server's actual RPC
 * vocabulary (thread/turn lifecycle), which callers layer on top via
 * `onServerRequest` / `onNotification`.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type Rpc = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Stderr is kept as a bounded tail, not an ever-growing buffer, for the life of the process. */
const DIAGNOSTICS_TAIL_CHARS = 4_000;

export interface CodexRpcClientOptions {
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexRpcClient {
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #requests = new Map<number, Pending>();
  readonly #requestTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  #next = 1;
  #stderr = "";
  #closed = false;
  #onServerRequest:
    | ((method: string, params: Record<string, unknown>, id: number | string) => void)
    | undefined;
  #onNotification: ((method: string, params: Record<string, unknown>) => void) | undefined;
  #onClose: ((err: Error) => void) | undefined;

  constructor(proc: ChildProcessWithoutNullStreams, opts: CodexRpcClientOptions = {}) {
    this.#proc = proc;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    createInterface({ input: proc.stdout }).on("line", (line) => this.#onLine(line));
    proc.stderr.on("data", (data: Buffer) => {
      this.#stderr = (this.#stderr + data.toString()).slice(-DIAGNOSTICS_TAIL_CHARS);
    });
    proc.once("exit", (code, signal) => {
      this.#fail(
        new Error(`codex app-server exited (${signal ?? code ?? "unknown"}): ${this.#stderr}`),
      );
    });
    proc.once("error", (err) => {
      this.#fail(new Error(`could not start codex app-server: ${err.message}`, { cause: err }));
    });
  }

  /** Bounded stderr tail, for surfacing in a fatal error event. */
  diagnostics(): string {
    return this.#stderr;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Registers the handler for server-initiated requests (methods with an id).
   *  An id the handler doesn't claim by calling `respond`/`respondError` itself
   *  is left to the caller; no handler at all gets an automatic unsupported-request error. */
  onServerRequest(
    handler: (method: string, params: Record<string, unknown>, id: number | string) => void,
  ): void {
    this.#onServerRequest = handler;
  }
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.#onNotification = handler;
  }
  /** Fires once, whenever the process dies or `close()` runs — with the same
   *  error every pending request was just rejected with. Callers that need to
   *  distinguish an expected close from a crash track that themselves. */
  onClose(handler: (err: Error) => void): void {
    this.#onClose = handler;
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new Error(`codex app-server request "${method}" sent after close`));
    const id = this.#next++;
    const timeoutMs = opts.timeoutMs ?? this.#requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(id);
        reject(new Error(`codex app-server request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Register before writing: a local test host (and occasionally a warmed
      // app-server) can answer in the same event-loop turn as stdin accepts it.
      this.#requests.set(id, { resolve, reject, timer });
      this.#write({ method, id, params });
    });
  }

  /** `request` with the (longer) startup deadline — for `initialize`, `thread/start`, `thread/resume`. */
  requestStartup(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.request(method, params, { timeoutMs: this.#startupTimeoutMs });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.#write({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.#write({ id, result });
  }

  respondError(id: number | string, message: string, code = -32601): void {
    this.#write({ id, error: { code, message } });
  }

  /** Idempotent: rejects every pending request with a diagnostic-tail error, then kills the process. */
  close(): void {
    if (this.#closed) return;
    this.#fail(new Error(`codex app-server closed: ${this.#stderr}`));
    this.#proc.kill();
  }

  #fail(err: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject, timer } of this.#requests.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.#requests.clear();
    this.#onClose?.(err);
  }

  #write(value: unknown): void {
    this.#proc.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #onLine(line: string): void {
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const pending = this.#requests.get(Number(msg.id));
      if (!pending) return;
      this.#requests.delete(Number(msg.id));
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message ?? "codex app-server request failed"));
      else pending.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    if (msg.id !== undefined) {
      if (this.#onServerRequest) this.#onServerRequest(msg.method, msg.params ?? {}, msg.id);
      else this.respondError(msg.id, `unsupported request: ${msg.method}`);
      return;
    }
    this.#onNotification?.(msg.method, msg.params ?? {});
  }
}
