import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * thread/resume cannot opt into rawResponseItem/completed in Codex 0.160.
 * Follow only bytes appended after attachment to the provider-returned path.
 * Never replay old calls as live cells (a resumed process did not restore them).
 * This runs in the provider worker, alongside Codex, including inside a VM.
 */
export class RolloutTail {
  readonly #fd: number;
  #offset: number;
  #pending = "";
  #decoder = new StringDecoder("utf8");
  #dropping = false;
  #closed = false;
  readonly #timer: ReturnType<typeof setInterval>;

  readonly accept: (item: unknown, ts: number) => void;
  readonly failed: (error: unknown) => void;

  constructor(
    path: string,
    accept: (item: unknown, ts: number) => void,
    failed: (error: unknown) => void,
  ) {
    this.accept = accept;
    this.failed = failed;
    this.#fd = openSync(path, "r");
    try {
      this.#offset = fstatSync(this.#fd).size;
    } catch (error) {
      closeSync(this.#fd);
      throw error;
    }
    this.#timer = setInterval(() => this.flush(), 250);
    this.#timer.unref();
  }

  flush(): void {
    if (this.#closed) return;
    try {
      const size = fstatSync(this.#fd).size;
      if (size < this.#offset) {
        // Rewind/truncation invalidates the partial record, not a reason to
        // replay the retained history and resurrect tasks.
        this.#offset = size;
        this.#pending = "";
        this.#decoder = new StringDecoder("utf8");
        this.#dropping = false;
        return;
      }
      const buffer = Buffer.alloc(Math.min(64 * 1024, size - this.#offset));
      // Bound one pass so a large append cannot starve provider RPC handling.
      const end = Math.min(size, this.#offset + 4 * 1024 * 1024);
      while (this.#offset < end) {
        const n = readSync(
          this.#fd,
          buffer,
          0,
          Math.min(buffer.length, end - this.#offset),
          this.#offset,
        );
        if (!n) break;
        this.#offset += n;
        this.#consume(this.#decoder.write(buffer.subarray(0, n)));
      }
    } catch (error) {
      this.close();
      this.failed(error);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    closeSync(this.#fd);
  }

  #consume(text: string): void {
    const lines = (this.#pending + text).split("\n");
    this.#pending = lines.pop()!;
    for (const line of lines) {
      if (this.#dropping) {
        this.#dropping = false;
        continue;
      }
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row?.type !== "response_item") continue;
      const ts = Date.parse(row.timestamp);
      if (Number.isFinite(ts)) this.accept(row.payload, ts);
    }
    // Large image/reasoning records are not tool telemetry. Do not accumulate
    // unbounded partial lines; discard through the next newline.
    if (this.#pending.length > 16 * 1024 * 1024) {
      this.#pending = "";
      this.#dropping = true;
    }
  }
}
