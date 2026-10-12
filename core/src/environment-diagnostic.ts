/**
 * Fixed, credential-free guest environment failures. Session workers report these
 * as WorkerDiagnostic responses; standalone environments as startup failure codes.
 */
export const environmentDiagnostics = {
  sessionNixFailed:
    "Nix activation failed. Check the project shell and session.isolation.network.presets, or disable session.environment.auto_nix. Run loom vm prepare for build output.",
  sessionNixTimeout:
    "Nix activation timed out. Run loom vm prepare to warm the cache and inspect build output, or increase session.isolation.environment.timeout_seconds.",
  sessionEnvironmentFailed:
    "VM environment preparation failed. Check session.isolation.environment.command_prefix, prepare and network presets. The session has not started.",
  sessionEnvironmentTimeout:
    "VM environment preparation timed out. Check the network policy or increase isolation.environment.timeout_seconds. The session has not started.",
  sessionCheckoutFailed:
    "The session clone could not be prepared from the host repository. Check that the session branch still exists, then resume. The session has not started.",
} as const;
export type EnvironmentDiagnostic = keyof typeof environmentDiagnostics;

/** Recognize a diagnostic by its code, without importing the worker protocol. */
export const environmentDiagnosticOf = (error: unknown): EnvironmentDiagnostic | undefined => {
  const code = (error as { diagnostic?: unknown } | null)?.diagnostic;
  return typeof code === "string" && Object.hasOwn(environmentDiagnostics, code)
    ? (code as EnvironmentDiagnostic)
    : undefined;
};
