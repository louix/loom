import type { LoomConfig } from "../config/config.ts";
import type { DoctorMcpServer } from "@loom/core/wire";
import { parseNixMcpRuntime } from "../../../../core/src/mcp-config.ts";
import { resolveRuntime } from "../../../../runtime/src/packaged/artifact.ts";

type RuntimeMcp = Extract<LoomConfig["mcp"][number], { runtime: string }>;

/** Diagnostics inspect installed artifacts, never boot or connect to a server. */
export const runtimeMcpDiagnostic = async (
  server: RuntimeMcp,
  resolve = resolveRuntime,
): Promise<DoctorMcpServer> => {
  let command = "runtime " + server.runtime;
  try {
    const source = parseNixMcpRuntime(server.runtime);
    if (source) command = `Nix package ${source.ref} (${source.executable})`;
  } catch {
    command = "Invalid Nix package source";
  }
  const grants = server.grants ?? { workspace: "read-write", network: [] };
  const network = grants.network.length
    ? `network allowed to IPs resolved from ${grants.network.join(", ")} (all ports)`
    : "network disabled";
  const note = `Separate tool VM; workspace: ${grants.workspace}; ${network}. ${server.required ? "Required. " : ""}`;
  try {
    const prepared = await resolve(server.runtime);
    return {
      name: server.name,
      command,
      resolved: prepared.manifest.entrypoint,
      status: "ok",
      note: note + "VM boot checked at session startup.",
    };
  } catch (error) {
    // Internal package identities contain arguments; keep those out of doctor.
    const detail = (error instanceof Error ? error.message : String(error))
      .replaceAll(server.runtime, command)
      .replaceAll(
        "Run loom runtime prepare.",
        server.grants ? `Run loom mcp prepare ${server.name}.` : "Run loom runtime prepare.",
      );
    return { name: server.name, command, resolved: "", status: "missing", note: note + detail };
  }
};
