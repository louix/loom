import { relayDiagnosticSchema, type RelayDiagnostic } from "../../../core/src/relay-diagnostic.ts";

export const relayDiagnosticLimit = 32;
export const relayAcceptFailureLimit = 100;
export interface GuestRelayOptions {
  kind?: RelayDiagnostic["kind"];
  index?: number;
  report?: (info: RelayDiagnostic) => void;
  /** Bounded attempts per failure streak; primarily a test seam. */
  maxAcceptFailures?: number;
}

export const reportRelayDiagnostic = (info: RelayDiagnostic) => {
  // Validate at the producer too: paths, addresses and exception messages are never logged.
  console.error(JSON.stringify({ loomRelay: relayDiagnosticSchema.parse(info) }));
};

/**
 * Bound connections before opening the guest-to-host socket bridge. A client over the
 * limit is closed at once: left in the listen backlog it would only time out.
 */
export const startGuestRelay = (
  listener: Deno.Listener,
  socket: string,
  maxConnections: number,
  options: GuestRelayOptions = {},
) => {
  if (!Number.isInteger(maxConnections) || maxConnections < 1)
    throw new Error("Relay connection limit must be a positive integer");
  const maxFailures = options.maxAcceptFailures ?? relayAcceptFailureLimit;
  if (!Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > relayAcceptFailureLimit)
    throw new Error("Invalid relay accept failure limit");
  const kind = relayDiagnosticSchema.shape.kind.parse(options.kind ?? "unknown");
  const index = relayDiagnosticSchema.shape.index.parse(options.index ?? 0);
  const clients = new Set<Deno.Conn>();
  const tasks = new Set<Promise<void>>();
  let stopped = false;
  let consecutive = 0;
  let failures = 0;
  let incident = 0;
  let forwardedIncident = 0;
  let since = 0;
  let errorName: RelayDiagnostic["error"] = "unknown";
  let emitted = 0;
  let suppressed = 0;
  let refused = 0;
  const report = (event: RelayDiagnostic["event"], terminal = false) => {
    if (!terminal && emitted >= relayDiagnosticLimit) {
      suppressed++;
      if (suppressed !== 1) return;
      event = "suppressed";
    } else if (!terminal) emitted++;
    try {
      (options.report ?? reportRelayDiagnostic)({
        kind,
        index,
        event,
        at: Date.now(),
        incident,
        error: errorName,
        consecutive,
        failures,
        active: clients.size,
        elapsedMs: incident ? Math.max(0, Math.floor(performance.now() - since)) : 0,
        stopping: stopped,
        suppressed,
        refused,
      });
    } catch {
      // Diagnostics must not change connection lifecycle.
    }
  };
  const rememberError = (error: unknown) => {
    const parsed = relayDiagnosticSchema.shape.error.safeParse(
      error instanceof Error ? error.name : "",
    );
    errorName = parsed.success ? parsed.data : "unknown";
  };
  const close = (conn: Deno.Conn) => {
    try {
      conn.close();
    } catch {
      /* Already closed. */
    }
  };
  const relay = async (client: Deno.Conn, recoveryIncident: number) => {
    let host: Deno.Conn | undefined;
    let pipes: Promise<void>[] = [];
    let directions = 0;
    const copy = async (from: Deno.Conn, to: Deno.Conn, direction: number) => {
      const buffer = new Uint8Array(65536);
      for (;;) {
        const count = await from.read(buffer);
        if (count === null) return;
        let offset = 0;
        while (offset < count) {
          const written = await to.write(buffer.subarray(offset, count));
          if (!written) throw new Deno.errors.WriteZero();
          offset += written;
          directions |= direction;
          // Both writes belong to one connection accepted after this incident.
          if (
            !stopped &&
            directions === 3 &&
            recoveryIncident === incident &&
            recoveryIncident > forwardedIncident
          ) {
            forwardedIncident = recoveryIncident;
            report("forwarded");
          }
        }
      }
    };
    try {
      host = await Deno.connect({ transport: "unix", path: socket });
      if (stopped) return;
      pipes = [copy(client, host, 1), copy(host, client, 2)];
      await Promise.race(pipes);
    } catch {
      /* Endpoint closed or unavailable. */
    } finally {
      close(client);
      if (host) close(host);
      await Promise.allSettled(pipes);
      clients.delete(client);
    }
  };
  const serving = (async () => {
    try {
      while (!stopped) {
        let client: Deno.Conn;
        try {
          client = await listener.accept();
        } catch (error) {
          rememberError(error);
          if (stopped) {
            report("accept_closed", true);
            break;
          }
          if (consecutive === 0) {
            incident++;
            since = performance.now();
          }
          consecutive++;
          failures++;
          if (
            !(error instanceof Deno.errors.NotConnected) &&
            !(error instanceof Deno.errors.ConnectionAborted) &&
            !(error instanceof Deno.errors.ConnectionReset) &&
            !(error instanceof Deno.errors.Interrupted)
          ) {
            report("accept_fatal", true);
            throw error;
          }
          if (consecutive >= maxFailures) {
            report("accept_exhausted", true);
            throw error;
          }
          // First and power-of-two attempts give context without per-attempt logs.
          if ((consecutive & (consecutive - 1)) === 0) report("accept_error");
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(250, 10 * 2 ** Math.min(consecutive - 1, 5))),
          );
          continue;
        }
        // Shutdown can race a successful accept too; do not leave its socket unowned.
        if (stopped) {
          close(client);
          break;
        }
        if (consecutive) {
          consecutive = 0;
          report("accepted");
        }
        if (tasks.size >= maxConnections) {
          close(client);
          refused++;
          // Power-of-two counts, as for accept errors, bound a refusal storm's records.
          if ((refused & (refused - 1)) === 0) report("refused");
          continue;
        }
        clients.add(client);
        const task = relay(client, incident);
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      }
    } catch (error) {
      if (!stopped) throw error;
    }
  })();
  let closing: Promise<void> | undefined;
  return {
    finished: serving,
    close: () =>
      (closing ??= (async () => {
        stopped = true;
        if (failures) report("closed", true);
        listener.close();
        for (const client of clients) close(client);
        // Cleanup must also finish when accept failed permanently.
        try {
          await serving;
        } finally {
          await Promise.allSettled(tasks);
        }
      })()),
  };
};
