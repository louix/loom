import { makeLogger } from "../../../core/src/logger.ts";
import { serveWorker } from "./serve.ts";

// Static worker-only imports. Add a connector here when its migration is ready.
await serveWorker(Deno.stdin.readable, Deno.stdout.writable, async (binding) => {
  const { createProvider } = await import("../../../connectors/mock/src/index.ts");
  return createProvider({
    id: binding.providerId,
    config: binding.config,
    logger: makeLogger("worker"),
  });
}).catch(() => {
  Deno.exit(1);
});
// Also terminates a misbehaving adapter that left work pending after parent EOF.
Deno.exit(0);
