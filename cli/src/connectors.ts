/**
 * The connector manifest the daemon runs with. Static `import()` specifiers so
 * pnpm links the packages into this (the `loom` CLI) package; each thunk is
 * invoked only when a session actually uses that provider, so the daemon never
 * evaluates a vendor SDK it doesn't need.
 *
 * A production install that skips a connector (`pnpm install --prod`, no
 * `pnpm add @loom/connector-gemini`) still lists it here — the thunk throws a
 * readable "not installed" error only if a session asks for that provider.
 */
import type { ConnectorManifest } from "@loom/core/connector";

export const CONNECTORS: ConnectorManifest = {
  "@loom/connector-mock": () => import("@loom/connector-mock"),
  "@loom/connector-claude": () => import("@loom/connector-claude"),
  "@loom/connector-generic": () => import("@loom/connector-generic"),
  "@loom/connector-gemini": () => import("@loom/connector-gemini"),
};
