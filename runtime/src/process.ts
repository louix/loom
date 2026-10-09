import type { HostStopReason } from "../../core/src/vm-termination.ts";

/** A supervised child with stdio streams; the daemon's WorkerProcess has the same shape. */
export interface ManagedProcess {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
  exited: Promise<unknown>;
  pid: number;
  terminate(reason?: HostStopReason): void;
  setStopReason?(reason: HostStopReason): void;
  cleanup?(): Promise<void>;
  /** Credential-free supervisor diagnosis, drained before interpreting worker EOF. */
  failure?(): Promise<Error | undefined>;
}
