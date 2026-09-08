import { MAX_FRAME_BYTES } from "../../../core/src/worker.ts";

/** Byte-bounded NDJSON. Partial/invalid UTF-8 and EOF in a frame fail closed. */
export const readFrames = async function* <T>(
  stream: ReadableStream<Uint8Array>,
  decode: (v: unknown) => T,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffered.length) throw new Error("truncated worker frame");
        return;
      }
      let start = 0;
      for (let i = 0; i < value.length; i++) {
        if (value[i] !== 10) continue;
        const part = value.subarray(start, i);
        if (buffered.length + part.length > MAX_FRAME_BYTES)
          throw new Error("worker frame too large");
        const bytes = new Uint8Array(buffered.length + part.length);
        bytes.set(buffered);
        bytes.set(part, buffered.length);
        buffered = new Uint8Array(0);
        yield decode(JSON.parse(decoder.decode(bytes)));
        start = i + 1;
      }
      const rest = value.subarray(start);
      if (buffered.length + rest.length > MAX_FRAME_BYTES)
        throw new Error("worker frame too large");
      const next = new Uint8Array(buffered.length + rest.length);
      next.set(buffered);
      next.set(rest, buffered.length);
      buffered = next;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
};

export class FrameWriter {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  #tail: Promise<void> = Promise.resolve();
  #bytes = 0;
  constructor(stream: WritableStream<Uint8Array>) {
    this.#writer = stream.getWriter();
  }
  send(frame: unknown): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(frame) + "\n");
    if (bytes.length > MAX_FRAME_BYTES || this.#bytes + bytes.length > 4 * MAX_FRAME_BYTES) {
      return Promise.reject(new Error("worker output overflow"));
    }
    this.#bytes += bytes.length;
    const write = this.#tail.then(() => this.#writer.write(bytes));
    this.#tail = write;
    // Observe rejection even if a caller is concurrently shutting down.
    void write.catch(() => {});
    return write.finally(() => {
      this.#bytes -= bytes.length;
    });
  }
  async close(): Promise<void> {
    await this.#tail;
    await this.#writer.close();
  }
}
