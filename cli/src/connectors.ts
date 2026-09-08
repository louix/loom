/**
 * The connector manifest the daemon runs with. Static `import()` specifiers,
 * each resolved by its workspace member's `deno.json` name; every thunk is
 * invoked only when a session actually uses that provider, so the daemon
 * never evaluates a vendor SDK it doesn't need — even though `deno install`
 * resolves all of them up front (Deno has no equivalent to npm's
 * `optionalDependencies` for skipping unused workspace members).
 */
import type { ConnectorManifest } from "@loom/core/connector";
import { WorkerProvider } from "@loom/daemon/daemon/worker-provider";
import { mockLaunchSpec } from "@loom/daemon/daemon/worker-launch";

export const CONNECTORS: ConnectorManifest = {
  // The daemon loads only the proxy; the mock package is imported in the child.
  "@loom/connector-mock": async () => ({
    createProvider: (ctx) => WorkerProvider.create(ctx.id, mockLaunchSpec),
  }),
  "@loom/connector-claude": () => import("@loom/connector-claude"),
  "@loom/connector-generic": () => import("@loom/connector-generic"),
  "@loom/connector-gemini": () => import("@loom/connector-gemini"),
  "@loom/connector-chatgpt": () => import("@loom/connector-chatgpt"),
};
