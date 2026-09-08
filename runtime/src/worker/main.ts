import { makeLogger } from "../../../core/src/logger.ts";
import { serveWorker } from "./serve.ts";

// Static worker-only imports. Add a connector here when its migration is ready.
import { armWorkerShutdown, exitWorker } from "./shutdown.ts";

await serveWorker(
  Deno.stdin.readable,
  Deno.stdout.writable,
  async (binding) => {
    const { createProvider } =
      binding.connector === "@loom/connector-claude"
        ? await import("../../../connectors/claude/src/index.ts")
        : await import("../../../connectors/mock/src/index.ts");
    return createProvider({
      id: binding.providerId,
      config: binding.config,
      logger: makeLogger("worker"),
      ...(binding.baseBranch ? { baseBranch: binding.baseBranch } : {}),
    });
  },
  armWorkerShutdown,
).catch(() => {
  exitWorker(1);
});
// Also terminates a misbehaving adapter that left work pending after parent EOF.
exitWorker(0);
