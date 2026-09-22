import type { SessionState } from "@loom/core/events";
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

/**
 * Owns session state: a thin, write-through layer over SessionStore that adds
 * the fleet-view sort. Adapters attach live run state here.
 */
export class Registry {
  #store: SessionStore;

  constructor(db: Db) {
    this.#store = new SessionStore(db);
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

  /** Snapshots in fleet-view order: status group, then newest-created first. */
  listSorted(): SessionSnapshot[] {
    return sortSnapshots(this.#store.list());
  }

  setStatus(id: string, state: SessionState, note: string | null = null): SessionSnapshot {
    this.#store.setStatus(id, state, note);
    return this.mustGet(id);
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
  }
}
