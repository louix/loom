/**
 * The connector manifest the daemon runs with. Static `import()` specifiers,
 * each resolved by its workspace member's `deno.json` name; every thunk is
 * invoked only when a session actually uses that provider, so the daemon
 * never evaluates a vendor SDK it doesn't need — even though `deno install`
 * resolves all of them up front (Deno has no equivalent to npm's
 * `optionalDependencies` for skipping unused workspace members).
 */
import type { ConnectorManifest } from "@loom/core/connector";

export const CONNECTORS: ConnectorManifest = {
  "@loom/connector-mock": () => import("@loom/connector-mock"),
  "@loom/connector-claude": () => import("@loom/connector-claude"),
  "@loom/connector-generic": () => import("@loom/connector-generic"),
  "@loom/connector-gemini": () => import("@loom/connector-gemini"),
  "@loom/connector-chatgpt": () => import("@loom/connector-chatgpt"),
};
