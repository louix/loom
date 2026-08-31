import type { SessionStatus } from "@loom/core/events";
import type { SessionSnapshot } from "@loom/core/wire";
import { SessionStore, type NewSession, type UsageDelta } from "../store/sessions.ts";
import type { Db } from "../store/db.ts";

/** Fleet-view group order (design spec §4). Lower rank sorts first. */
const GROUP_RANK: Record<SessionStatus, number> = {
  awaiting_input: 0,
  running: 1,
  starting: 1, // transient — sits with running
  interrupted: 2,
  idle: 3,
  error: 4,
  done: 5,
};

/**
 * Owns session state: a thin, write-through layer over SessionStore that adds
 * the per-session version counter (for `session_updated` de-duplication) and
 * the fleet-view sort. Adapters will attach live run state here in milestone 2.
 */
export class Registry {
  #store: SessionStore;
  #versions = new Map<string, number>();

  constructor(db: Db) {
    this.#store = new SessionStore(db);
  }

  get store(): SessionStore {
    return this.#store;
  }

  create(s: NewSession): SessionSnapshot {
    this.#store.create(s);
    this.#versions.set(s.id, 1);
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

  setStatus(id: string, status: SessionStatus, reason: string | null = null): SessionSnapshot {
    this.#store.setStatus(id, status, reason);
    return this.#bump(id);
  }

  addUsage(id: string, d: UsageDelta): SessionSnapshot {
    this.#store.addUsage(id, d);
    return this.#bump(id);
  }

  setFields(id: string, fields: Parameters<SessionStore["setFields"]>[1]): SessionSnapshot {
    this.#store.setFields(id, fields);
    return this.#bump(id);
  }

  markMidRunInterrupted(): string[] {
    const ids = this.#store.markMidRunInterrupted();
    for (const id of ids) this.#bump(id);
    return ids;
  }

  /** Delete the row for good. Child tables cascade; a child session's
   *  `parent_id` is nulled (see the schema). The version counter is dropped. */
  remove(id: string): void {
    this.#store.delete(id);
    this.#versions.delete(id);
  }

  version(id: string): number {
    return this.#versions.get(id) ?? 0;
  }

  #bump(id: string): SessionSnapshot {
    this.#versions.set(id, (this.#versions.get(id) ?? 0) + 1);
    return this.mustGet(id);
  }
}

export const sortSnapshots = (list: SessionSnapshot[]): SessionSnapshot[] => {
  return [...list].sort((a, b) => {
    const ga = GROUP_RANK[a.status] ?? 9;
    const gb = GROUP_RANK[b.status] ?? 9;
    if (ga !== gb) return ga - gb;
    // awaiting_input: oldest prompt first (longest-blocked is most urgent).
    if (a.status === "awaiting_input") return a.updatedAt - b.updatedAt;
    // every other group: most recently active first.
    return b.updatedAt - a.updatedAt;
  });
};
