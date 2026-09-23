import type { ConnectorContext } from "../../../core/src/connector.ts";
import { makeLogger } from "../../../core/src/logger.ts";
import { serveWorker } from "./serve.ts";

// Static worker-only imports. Add a connector here when its migration is ready.
import { armWorkerShutdown, exitWorker } from "./shutdown.ts";

export const runWorker = async (
  beforeInitialize: () => Promise<void> = async () => {},
  executionEnvironment: ConnectorContext["executionEnvironment"] = "host",
  beforeEvent?: Parameters<typeof serveWorker>[4],
) => {
  await serveWorker(
    Deno.stdin.readable,
    Deno.stdout.writable,
    async (binding, transcript) => {
      await beforeInitialize();
      const loaders = {
        "@loom/connector-claude": () => import("../../../connectors/claude/src/index.ts"),
        "@loom/connector-generic": () => import("../../../connectors/generic/src/index.ts"),
        "@loom/connector-gemini": () => import("../../../connectors/gemini/src/index.ts"),
        "@loom/connector-chatgpt": () => import("../../../connectors/chatgpt/src/index.ts"),
        "@loom/connector-echo": () => import("../../../connectors/echo/src/index.ts"),
        "@loom/connector-mock": () => import("../../../connectors/mock/src/index.ts"),
      };
      const { createProvider } = await loaders[binding.connector]();
      return createProvider({
        id: binding.providerId,
        config: binding.config,
        executionEnvironment,
        transcript,
        logger: makeLogger("worker"),
        ...(binding.baseBranch ? { baseBranch: binding.baseBranch } : {}),
      });
    },
    armWorkerShutdown,
    beforeEvent,
  ).catch(() => {
    exitWorker(1);
  });
  // Also terminates a misbehaving adapter that left work pending after parent EOF.
  exitWorker(0);
};

if (import.meta.main) await runWorker();
