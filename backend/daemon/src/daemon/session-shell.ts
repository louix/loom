import { randomUUID } from "node:crypto";
import type { SessionSnapshot } from "@loom/core/wire";
import type { SessionExecutions } from "@loom/core/connector";
import { IsolationError } from "@loom/isolation/errors";
import type { SessionShell } from "../../../../core/src/shell.ts";
import { readRecovery } from "../../../../runtime/src/session-vm/recovery.ts";
import { guestShellArgv, vmShellCommand } from "../../../../runtime/src/session-vm/shell.ts";
import { sessionVmDirectory } from "./session-vm-state.ts";
import { RpcError } from "./rpc.ts";
import type { Connection } from "./connection.ts";

const notRunning = () =>
  new RpcError("bad_request", "The session VM is not running. Resume it first.");

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

  /**
   * `executions` is set when the isolation launcher owns VM sessions: a VM shell is
   * then an execution beside the worker, under its own lease on the environment.
   */
  async open(
    repo: string,
    session: SessionSnapshot,
    connection: Connection,
    environment?: (cwd: string) => Promise<SessionShell["environment"]>,
    executions?: (id: string) => SessionExecutions | undefined,
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
    let leased: SessionExecutions | undefined;
    if (session.isolation === "vm" && executions) {
      leased = executions(session.id);
      if (!leased) throw notRunning();
      if (leased.workspace !== (await Deno.realPath(cwd))) {
        throw new RpcError("bad_request", "The running VM belongs to a different workspace.");
      }
    } else if (session.isolation === "vm") {
      const binding = await readRecovery(sessionVmDirectory(repo, session.id));
      if (!binding?.recovery.ready || binding.recovery.reaped) throw notRunning();
      if (binding.workspace !== (await Deno.realPath(cwd))) {
        throw new RpcError("bad_request", "The running VM belongs to a different workspace.");
      }
      vm = vmShellCommand(binding);
    }
    const localEnvironment = session.isolation !== "vm" ? await environment?.(cwd) : undefined;
    if (connection.signal.aborted) {
      throw new RpcError("disconnected", "Shell connection closed.");
    }
    let execution: string | undefined;
    if (leased) {
      try {
        // The client runs the transport; the lease also ends if its connection drops.
        ({ vm, token: execution } = leased.open(
          { argv: guestShellArgv, stdin: true, tty: true },
          connection,
        ));
      } catch (error) {
        if (error instanceof IsolationError && error.code === "disconnected")
          throw new RpcError("disconnected", "Shell connection closed.");
        throw notRunning();
      }
    }
    const token = randomUUID();
    this.#leases.set(token, { sessionId: session.id, connection });
    const release = () => this.close(token, connection);
    connection.signal.addEventListener("abort", release, { once: true });
    this.#cleanup.set(token, () => {
      connection.signal.removeEventListener("abort", release);
      if (execution) leased!.close(execution, connection);
    });
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
