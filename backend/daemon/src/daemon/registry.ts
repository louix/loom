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
    this.#seedVersion(s.id); // updatedAt-based, like every other first touch
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

  relinkProvider(from: string, to: string): number {
    return this.#store.relinkProvider(from, to);
  }

  /** Set the turn counter directly (undo) and bump the version so a
   *  version-tracking client doesn't keep a stale count. */
  setTurns(id: string, turns: number): SessionSnapshot {
    this.#store.setTurns(id, turns);
    return this.#bump(id);
  }

  markMidRunInterrupted(): MidRunSession[] {
    const rows = this.#store.markMidRunInterrupted();
    for (const { id } of rows) this.#bump(id);
    return rows;
  }

  /** Delete the row for good. Child tables cascade; a child session's
   *  `parent_id` is nulled (see the schema). The version counter is dropped. */
  remove(id: string): void {
    this.#store.delete(id);
    this.#versions.delete(id);
  }

  version(id: string): number {
    return this.#versions.get(id) ?? this.#seedVersion(id);
  }

  /**
   * First-touch version for a session the counter doesn't know yet — seeded
   * from the row's `updatedAt` (monotonic ms) rather than 1. The counter is
   * in-memory and resets on restart; without this, a client that reconnects
   * holding a pre-restart version would suppress every fresh `session_updated`
   * until the from-1 counter climbed back past it (S6). `updatedAt` only ever
   * increases, so a post-restart bump lands above whatever the client held.
   */
  #seedVersion(id: string): number {
    const seed = Math.floor(this.#store.get(id)?.updatedAt ?? 0);
    this.#versions.set(id, seed);
    return seed;
  }

  #bump(id: string): SessionSnapshot {
    const next = (this.#versions.get(id) ?? this.#seedVersion(id)) + 1;
    this.#versions.set(id, next);
    return this.mustGet(id);
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
