import type { SessionState, SessionStateKind } from "@loom/core/events";
import type { SessionSnapshot } from "@loom/core/wire";
import {
  SessionStore,
  type MidRunSession,
  type NewSession,
  type UsageDelta,
} from "../store/sessions.ts";
import type { Db } from "../store/db.ts";

/** Fleet-view group order (design spec §4). Lower rank sorts first. */
const GROUP_RANK: Record<SessionStateKind, number> = {
  awaiting_input: 0,
  running: 1,
  starting: 1, // transient — sits with running
  working_background: 2, // settled main loop, background work still in flight
  interrupted: 3,
  idle: 4,
  error: 5,
  done: 6,
};

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

  /** Snapshots in fleet-view order: by status group, then recency within group. */
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

export const sortSnapshots = (list: SessionSnapshot[]): SessionSnapshot[] => {
  return [...list].sort((a, b) => {
    const ga = GROUP_RANK[a.status.kind] ?? 9;
    const gb = GROUP_RANK[b.status.kind] ?? 9;
    if (ga !== gb) return ga - gb;
    // awaiting_input: oldest prompt first (longest-blocked is most urgent).
    if (a.status.kind === "awaiting_input") return a.updatedAt - b.updatedAt;
    // every other group: most recently active first.
    return b.updatedAt - a.updatedAt;
  });
};
