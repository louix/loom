import { randomUUID } from "node:crypto";
import type { SessionSnapshot } from "@loom/core/wire";
import type { SessionShell } from "../../../../core/src/shell.ts";
import { readRecovery } from "../../../../runtime/src/session-vm/recovery.ts";
import { vmShellCommand } from "../../../../runtime/src/session-vm/shell.ts";
import { sessionVmDirectory } from "./session-vm-state.ts";
import { RpcError } from "./rpc.ts";
import type { Connection } from "./connection.ts";

/** Leases belong to a connection, so a crashed client cannot pin a session forever. */
export class SessionShells {
  #leases = new Map<string, { sessionId: string; connection: Connection }>();

  has(id: string): boolean {
    return [...this.#leases.values()].some((lease) => lease.sessionId === id);
  }

  assertClosed(id: string): void {
    if (this.has(id)) {
      throw new RpcError("busy", "Exit the session's open shells first.");
    }
  }

  async open(
    repo: string,
    session: SessionSnapshot,
    connection: Connection,
    environment?: (cwd: string) => Promise<SessionShell["environment"]>,
  ): Promise<SessionShell> {
    const cwd = session.inPlace ? repo : session.worktree;
    if (!cwd) {
      throw new RpcError("bad_request", "This session has no workspace. Resume it first.");
    }
    if (session.status.kind === "starting") {
      throw new RpcError("busy", "The session is starting. Open its shell once it is ready.");
    }
    if (!(await Deno.stat(cwd)).isDirectory) {
      throw new RpcError("bad_request", "The session workspace is unavailable.");
    }
    let vm: SessionShell["vm"];
    if (session.isolation === "vm") {
      const binding = await readRecovery(sessionVmDirectory(repo, session.id));
      if (!binding?.recovery.ready || binding.recovery.reaped) {
        throw new RpcError("bad_request", "The session VM is not running. Resume it first.");
      }
      if (binding.workspace !== (await Deno.realPath(cwd))) {
        throw new RpcError("bad_request", "The running VM belongs to a different workspace.");
      }
      vm = vmShellCommand(binding);
    }
    const localEnvironment = session.isolation !== "vm" ? await environment?.(cwd) : undefined;
    if (connection.signal.aborted) {
      throw new RpcError("disconnected", "Shell connection closed.");
    }
    const token = randomUUID();
    this.#leases.set(token, { sessionId: session.id, connection });
    const release = () => this.close(token, connection);
    connection.signal.addEventListener("abort", release, { once: true });
    this.#cleanup.set(token, () => connection.signal.removeEventListener("abort", release));
    return {
      token,
      sessionId: session.id,
      cwd,
      isolation: session.isolation ?? "local",
      ...(vm ? { vm } : {}),
      ...(localEnvironment ? { environment: localEnvironment } : {}),
    };
  }

  #cleanup = new Map<string, () => void>();

  close(token: string, connection: Connection): void {
    const lease = this.#leases.get(token);
    if (lease && lease.connection !== connection) {
      throw new RpcError("bad_request", "This shell belongs to another connection.");
    }
    this.#leases.delete(token);
    this.#cleanup.get(token)?.();
    this.#cleanup.delete(token);
  }
}
