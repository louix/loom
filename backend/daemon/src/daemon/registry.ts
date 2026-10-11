import type { SessionState } from "@loom/core/events";
import type { Logger } from "@loom/core/logger";
import { sameSessionState, stateDone } from "@loom/core/session-state";
import type { SessionSnapshot } from "@loom/core/wire";
import {
  SessionStore,
  type MidRunSession,
  type NewSession,
  type UsageDelta,
} from "../store/sessions.ts";
import type { Db } from "../store/db.ts";

import { sortSessions as sortSnapshots } from "@loom/core/session-order";
export { sortSnapshots };

type StatusListener = (id: string, state: SessionState) => void;

/**
 * Owns session state: a thin, write-through layer over SessionStore that adds
 * the fleet-view sort. Adapters attach live run state here.
 */
export class Registry {
  #store: SessionStore;
  readonly #log: Logger | undefined;
  readonly #statusListeners = new Set<StatusListener>();
  /** Per session, its state as last written and its {@link statusEpoch}. */
  readonly #epochs = new Map<string, { state: SessionState; epoch: number }>();

  constructor(db: Db, log?: Logger) {
    this.#store = new SessionStore(db);
    this.#log = log;
  }

  get store(): SessionStore {
    return this.#store;
  }

  create(s: NewSession): SessionSnapshot {
    this.#store.create(s);
    return this.mustGet(s.id);
  }

  get(id: string): SessionSnapshot | null {
    return this.#store.get(id);
  }

  mustGet(id: string): SessionSnapshot {
    const s = this.#store.get(id);
    if (!s) throw new Error(`no such session: ${id}`);
    return s;
  }

  list(): SessionSnapshot[] {
    return this.#store.list();
  }

  /** Snapshots in fleet-view order: status group, then most recent turn boundary. */
  listSorted(): SessionSnapshot[] {
    return sortSnapshots(this.#store.list());
  }

  /** The sessions `supervisorId` supervises, in fleet-view order. */
  children(supervisorId: string): SessionSnapshot[] {
    return sortSnapshots(this.#store.children(supervisorId));
  }

  setStatus(id: string, state: SessionState, note: string | null = null): SessionSnapshot {
    this.#store.setStatus(id, state, note);
    const was = this.#epochs.get(id);
    if (!was || !sameSessionState(was.state, state))
      this.#epochs.set(id, { state, epoch: was ? was.epoch + 1 : 1 });
    const snap = this.mustGet(id);
    this.#statusChanged(id, state);
    return snap;
  }

  /**
   * Which spell in a state `id` is in: bumped by every status write that
   * changes the state (in this process; a write of the same state again
   * does not), so a turn that settles has an identity its next turn — which
   * leaves the settled state first — does not share, and neither does a
   * second failure. 0 before any write.
   */
  statusEpoch(id: string): number {
    return this.#epochs.get(id)?.epoch ?? 0;
  }

  /**
   * Hear of every status write, whichever path made it, and of a removal (as
   * `done`), once it is committed. Returns the unsubscribe.
   */
  watchStatus(fn: StatusListener): () => void {
    this.#statusListeners.add(fn);
    return () => this.#statusListeners.delete(fn);
  }

  /** Tell every listener. One that throws is logged, the rest still hear,
   *  and the write it heard of stands. */
  #statusChanged(id: string, state: SessionState): void {
    for (const fn of this.#statusListeners)
      try {
        fn(id, state);
      } catch (err) {
        this.#log?.warn("status listener failed", {
          id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
  }

  addUsage(id: string, d: UsageDelta): SessionSnapshot {
    this.#store.addUsage(id, d);
    return this.mustGet(id);
  }

  setFields(id: string, fields: Parameters<SessionStore["setFields"]>[1]): SessionSnapshot {
    this.#store.setFields(id, fields);
    return this.mustGet(id);
  }

  relinkProvider(from: string, to: string): number {
    return this.#store.relinkProvider(from, to);
  }

  /** Record the end of a user-submitted root turn — the fleet recency key. */
  setTurnCompletedAt(id: string, at: number): void {
    this.#store.setTurnCompletedAt(id, at);
  }

  /** Set the turn counter directly (undo). */
  setTurns(id: string, turns: number): SessionSnapshot {
    this.#store.setTurns(id, turns);
    return this.mustGet(id);
  }

  markMidRunInterrupted(): MidRunSession[] {
    return this.#store.markMidRunInterrupted();
  }

  /** Delete the row for good. Child tables cascade; a child session's
   *  `parent_id` is nulled (see the schema). */
  remove(id: string): void {
    this.#store.delete(id);
    // Gone is as ended as archived, to whoever was watching it.
    this.#statusChanged(id, stateDone);
    this.#epochs.delete(id);
  }
}
