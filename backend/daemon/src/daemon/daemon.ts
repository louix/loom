import { startupSignal } from "./startup.ts";
import { stateInterrupted } from "@loom/core/session-state";
import type { RpcParams } from "@loom/core/rpc-params";
import {
  currentRepoBase,
  repoBaseDirectory,
} from "../../../../runtime/src/session-vm/repo-base.ts";
import { basename } from "node:path";
import { forkContext } from "./fork-context.ts";
import {
  sessionVmDirectory,
  vmResumeBlockedReason,
  withStoppedSessionVm,
  removeSessionVmProfile,
  recoverRepositoryVms,
} from "./session-vm-state.ts";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, watchFile, unwatchFile } from "node:fs";
import { join, resolve } from "node:path";
import { absurd } from "@loom/core/absurd";
import { makeLogger, setLogFile, type Logger } from "@loom/core/logger";
import {
  ensureLoomDir,
  loomPaths,
  onPath,
  tryFindRepoRoot,
  type LoomPaths,
} from "@loom/core/paths";
import { scaffoldUserConfig, userConfigPath } from "../scaffold.ts";
import { resolveRuntime } from "../../../../runtime/src/packaged/artifact.ts";
import { preflightTools } from "./tool-preflight.ts";
import {
  claudeProfileId,
  lintConfig,
  loadConfig,
  resolveApiKey,
  resolveAgainstRepo,
  type LoomConfig,
} from "../config/config.ts";
import { readClaudeAccount } from "../config/claude-profile.ts";
import { isClaudeId } from "@loom/core/provider-id";
import { costOf, type PriceRow, type PriceTable } from "../config/pricing.ts";
import { EndpointPricing } from "./endpoint-pricing.ts";
import { LOOM_VERSION } from "@loom/core/version";
import type { HarnessEvent } from "@loom/core/events";
import {
  isLiveState,
  parseSessionState,
  type SessionState,
  type SessionStateKind,
  stateDone,
  stateError,
  stateIdle,
  stateStarting,
} from "@loom/core/session-state";
import {
  PROTOCOL_VERSION,
  type DaemonInfo,
  type DoctorMcpServer,
  type DoctorReport,
  type HelloResult,
  type ModelChoice,
  type ProviderInfo,
  type SearchResult,
  type SessionSnapshot,
  type StatePush,
} from "@loom/core/wire";
import { checkpoint, openDb, type Db } from "../store/db.ts";
import {
  ChildStore,
  CheckpointStore,
  ProviderDefaultStore,
  type MidRunSession,
  type UsageDelta,
} from "../store/sessions.ts";
import { ProviderMessageStore } from "../store/provider-messages.ts";
import { SessionEventStore } from "../store/session-events.ts";
import { SessionSearchStore } from "../store/session-search.ts";
import { estimateTokens, knownContextLimit } from "@loom/core/tokens";
import { probeOpenAiModels } from "./model-catalog.ts";
import { Registry } from "./registry.ts";
import { RpcDispatcher, RpcError, type RpcContext } from "./rpc.ts";
import { SocketServer } from "./server.ts";
import { runStartupHygiene, type HygieneReport } from "./hygiene.ts";
import { HookRunner, hookSessionOf } from "./hooks.ts";
import { SessionManager } from "./session-manager.ts";
import { SessionShells } from "./session-shell.ts";
import { mkSessionQueue, type SessionQueue } from "./session-queue.ts";
import { cheapModelFor, generateTitle } from "./titler.ts";
import { WorktreeManager, type RebaseOutcome } from "./worktrees.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import type { ConnectorManifest } from "@loom/core/connector";
import {
  isSessionMode,
  type CreateSessionOptions,
  type EffortLevel,
  type McpServerHandle,
  permissionDecisionSchema,
  planDecisionSchema,
  type SessionMode,
  type SessionRef,
} from "@loom/core/types";
import { acquirePidfile, IdleTimer, releasePidfile, type PidfileInfo } from "./lifecycle.ts";
import { repoInstructionsFor, systemPromptAppendFor } from "./prompt.ts";

/** Auto-assigned Fleet-row id colours for aisdk providers, in config order. */
const PROVIDER_PALETTE = ["cyan", "magenta", "yellow", "green", "blue", "red"];

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** How often the daemon re-checks keep-warm sessions for a cache about to lapse. */
const KEEP_WARM_SWEEP_MS = 30_000;

/** How often the daemon re-derives per-session git facts (branch / ahead /
 *  behind / dirty) so an idle session's detail line — and the TUI's `r` rebase
 *  hint — track a base branch that advanced from outside Loom. */
const GIT_FACTS_SWEEP_MS = 15_000;

/** How long `stop()` waits for session shutdown before proceeding to release
 *  the pidfile and resolve `whenClosed()` regardless. A wedged adapter must not
 *  make the daemon unkillable. */
const SHUTDOWN_GRACE_MS = 5_000;
/** Re-prime once the prompt cache has this little of its TTL left — the TUI's "red" band. */
const KEEP_WARM_RED_FRACTION = 0.08;
/**
 * Floor on the width of that band, so the sweep cannot step over it. 8% of the
 * 1h TTL Loom used to pin is ~5 minutes — many sweeps wide. 8% of a measured 5m
 * TTL is 24s, narrower than {@link KEEP_WARM_SWEEP_MS}, and the sweep then
 * misses the band outright in about a quarter of its possible phases: it sees
 * "still warm", then "already cold", and never pings. Two sweeps' width
 * guarantees at least one lands inside.
 *
 * Capped at half the TTL by the caller, so below ~4 sweeps of TTL (2 minutes)
 * the two constraints collide and the sampling rate wins. No provider offers a
 * TTL that short — Anthropic has 5m and 1h — so that is a documented limit,
 * not a case to engineer around.
 */
const KEEP_WARM_MIN_BAND_MS = KEEP_WARM_SWEEP_MS * 2;
/** Give up keeping a session warm after this many pings with no reply from the user. */
const KEEP_WARM_MAX_PINGS = 6;
/** The turn a keep-warm ping sends: trivial by design — it exists only to re-read
 *  the cached prefix and restart the TTL clock. */
const KEEP_WARM_PROMPT =
  "[loom] Automated keep-warm ping — no task here. The prompt cache was about to " +
  "expire; this message re-primes it so your next real instruction still hits cache. " +
  'Reply with just "ok" and take no other action.';

/** Render a TTL in minutes the way the config spells it — 60 → "1h", 5 → "5m". */
const ttlLabel = (minutes: number): string => {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
};

type KeepWarmMove = "skip" | "ping" | "giveup";

/**
 * What the keep-warm sweep should do for one session right now. Pure, so it can
 * be unit-tested without timers: `ping` when the session is idle and its cache
 * has dropped into the red band, `giveup` when that's happened
 * {@link KEEP_WARM_MAX_PINGS} times running with no user message in between,
 * `skip` otherwise.
 */
export const keepWarmMove = (
  s: Pick<SessionSnapshot, "status" | "cache">,
  now: number,
  pings: number,
): KeepWarmMove => {
  if (s.status.kind !== "idle") return "skip"; // never perturb a live turn / parked decision
  const { ttlMinutes, lastTurnAt } = s.cache;
  if (ttlMinutes <= 0 || lastTurnAt <= 0) return "skip";
  const ttlMs = ttlMinutes * 60_000;
  const remainingMs = lastTurnAt + ttlMs - now;
  // Never wider than half the TTL — on a pathologically short one the floor
  // would otherwise cover the whole window and ping straight after every turn.
  const bandMs = Math.min(
    Math.max(ttlMs * KEEP_WARM_RED_FRACTION, KEEP_WARM_MIN_BAND_MS),
    ttlMs / 2,
  );
  // Already cold (a full re-prime isn't what was asked for), or still comfortably warm.
  if (remainingMs <= 0 || remainingMs >= bandMs) return "skip";
  return pings >= KEEP_WARM_MAX_PINGS ? "giveup" : "ping";
};

export interface DaemonStartOptions {
  repoRoot: string;
  /** Explicit trusted config file for embedded daemons/tests; otherwise the XDG user config. */
  configFile?: string;
  /** Connector packages this daemon can load, keyed by package name. Supplied by the CLI. */
  connectors: ConnectorManifest;
  /** Skip pidfile acquisition and signal handlers (used by tests). */
  standalone?: boolean;
}

export class Daemon {
  readonly repoRoot: string;
  readonly paths: LoomPaths;
  readonly config: LoomConfig;
  readonly #configFile: string;
  readonly epoch: string = randomUUID();
  readonly startedAt: number = Date.now();

  readonly #startups = new Map<string, AbortController>();
  #log: Logger;
  #db: Db;
  #registry: Registry;
  #children: ChildStore;
  #checkpoints: CheckpointStore;
  #pmsgs: ProviderMessageStore;
  #sessionEvents: SessionEventStore;
  #search: SessionSearchStore;
  #providerDefaults: ProviderDefaultStore;
  /**
   * Serializes each session's commands end to end — configuration changes and
   * lifecycle ops alike (see {@link SessionQueue}). Also held across adapter
   * creation / revival, so a change arriving mid-mount either lands before the
   * adapter is built (and is built in) or after it is attached (and is applied
   * to it) — never in the gap where it would reach only the registry.
   */
  readonly #queue: SessionQueue = mkSessionQueue();
  /** Claude's CLI-reported model catalog, discovered once at start-up. */
  #claudeChoices: ModelChoice[] | null = null;
  /** Set once the start-up catalog probe has settled (any outcome) — drives
   *  `ProviderInfo.modelsLoading`, so the TUI shows a loader, not a stub list. */
  #claudeProbeDone = false;
  #claudeModelsError: string | undefined;
  /** Last text sent to each live session — the undo picker's turn snippets. */
  readonly #lastSend = new Map<string, string>();
  /** Prompt-cache TTL last *observed* per session, in minutes — the dedupe key
   *  for the drift notice, so it fires on a change rather than every turn. */
  readonly #cacheTtlSeen = new Map<string, number>();
  // The "already nudged for this base head" record is persisted on the session
  // row (`auto_rebase_nudged_sha`) — see `SessionStore.autoRebaseNudgedSha` —
  // so it survives a daemon restart.
  #eventSeq = 0;
  #server: SocketServer;
  #dispatcher: RpcDispatcher;
  #providers: ProviderRegistry;
  #sessions: SessionManager;
  #worktrees: WorktreeManager;
  #hooks: HookRunner;
  #idle: IdleTimer;
  readonly #pricing = new EndpointPricing();
  #pidfile: PidfileInfo | null = null;
  #standalone: boolean;
  #hygiene: HygieneReport | null = null;
  readonly #vmGenerations = new Map<string, string>();
  readonly #shells = new SessionShells();
  #environmentPoll: NodeJS.Timeout | undefined;
  #checkingEnvironment = false;
  #onConfigChange = (): void => this.#reloadConfig();
  /** Periodic sweep that re-primes the prompt cache for keep-warm sessions. */
  #warmSweep: NodeJS.Timeout | null = null;
  /** Re-entrancy guard: a slow ping must not let two sweeps overlap. */
  #sweepingWarm = false;
  /** Periodic sweep that re-derives git facts for worktree / in-place sessions. */
  #gitSweep: NodeJS.Timeout | null = null;
  /** Sessions with an auto-title one-shot in flight (fire-once guard). */
  #titling = new Set<string>();
  /** In-flight auto-title jobs — awaited at shutdown so their one-shot titler
   *  sessions (untracked by SessionManager) don't outlive the daemon. */
  readonly #titleJobs = new Set<Promise<void>>();

  readonly #revivals = new Map<string, Promise<SessionSnapshot>>();
  #stopping = false;
  #closed: Promise<void>;
  #resolveClosed!: () => void;
  #signalHandlers: Array<[Deno.Signal, () => void]> = [];

  private constructor(opts: DaemonStartOptions) {
    opts = { ...opts, repoRoot: tryFindRepoRoot(opts.repoRoot) ?? opts.repoRoot };
    this.repoRoot = opts.repoRoot;
    this.#configFile = resolve(opts.configFile ?? userConfigPath());
    this.#standalone = opts.standalone ?? false;
    // Standalone (test / embedded) daemons never probe — nothing is "loading".
    this.#claudeProbeDone = this.#standalone;
    this.paths = loomPaths(opts.repoRoot);
    ensureLoomDir(this.paths);
    setLogFile(this.paths.log);
    this.#log = makeLogger("daemon");

    // First real launch on a machine with no user config: leave an annotated
    // starter at ~/.config/loom/config.jsonc. Skipped for standalone (test /
    // embedded) daemons so an isolated XDG dir stays empty.
    if (!this.#standalone && !opts.configFile) {
      const created = scaffoldUserConfig();
      if (created) this.#log.info("wrote a starter config", { path: created });
    }
    this.config = loadConfig(this.repoRoot, this.#configFile);
    const dbPath = resolveAgainstRepo(opts.repoRoot, this.config.db);
    this.#db = openDb(dbPath);
    this.#registry = new Registry(this.#db);
    // Legacy sessions predate the mode column. Saved VM state is evidence of
    // their actual environment; current defaults must not reclassify them.
    for (const row of this.#registry.store.list()) {
      if (row.isolation) continue;
      const dir = sessionVmDirectory(this.repoRoot, row.id);
      const vm = ["profile", "aisdk", "codex-ref"].some((name) => existsSync(join(dir, name)));
      this.#registry.store.pinIsolation(row.id, vm ? "vm" : "local");
    }
    this.#children = new ChildStore(this.#db);
    this.#checkpoints = new CheckpointStore(this.#db);
    this.#pmsgs = new ProviderMessageStore(this.#db);
    this.#sessionEvents = new SessionEventStore(this.#db);
    this.#search = new SessionSearchStore(this.#db);
    this.#providerDefaults = new ProviderDefaultStore(this.#db);
    this.#dispatcher = new RpcDispatcher();
    this.#server = new SocketServer({
      sockPath: this.paths.sock,
      dispatcher: this.#dispatcher,
      onClientCountChange: (n) => this.#onActivityChange(`clients=${n}`),
    });
    this.#worktrees = new WorktreeManager({
      repoRoot: opts.repoRoot,
      treesDir: resolveAgainstRepo(opts.repoRoot, this.config.worktreeDir),
      hooksDir: join(this.paths.dir, "hooks"),
      baseBranch: this.config.baseBranch,
      log: this.#log.child("worktrees"),
    });
    this.#providers = new ProviderRegistry(
      this.config,
      this.#pmsgs,
      opts.connectors,
      opts.repoRoot,
      (sessionId, message) =>
        this.emitEvent({ type: "startup_progress", sessionId, ts: Date.now(), message }),
      (id, generation) => this.#vmGenerations.set(id, generation),
    );
    this.#hooks = new HookRunner({
      repoRoot: opts.repoRoot,
      log: this.#log.child("hooks"),
      // A failed write hook talks to the agent through the same path as the
      // commit nudge: emitted so every client sees it land, and kept out of
      // `#lastSend` so it seeds neither the undo picker nor the auto-title.
      onFeedback: async (id, text, signal) => {
        if (this.#stopping || signal.aborted) return;
        const { injected } = await this.#sessions.send(id, text, { signal });
        if (this.#stopping || signal.aborted) return;
        this.emitEvent({ type: "user_message", sessionId: id, ts: Date.now(), text, injected });
      },
      onNotice: (text, tone) => this.#emitNotice(text, tone),
      tuiPresence: () => this.#server.tuiPresence,
    });
    this.#hooks.setHooks(this.config.hooks);
    this.#sessions = new SessionManager({
      emitEvent: (ev) => {
        if (ev.type === "rate_limit" && !this.#stopping) {
          const provider = this.#registry.get(ev.sessionId)?.provider;
          if (provider) this.#registry.store.recordAccountUsage(this.#accountScope(provider), ev);
        }
        if (ev.type === "compact" && !this.#stopping) {
          // A compaction rewrote the transcript; the absolute message offsets
          // stored in the checkpoints no longer point anywhere sane, so undo
          // past a compaction isn't recoverable — drop them.
          this.#checkpoints.truncate(ev.sessionId, 0);
        }
        // Watch the stream for writes before it goes out, so a write tool's
        // `tool_call` is always recorded ahead of the `tool_result` that
        // consumes it. No-ops entirely when no hook is configured.
        if (!this.#stopping) {
          this.#hooks.observe(ev, () => {
            const s = this.#registry.get(ev.sessionId);
            return s ? hookSessionOf(s) : null;
          });
        }
        this.emitEvent(ev);
      },
      onStatus: (id, state, note) => this.#onDerivedStatus(id, state, note),
      onUsage: (id, delta) => {
        if (this.#stopping) return;
        const priced = this.#priceUsage(id, delta);
        const snap = this.#registry.addUsage(id, priced);
        // The same spend, sliced by the model that made it — `usage` is per
        // session and a session can switch models, so its totals blend them.
        this.#registry.store.addModelUsage(id, snap.provider, snap.model ?? "", priced);
        this.#noteCacheTtlDrift(snap, delta.lastCacheTtlMinutes);
        // No publish here. The manager publishes once per event, after it has
        // derived the status this usage belongs to.
      },
      onResult: (id, ok) => {
        if (this.#stopping || !ok) return;
        this.#recordCheckpoint(id);
        const job = this.#maybeAutoTitle(id).catch((err) => {
          this.#log.debug("auto-title job failed", { id, err: String(err) });
        });
        this.#titleJobs.add(job);
        void job.finally(() => this.#titleJobs.delete(job));
      },
      onOverlay: (id) => {
        if (this.#stopping) return;
        const snap = this.#registry.get(id);
        // Read the authoritative row now and let `#enrich` pull the current
        // runtime overlays off it. No git re-probe: none of these changes
        // (a permission raised or answered, a compaction beat, a sub-agent or
        // background task edge, the op gate opening) can move the worktree, and
        // they fire often enough during a turn that shelling out would be a
        // per-tool-call cost.
        if (snap) this.#publishState();
      },
      onProviderRef: (id, ref) => {
        if (this.#stopping) return;
        this.#registry.setFields(id, { providerRef: ref });
      },
      onMode: (id) => {
        if (this.#stopping) return;
        // The adapter landed somewhere new (a plan decision, or its own
        // mid-turn switch). Queued rather than written straight through:
        // unordered against an in-flight `session.setMode` it could land after
        // that command's registry write and leave the row describing a mode the
        // adapter has since left. Fire-and-forget on purpose — the manager
        // calls this from inside `respondToPlan`, and awaiting a queue an
        // approval doesn't otherwise touch would park the approval behind
        // whatever configuration command happens to be running.
        void this.#queue
          .run(id, async () => {
            if (this.#stopping) return;
            const row = this.#registry.get(id);
            // Read the mode where it lives, at the moment this runs. A value
            // captured when the notification was raised describes the session
            // before whatever overtook this in the queue — publishing it is how
            // the adapter and the row came to disagree. No live adapter (closed,
            // archived, or swapped for another) means there is nothing to
            // report, and certainly nothing to hand a replacement adapter.
            const live = this.#sessions.snapshot(id);
            if (!row || !live || row.mode === live.mode) return;
            const snap = this.#registry.setFields(id, { mode: live.mode });
            this.#publishState(snap.id);
          })
          .catch((err: unknown) => {
            // Nothing awaits this, so a rejection here (a teardown racing the
            // registry write) would otherwise surface as an unhandled one.
            this.#log.warn("mode notification failed", { id, error: String(err) });
          });
      },
      log: this.#log.child("sessions"),
    });
    this.#idle = new IdleTimer(this.config.daemon.idleShutdownMinutes, () => {
      this.#log.info("idle shutdown");
      void this.stop("idle");
    });
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });

    this.#registerHandlers();
  }

  static async start(opts: DaemonStartOptions): Promise<Daemon> {
    const d = new Daemon(opts);
    try {
      await d.#bringUp();
    } catch (err) {
      // Unwind whatever bring-up managed to claim — the pidfile (naming this
      // live pid) and the open DB handle would otherwise block every restart.
      await d.stop("bring-up failed").catch(() => {});
      throw err;
    }
    return d;
  }

  get db(): Db {
    return this.#db;
  }
  get registry(): Registry {
    return this.#registry;
  }
  get providers(): ProviderRegistry {
    return this.#providers;
  }
  get sessions(): SessionManager {
    return this.#sessions;
  }
  get sockPath(): string {
    return this.paths.sock;
  }
  get hygieneReport(): HygieneReport | null {
    return this.#hygiene;
  }

  whenClosed(): Promise<void> {
    return this.#closed;
  }

  // -------------------------------------------------------------------------
  // bring-up / tear-down
  // -------------------------------------------------------------------------

  async #bringUp(): Promise<void> {
    if (!this.#standalone) {
      this.#pidfile = acquirePidfile(this.paths.pid, this.epoch);
    }

    const recoveredVms = await recoverRepositoryVms(this.repoRoot, (id, error) => {
      const message = `VM recovery for ${id} failed: ${error instanceof Error ? error.message : String(error)}. Retry resume/archive/delete after fixing the reported problem.`;
      this.#log.warn("session VM recovery", { id, message });
      if (this.#registry.get(id))
        this.#registry.setStatus(id, stateError(message), "vm_recovery_failed");
    });

    this.#hygiene = runStartupHygiene({
      paths: this.paths,
      registry: this.#registry,
      children: this.#children,
      epoch: this.epoch,
      log: this.#log.child("hygiene"),
    });
    // A restart that interrupted sessions must tell any reconnecting client.
    for (const { id } of this.#hygiene.interruptedSessions) {
      this.#publishState(id);
    }

    this.#watchConfig();
    this.#environmentPoll = setInterval(() => void this.#checkEnvironment(), 1000);
    this.#environmentPoll.unref();
    if (!this.#standalone) this.#installSignalHandlers();

    // Listen before the model probes: a client that just spawned us can start
    // talking immediately, and a signal during the (up to ~10s) probe window is
    // now caught by the handlers above rather than hitting the default terminate.
    await this.#server.listen();

    // Anything that connects in the window between listen() and the probes
    // landing (the TUI, the moment the socket appears) fetches `providers.list`
    // with the config-pin fallback — one model per provider. Snapshot the
    // pre-probe list; if a probe resolved real catalogs, push them so those
    // clients re-seed their pickers instead of waiting for an unrelated
    // session event.
    const preProbe = JSON.stringify(this.#providerList());
    await this.#resolveAutoModels();
    await this.#refreshEndpointPricing();
    await this.#resolveClaudeModels();
    if (JSON.stringify(this.#providerList()) !== preProbe) this.#publishState();
    // Lint after detection so an auto-detect provider that resolved fine isn't
    // flagged — only a genuine failure (endpoint unreachable / no `/models`) is.
    for (const warning of lintConfig(this.config)) this.#log.warn("config", { warning });
    for (const warning of this.#orphanedProviderWarnings()) this.#log.warn("config", { warning });

    if (this.#stopping) return; // a signal landed mid-probe; stop() has the wheel

    // Re-drive agents the restart cut off mid-turn (`[auto_resume]`). Fired,
    // not awaited: revives mount provider processes and their turns run long,
    // and bring-up must not wait on them. Failures are logged per session —
    // one that can't be re-mounted (no provider ref, provider gone) simply
    // stays interrupted.
    const interrupted = (this.#hygiene?.interruptedSessions ?? []).filter(
      ({ id }) => !recoveredVms.has(id),
    );
    if (this.config.autoResume.enabled && interrupted.length > 0) {
      void this.#autoResumeInterrupted(interrupted);
    }

    this.#idle.poke(this.#isBusy());

    this.#warmSweep = setInterval(() => {
      void this.#sweepKeepWarm();
    }, KEEP_WARM_SWEEP_MS);
    this.#warmSweep.unref();

    this.#gitSweep = setInterval(() => this.#sweepGitFacts(), GIT_FACTS_SWEEP_MS);
    this.#gitSweep.unref();

    this.#log.info("daemon up", {
      pid: Deno.pid,
      epoch: this.epoch,
      repo: this.repoRoot,
      sock: this.paths.sock,
      version: LOOM_VERSION,
    });
  }

  async stop(reason: string): Promise<void> {
    if (this.#stopping) return this.#closed;
    this.#stopping = true;
    this.#hooks.close();
    this.#log.info("daemon stopping", { reason });

    this.#idle.stop();
    if (this.#warmSweep) clearInterval(this.#warmSweep);
    if (this.#gitSweep) clearInterval(this.#gitSweep);
    unwatchFile(this.#configFile, this.#onConfigChange);
    clearInterval(this.#environmentPoll);
    for (const [sig, fn] of this.#signalHandlers) Deno.removeSignalListener(sig, fn);
    this.#signalHandlers = [];

    try {
      // Time-bound the session drain: one adapter whose close() never settles
      // must not hang shutdown before the pidfile is released.
      await Promise.race([
        this.#sessions.shutdown(),
        new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref()),
      ]);
      await this.#providers.close().catch((error) => {
        this.#log.warn("provider shutdown failed", { error: String(error) });
      });
      // Give in-flight auto-title jobs (one-shot titler sessions live outside
      // the SessionManager) a brief window to finish before the DB closes.
      if (this.#titleJobs.size > 0) {
        await Promise.race([
          Promise.allSettled(this.#titleJobs),
          new Promise((r) => setTimeout(r, 2_000).unref()),
        ]);
      }
      await this.#server.close();
      try {
        checkpoint(this.#db);
        this.#db.close();
      } catch (err) {
        this.#log.warn("db close failed", { err: String(err) });
      }
    } finally {
      if (this.#pidfile) releasePidfile(this.paths.pid);
      this.#log.info("daemon stopped", { reason });
      this.#resolveClosed();
    }
    return this.#closed;
  }

  #installSignalHandlers(): void {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      const fn = () => {
        if (this.#stopping) {
          // Operator is hammering Ctrl-C because shutdown is wedged — oblige.
          this.#log.warn("second signal during shutdown; forcing exit", { sig });
          Deno.exit(1);
        }
        void this.stop(sig);
      };
      Deno.addSignalListener(sig, fn);
      this.#signalHandlers.push([sig, fn]);
    }
  }

  // -------------------------------------------------------------------------
  // event / update fan-out
  // -------------------------------------------------------------------------

  emitEvent(event: HarnessEvent): number {
    if (this.#stopping) return this.#eventSeq;
    // Persist *before* the frame goes out. The push carries the row's durable
    // id, so a client that reacts to it — by paging, or by merging it against a
    // page already in flight — has to be able to read that row back the moment
    // it sees the id.
    //
    // `status_changed` is redundant with `status_history`; `compact_progress`
    // and `context` are heartbeats the TUI never renders (see `applyPush` in
    // the frontend model). None is transcript, so none gets a row — and
    // therefore none gets an id. Nothing downstream may invent one for them.
    const durable =
      event.type === "status_changed" ||
      event.type === "compact_progress" ||
      event.type === "context"
        ? null
        : this.#sessionEvents.append(event.sessionId, event);
    const frame = {
      seq: ++this.#eventSeq,
      epoch: this.epoch,
      kind: "push",
      type: "event",
      event,
      ...(durable === null ? {} : { id: durable }),
    } as const;
    this.#server.broadcast(frame);
    return frame.seq;
  }

  /**
   * The one place a complete state snapshot is built. Reads current
   * authoritative values at publication time — never a value carried over from
   * whatever mutation prompted the call, so two changes racing to publish both
   * end up describing the same final state rather than one of them reinstating
   * a stale read.
   *
   * `refreshGitFor` re-probes exactly one session's worktree; every other
   * session uses the facts `#sweepGitFacts` maintains. Publishing happens per
   * tool call and per usage tick, so probing the whole fleet here would be a
   * `git` shell-out per session per token.
   */
  #stateFrame(refreshGitFor?: string | "all"): StatePush {
    if (refreshGitFor === "all") for (const s of this.#registry.list()) this.#refreshGitFacts(s.id);
    else if (refreshGitFor !== undefined) this.#refreshGitFacts(refreshGitFor);
    return {
      kind: "push",
      type: "state",
      state: {
        daemon: this.#daemonInfo(),
        providers: this.#providerList(),
        sessions: this.#registry.listSorted().map((s) => this.#enrich(s, false)),
      },
    };
  }

  #publishState(refreshGitFor?: string): void {
    if (this.#stopping) return;
    this.#server.broadcastState(this.#stateFrame(refreshGitFor));
  }

  #daemonInfo(): DaemonInfo {
    return {
      pid: Deno.pid,
      version: LOOM_VERSION,
      startedAt: this.startedAt,
      repoRoot: this.repoRoot,
      epoch: this.epoch,
    };
  }

  /** Re-probe one session's worktree so the next snapshot carries fresh facts. */
  #refreshGitFacts(id: string): void {
    const s = this.#registry.get(id);
    if (!s) return;
    const gitPath = s.worktree ?? (s.inPlace ? this.repoRoot : null);
    if (gitPath) this.#worktrees.facts(gitPath, s.baseBranch);
  }

  /** A daemon-level advisory for the operator (config reload feedback). */
  #emitNotice(text: string, tone: "info" | "warn"): void {
    if (this.#stopping) return;
    this.#server.broadcast({ kind: "push", seq: ++this.#eventSeq, type: "notice", text, tone });
  }

  /**
   * Overlay runtime-only facts on a stored snapshot: git facts, sub-agents,
   * cache TTL. `withGit` false skips the ~6 synchronous `git` calls — used for
   * the per-`usage` update stream during a turn, where git state can't change.
   */
  #enrich(s: SessionSnapshot, withGit = true): SessionSnapshot {
    let out = s;
    const pendingMode = this.#sessions.snapshot(s.id)?.pendingMode;
    if (pendingMode !== undefined) out = { ...out, pendingMode };
    if (this.#sessions.isStopping(s.id)) out = { ...out, stopping: true };
    if (this.#sessions.stopFailed(s.id)) out = { ...out, stopFailed: true };
    // Outstanding requests, complete enough to answer without any transcript —
    // this is what lets a second client act on a permission it never saw raised.
    const requests = this.#sessions.requestsOf(s.id);
    if (requests.length > 0) out = { ...out, requests };
    const subs = this.#sessions.subagentsOf(s.id);
    if (subs.length > 0) out = { ...out, subagents: subs };
    const bgTasks = this.#sessions.backgroundTasksOf(s.id);
    if (bgTasks.length > 0) out = { ...out, backgroundTasks: bgTasks };
    const rateLimits = this.#registry.store.accountUsage(this.#accountScope(s.provider));
    if (Object.keys(rateLimits).length > 0) out = { ...out, rateLimits };
    // A compaction holds the op gate for its whole (multi-minute) run; surface
    // it on the snapshot so a freshly attached client (reopened TUI, second
    // window) still shows "compacting…" — `compact_progress` beats are not
    // persisted. `contextUsed` is the pre-compact fill: the mapper re-measures
    // only at the boundary / next turn.
    const compacting = this.#sessions.compacting(s.id);
    if (compacting) {
      out = {
        ...out,
        compacting: {
          startedAt: compacting.startedAt,
          // The beats report the pre-compact fill; before any have arrived,
          // stand in the session's current one (the mapper re-measures only at
          // the boundary / next turn).
          before: compacting.before || s.contextUsed,
          generated: compacting.generated,
        },
      };
    }
    // Ground truth wins: once a turn has told us which ephemeral bucket the
    // provider actually wrote into, run the countdown on that. The configured
    // pin only stands in until then — it is what Loom *asked* for, and the
    // provider may quietly serve 5m instead (API key, a plan outside its usage
    // limits, Bedrock). Non-Claude providers have neither, hence 0/"none".
    if (out.cache.ttlSource !== "observed") {
      const ttlMinutes = isClaudeId(s.provider) ? this.#cacheTtlMinutes : 0;
      const ttlSource = ttlMinutes > 0 ? "config" : "none";
      if (ttlMinutes !== out.cache.ttlMinutes || ttlSource !== out.cache.ttlSource) {
        out = { ...out, cache: { ...out.cache, ttlMinutes, ttlSource } };
      }
    }
    const ttlMinutes = out.cache.ttlMinutes;
    // Keep-warm only bites when there is a TTL to race — mirror that in the
    // snapshot so the TUI never shows it "on" where it can't act.
    const keepWarm = ttlMinutes > 0 && this.#sessions.keepWarm(s.id);
    if (keepWarm !== out.keepWarm) out = { ...out, keepWarm };
    const canRewind = this.#canRewind(s.provider, s.isolation);
    if (canRewind !== out.canRewind) out = { ...out, canRewind };
    const reason = this.#resumeBlockedReason(s);
    out = { ...out, resumable: !reason, ...(reason ? { resumeBlockedReason: reason } : {}) };
    // An in-place session works in the repo root; show that dir's git state.
    const gitPath = out.worktree ?? (out.inPlace ? this.repoRoot : null);
    if (gitPath) {
      // `withGit` false (the per-usage stream) still carries the last-known
      // facts so the TUI's git line doesn't collapse to "no worktree" mid-turn.
      const git = withGit
        ? this.#worktrees.facts(gitPath, out.baseBranch)
        : this.#worktrees.cachedFacts(gitPath);
      if (git) out = { ...out, git };
    }
    return out;
  }

  get #cacheTtlMinutes(): number {
    const ttl = this.config.providers.claude.promptCacheTtl;
    switch (ttl) {
      case "1h":
        return 60;
      case "5m":
        return 5;
      case "":
        return 0;
      default:
        return absurd(ttl);
    }
  }

  /**
   * Warn when the provider is demonstrably not honouring the configured
   * `prompt_cache_ttl`. Loom pins the TTL through the CLI env var, but a pin is
   * only a request — an API key, Bedrock/Vertex, or a subscription outside its
   * usage limits can serve a shorter cache anyway, and until we read the bucket
   * back off the response that was invisible. Fires on each *change* in the
   * observed TTL rather than per turn, so a steady mismatch is said once.
   */
  #noteCacheTtlDrift(s: SessionSnapshot, observed: number | undefined): void {
    if (!observed || observed <= 0 || !isClaudeId(s.provider)) return;
    if (this.#cacheTtlSeen.get(s.id) === observed) return;
    this.#cacheTtlSeen.set(s.id, observed);
    const pinned = this.#cacheTtlMinutes;
    if (pinned <= 0 || pinned === observed) return;
    this.#emitNotice(
      `${s.id.slice(0, 8)}: prompt cache is writing at ${ttlLabel(observed)}, not the configured ` +
        `${ttlLabel(pinned)} — [providers.claude] prompt_cache_ttl is not being honoured ` +
        `(API key, Bedrock/Vertex, or a plan outside its usage limits)`,
      "warn",
    );
  }

  /**
   * Fill `model` / `models` for aisdk profiles that configured neither, by
   * probing `{base_url}/models`. Best-effort and bounded — a black-hole
   * endpoint logs a warning and leaves the profile model-less (session creation
   * on it then fails with a clear message). Mutates `this.config` in place so
   * the registry (which reads the profile by reference) sees the result.
   */
  async #resolveAutoModels(): Promise<void> {
    const pending = Object.entries(this.config.providers.aisdk).filter(
      ([id, p]) => p.autoModels && this.#providers.has(id),
    );
    if (pending.length === 0) return;
    await Promise.all(
      pending.map(async ([id, p]) => {
        try {
          const models: Awaited<ReturnType<typeof probeOpenAiModels>> =
            p.sdk === "chatgpt"
              ? ((await (await this.#providers.get(id)).listModels?.()) ?? []).map((m) => ({
                  id: m.id,
                  ...(m.context !== undefined ? { context: m.context } : {}),
                  ...(m.label !== undefined ? { label: m.label } : {}),
                  ...(m.effortLevels !== undefined ? { efforts: m.effortLevels } : {}),
                  ...(m.defaultEffort !== undefined ? { defaultEffort: m.defaultEffort } : {}),
                }))
              : await probeOpenAiModels(p.baseUrl, resolveApiKey(p));
          if (models.length === 0) throw new Error("endpoint returned no models");
          p.models = models.map((m) => m.id);
          p.model = p.models[0] ?? "";
          // Carry the catalog metadata into model choices and provider requests.
          const probed: Record<string, number> = {};
          const probedPricing: Record<string, PriceRow> = {};
          const probedLabels: Record<string, string> = {};
          const probedEfforts: Record<string, string[]> = {};
          const probedDefaultEffort: Record<string, string> = {};
          for (const m of models) {
            if (m.context !== undefined) probed[m.id] = m.context;
            if (m.label !== undefined) probedLabels[m.id] = m.label;
            if (m.pricing !== undefined) probedPricing[m.id] = m.pricing;
            if (m.efforts !== undefined) probedEfforts[m.id] = m.efforts;
            if (m.defaultEffort !== undefined) probedDefaultEffort[m.id] = m.defaultEffort;
          }
          p.modelContext = probed;
          p.modelPricing = probedPricing;
          p.modelLabels = probedLabels;
          p.modelEfforts = probedEfforts;
          p.modelDefaultEffort = probedDefaultEffort;
          p.autoModels = false;
          this.#pricing.record(this.#pricingScope(id), models);
          this.#log.info("auto-detected models", {
            provider: id,
            count: models.length,
            model: p.model,
            withContext: Object.keys(probed).length,
            withPricing: Object.keys(probedPricing).length,
            withEfforts: Object.keys(probedEfforts).length,
          });
        } catch (err) {
          this.#log.warn("model auto-detection failed — set `model` / `models` for this provider", {
            provider: id,
            baseUrl: p.baseUrl,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  /**
   * Ask the Claude CLI for its model catalog once at start-up, so `M` / `⌥p`
   * offer real choices without a hard-coded list. Skipped when the user pinned
   * `[providers.claude] models`, in standalone/test daemons, or when the
   * provider has no `listModels`. Best-effort and bounded — a failure just
   * leaves the list empty; the TUI shows its loading / empty state and the
   * config `model` pin still seeds new sessions.
   */
  async #resolveClaudeModels(): Promise<void> {
    try {
      await this.#probeClaudeCatalog();
    } finally {
      // Settled — success, failure, skip or timeout. `modelsLoading` must not
      // stick on, and the settle (even with an empty list) is what resolves a
      // TUI picker that opened while the probe was running.
      this.#claudeProbeDone = true;
    }
  }

  async #probeClaudeCatalog(): Promise<void> {
    this.#claudeModelsError = undefined;
    if (this.#standalone || !this.#claudeCatalogId) return;
    if (this.config.providers.claude.models.length > 0) return;
    try {
      const provider = await this.#providers.get(this.#claudeCatalogId);
      if (!provider.listModels) return;
      let timer: NodeJS.Timeout | undefined;
      const models = await Promise.race([
        provider.listModels(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("timed out after 10s")), 10_000);
          timer.unref();
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (models.length === 0) return;
      this.#claudeChoices = models.map((m) => ({
        id: m.id,
        label: m.label || m.id,
        ...(m.context ? { context: m.context } : {}),
        ...(m.supportsEffort ? { supportsEffort: true } : {}),
        ...(m.effortLevels && m.effortLevels.length > 0 ? { effortLevels: m.effortLevels } : {}),
      }));
      this.config.providers.claude.models = this.#claudeChoices.map((c) => c.id);
      this.#log.info("claude models discovered", { count: models.length });
    } catch (err) {
      this.#claudeModelsError =
        err instanceof Error ? err.message : "Claude model discovery failed";
      this.#log.warn("claude model discovery failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The Claude provider id that owns the shared model catalog — profile 0. */
  get #claudeCatalogId(): string {
    return (
      this.config.claudeProfiles.map(claudeProfileId).find((id) => this.#providers.has(id)) ?? ""
    );
  }

  /** The catalog probe is still running and nothing is pinned — the picker
   *  list isn't final yet (surfaced as `ProviderInfo.modelsLoading`). */
  get #claudeCatalogPending(): boolean {
    return !this.#claudeProbeDone && this.config.providers.claude.models.length === 0;
  }

  /** Configured providers for the TUI's creation flow / model switcher. */
  #providerList(): ProviderInfo[] {
    const def = this.#defaultProviderId();
    const mode = this.#defaultMode();
    const claude = this.config.providers.claude;
    // One shared model catalog (all profiles run the same `claude` binary).
    // No fabrication: until the start-up probe lands (or if it fails) the list
    // is empty and the TUI shows a loader — a one-row list of the config pin
    // read like a broken catalog. The pin still seeds new sessions below.
    const claudeModels = claude.models;

    // `paletteIx` walks PROVIDER_PALETTE for any provider without an explicit
    // colour — shared across named Claude profiles and aisdk profiles so the
    // Fleet-row tints don't collide. The base `claude` id stays plain ("").
    let paletteIx = 0;
    const autoColor = (explicit: string): string =>
      explicit || (PROVIDER_PALETTE[paletteIx++ % PROVIDER_PALETTE.length] ?? "");

    const out: ProviderInfo[] = this.config.claudeProfiles
      .filter((profile) => this.#providers.has(claudeProfileId(profile)))
      .map((profile) => {
        const id = claudeProfileId(profile);
        const account = readClaudeAccount(profile.dir);
        return {
          id,
          models: claudeModels,
          ...(this.#claudeChoices ? { modelChoices: this.#claudeChoices } : {}),
          ...(this.#claudeCatalogPending ? { modelsLoading: true } : {}),
          ...(this.#claudeModelsError ? { modelsError: this.#claudeModelsError } : {}),
          defaultModel: this.#defaultModelFor(id),
          defaultEffort: this.#defaultEffortFor(id),
          defaultMode: mode,
          defaultIsolation: this.#providers.defaultIsolation(id),
          ...(this.#providers.vmUnavailableReason(id)
            ? { vmUnavailableReason: this.#providers.vmUnavailableReason(id)! }
            : {}),
          tag: profile.tag ?? (profile.name || "Claude"),
          color: id === "claude" ? profile.color : autoColor(profile.color),
          isDefault: def === id,
          ...(account ? { account: { loginMethod: account.loginMethod, org: account.org } } : {}),
        };
      });

    for (const [id, p] of Object.entries(this.config.providers.aisdk)) {
      // Picker rows carry what the endpoint (or a pin) actually says — display
      // name, context window, and reasoning-effort support — same treatment as
      // the Claude catalog. Unknown sizes stay unhinted rather than echoing the
      // prefix-table guess as authoritative.
      const hasMeta =
        Object.keys(p.modelContext).length > 0 ||
        Object.keys(p.modelLabels).length > 0 ||
        Object.keys(p.modelEfforts).length > 0;
      out.push({
        id,
        models: p.models,
        ...(hasMeta
          ? {
              modelChoices: p.models.map((m) => {
                const ctx = knownContextLimit(m, p.modelContext);
                const efforts = p.modelEfforts[m];
                const dflt = p.modelDefaultEffort[m];
                return {
                  id: m,
                  label: p.modelLabels[m] ?? m,
                  ...(ctx !== undefined ? { context: ctx } : {}),
                  ...(efforts?.length
                    ? {
                        supportsEffort: true,
                        effortLevels: efforts,
                        ...(dflt ? { defaultEffort: dflt } : {}),
                      }
                    : {}),
                };
              }),
            }
          : {}),
        defaultModel: this.#defaultModelFor(id),
        defaultEffort: this.#defaultEffortFor(id),
        defaultMode: mode,
        defaultIsolation: this.#providers.defaultIsolation(id),
        ...(this.#providers.vmUnavailableReason(id)
          ? { vmUnavailableReason: this.#providers.vmUnavailableReason(id)! }
          : {}),
        tag: p.tag,
        color: autoColor(p.color),
        isDefault: def === id,
      });
    }
    return out.filter((provider) => this.#providers.has(provider.id));
  }

  /**
   * The provider a new session uses when the caller names none: the last
   * provider a session was created with (persisted in `meta`), else the
   * configured `default_provider`. A remembered provider that's no longer
   * configured is ignored.
   */
  #defaultProviderId(): string {
    const remembered = this.#providerDefaults.provider();
    if (remembered && this.#providers.has(remembered)) return remembered;
    return this.#providers.defaultId;
  }

  /**
   * The permission mode a new session uses when the caller names none: the
   * last mode a session was created with (persisted in `meta`), else `default`
   * (manual).
   */
  #defaultMode(): SessionMode {
    const remembered = this.#providerDefaults.mode();
    return remembered && isSessionMode(remembered) ? remembered : "default";
  }

  /**
   * The model a new session on `providerId` uses when the caller names none:
   * the last model run on it (persisted in `meta`), else a config `model` pin,
   * else the first auto-detected model. A remembered model that has dropped out
   * of the provider's detected list is ignored.
   */
  #defaultModelFor(providerId: string): string {
    if (isClaudeId(providerId)) {
      // Shared model pin / catalog, but each profile remembers its own last model.
      const c = this.config.providers.claude;
      const remembered = this.#providerDefaults.model(providerId);
      if (remembered && (c.models.length === 0 || c.models.includes(remembered))) return remembered;
      return c.model || c.models[0] || "";
    }
    const p = this.config.providers.aisdk[providerId];
    if (!p) return "";
    const remembered = this.#providerDefaults.model(providerId);
    if (remembered && (p.models.length === 0 || p.models.includes(remembered))) return remembered;
    return p.model || p.models[0] || "";
  }

  /** The effort level a new session on `providerId` gets when none is chosen —
   *  the last one used there, remembered across restarts; else the endpoint's
   *  own default for `model` (`default_reasoning_effort`), so a new session on
   *  a reasoning model sends something the endpoint endorses rather than
   *  nothing. Unlike models, a remembered effort isn't tied to a
   *  provider-reported catalog, so there's no "still valid" check to make. */
  #defaultEffortFor(providerId: string, model?: string): string {
    const remembered = this.#providerDefaults.effort(providerId);
    if (remembered) return remembered;
    if (model) return this.config.providers.aisdk[providerId]?.modelDefaultEffort[model] ?? "";
    return "";
  }

  /**
   * Spin up a fresh session from already-resolved inputs — worktree, registry
   * row, adapter, opening prompt. Shared by `session.create` and the plan
   * review's `⌥p`-onto-a-different-provider fork. Caller resolves `model` /
   * `effort` / `providerId` and does any provider-specific validation first.
   */
  async #startSession(o: {
    prompt: string;
    providerId: string;
    model: string | null;
    effort: string | null;
    mode: SessionMode;
    parentId: string | null;
    wantWorktree: boolean;
    isolation?: "vm" | "local";
    by: string | undefined;
  }): Promise<SessionSnapshot> {
    if (!o.wantWorktree && this.#worktrees.isBareRepository()) {
      throw new RpcError(
        "bad_request",
        "Bare repositories require worktrees; in-place sessions are unavailable. Enable worktrees to start a session.",
      );
    }
    const isolation = o.isolation ?? this.#providers.defaultIsolation(o.providerId);
    await this.#preflightTools(o.providerId, isolation);
    const id = randomUUID();
    this.#log.info("session_start", { sessionId: id, providerId: o.providerId });
    const aisdkProfile = this.config.providers.aisdk[o.providerId];

    let wt: { path: string; branch: string; baseRef: string } | null = null;
    // The row and the adapter are created under one hold on the session queue.
    // Between them the session is in the registry but has no run attached, so a
    // `session.setMode` landing in that window would take the inactive path and
    // update the row only — leaving the adapter on its create-time mode with
    // nothing to reconcile it. Queued, such a command simply waits and then finds
    // a live session to apply itself to.
    await this.#queue.run(id, async () => {
      this.#registry.create({
        id,
        provider: o.providerId,
        model: o.model,
        effort: o.effort,
        mode: o.mode,
        parentId: o.parentId,
        title: o.prompt.slice(0, 200),
        worktree: null,
        branch: null,
        baseBranch: this.config.baseBranch,
        inPlace: !o.wantWorktree,
        isolation,
        // Every ChatGPT session created from here on runs on Codex's app-server
        // (a provider-owned thread) — explicit so a future `grep` for
        // `history_backend = 'codex'` finds real rows, not just the absence of
        // the pre-cutover 'aisdk' legacy marker (migration 20).
        ...(aisdkProfile?.sdk === "chatgpt" ? { historyBackend: "codex" } : {}),
      });

      const startup = new AbortController();
      this.#startups.set(id, startup);
      this.#publishState();

      // The opening prompt is a user message like any follow-up — put it on the
      // event stream so it's in the log / transcript and survives a reconnect
      // (clients no longer local-echo it).
      this.emitEvent({
        type: "user_message",
        sessionId: id,
        ts: Date.now(),
        text: o.prompt,
        injected: false,
      });

      try {
        const unavailable = this.#providers.unavailableReason(o.providerId);
        if (unavailable) throw new RpcError("provider_unavailable", unavailable);
        if (aisdkProfile && !o.model)
          throw new RpcError(
            "bad_request",
            `provider "${o.providerId}" has no model; set model/models in config or choose an explicit model`,
          );
        // Remember what this session was created with, so the next `new`
        // defaults here without any of it being pinned in config.
        if (o.model && (aisdkProfile || isClaudeId(o.providerId))) {
          this.#providerDefaults.remember(o.providerId, o.model);
        }
        if (o.effort) this.#providerDefaults.rememberEffort(o.providerId, o.effort);
        this.#providerDefaults.rememberProvider(o.providerId);
        this.#providerDefaults.rememberMode(o.mode);

        if (o.wantWorktree) {
          try {
            wt = this.#worktrees.create(id, { model: o.model || o.providerId });
          } catch (cause) {
            throw new RpcError(
              "worktree_error",
              `could not create worktree: ${cause instanceof Error ? cause.message : cause}`,
            );
          }
          this.#registry.setFields(id, {
            worktree: wt.path,
            branch: wt.branch,
            baseBranch: wt.baseRef,
          });
          this.#publishState(id);
        }
        const cwd = wt ? wt.path : this.repoRoot;
        const isClaude = isClaudeId(o.providerId);
        const isAisdk = aisdkProfile !== undefined;
        const mcpHandles = this.#mcpHandles();
        const promptAppend = systemPromptAppendFor(
          isAisdk,
          mcpHandles.length > 0,
          cwd,
          this.repoRoot,
        );
        const opts: CreateSessionOptions = {
          sessionId: id,
          cwd,
          prompt: o.prompt,
          mode: o.mode,
          mcpServers: mcpHandles,
          disableTools: this.config.providers.claude.disableBuiltin,
          settingSources: this.config.providers.claude.settingSources,
          ...(isClaude || isAisdk
            ? {
                loomServer: true,
                systemPromptAppend: promptAppend,
                repoInstructions: repoInstructionsFor(cwd, this.repoRoot),
                workspaceRoot: cwd,
              }
            : {}),
          ...(o.model ? { model: o.model } : {}),
          ...(o.effort ? { effort: o.effort } : {}),
          ...(o.parentId ? { parentId: o.parentId } : {}),
        };

        this.#lastSend.set(id, o.prompt);
        const provider = await this.#providers.get(o.providerId, isolation);
        startup.signal.throwIfAborted();
        Object.assign(opts, { [startupSignal]: startup.signal });
        await this.#sessions.create(provider, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Init may have changed files before the provider failed. Preserve those
        // edits; reclaim only untouched worktrees.
        if (wt && !this.#worktrees.isDirty(wt.path)) {
          try {
            this.#worktrees.remove(wt.path, { force: true });
          } catch {
            /* best effort */
          }
          this.#registry.setFields(id, { worktree: null });
        }
        if (startup.signal.aborted) {
          this.#registry.setStatus(id, stateInterrupted("user"));
          this.#publishState(id);
          return;
        }
        const failure = `could not start session: ${message}`;
        this.#registry.setStatus(id, stateError(failure));
        this.emitEvent({
          type: "error",
          sessionId: id,
          ts: Date.now(),
          message: failure,
          fatal: true,
        });
        this.#publishState(id);
        throw new RpcError(err instanceof RpcError ? err.code : "provider_error", failure, {
          sessionId: id,
        });
      } finally {
        this.#startups.delete(id);
      }
    });

    const snap = this.#registry.mustGet(id);
    this.#publishState(snap.id);
    this.#onActivityChange("session-created");
    return snap;
  }

  /**
   * Re-instantiate the adapter for a session that isn't currently live (a
   * daemon restart left it `interrupted`, or its last turn ended). Caller must
   * have checked `!#sessions.has(id)`. Returns the fresh snapshot; the caller
   * publishes it.
   */
  #reviveSession(id: string): Promise<SessionSnapshot> {
    const pending = this.#revivals.get(id);
    if (pending) return pending;
    const row = this.#registry.get(id);
    if (!row) return Promise.reject(new RpcError("not_found", `no such session: ${id}`));
    if (!this.#registry.store.providerRef(id))
      return Promise.reject(
        new RpcError("bad_request", "session has no provider ref to resume from"),
      );
    const reason = this.#resumeBlockedReason(row);
    if (reason) return Promise.reject(new RpcError("resume_blocked", reason));
    const operation = Promise.resolve()
      .then(async () => {
        await this.#preflightTools(row.provider, row.isolation);
        return this.#doReviveSession(id);
      })
      .catch((error: unknown) => {
        if (this.#registry.get(id)?.status.kind === "starting")
          this.#registry.setStatus(
            id,
            stateError(error instanceof Error ? error.message : String(error)),
          );
        throw error;
      })
      .finally(() => {
        this.#revivals.delete(id);
        this.#publishState(id);
      });
    this.#revivals.set(id, operation);
    this.#log.info("session_resume_start", { sessionId: id, providerId: row.provider });
    this.#registry.setStatus(id, stateStarting, "resuming");
    this.#publishState(id);
    return operation;
  }

  async #doReviveSession(id: string): Promise<SessionSnapshot> {
    // Held for the whole rebuild: the adapter is constructed from the row's
    // mode / model / effort, so a configuration command must not slip into the
    // window where the session still looks inactive — it would write the row
    // only, against an adapter already built from the pre-command values.
    return this.#queue.run(id, () => this.#reviveLocked(id));
  }

  async #reviveLocked(id: string): Promise<SessionSnapshot> {
    const row = this.#registry.get(id);
    if (!row) throw new RpcError("not_found", `no such session: ${id}`);
    // An archived (`done`) session had its worktree reclaimed but its branch and
    // transcript kept — check the branch back out into a fresh tree and resume
    // on it. An in-place archived session has no branch to restore; it just
    // resumes in the repo root.
    let worktree = row.worktree;
    if (!worktree && row.branch && !row.inPlace) {
      try {
        const wt = this.#worktrees.reattach(id, row.branch, { model: row.model || row.provider });
        worktree = wt.path;
        this.#registry.setFields(id, { worktree });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new RpcError(
          "worktree_error",
          `could not restore the archived session's worktree: ${m}`,
        );
      }
    }
    const providerRef = this.#registry.store.providerRef(id);
    if (!providerRef)
      throw new RpcError("bad_request", "session has no provider ref to resume from");
    const mode: SessionMode = isSessionMode(row.mode) ? row.mode : "default";
    // If the model this session ran on has since dropped out of the endpoint's
    // list, revive on the current default instead of failing the first turn.
    let model = row.model;
    const prof = this.config.providers.aisdk[row.provider];
    if (prof && model && prof.models.length > 0 && !prof.models.includes(model)) {
      const swap = this.#defaultModelFor(row.provider);
      if (swap && swap !== model) {
        this.#emitNotice(
          `${row.provider}: model "${model}" is no longer offered — resuming ${id.slice(0, 8)} on "${swap}"`,
          "warn",
        );
        this.#registry.setFields(id, { model: swap });
        model = swap;
      }
    }
    const cwd = worktree ?? this.repoRoot;
    const mcpHandles = this.#mcpHandles();
    const isClaude = isClaudeId(row.provider);
    const isAisdk = prof !== undefined;
    const promptAppend = systemPromptAppendFor(isAisdk, mcpHandles.length > 0, cwd, this.repoRoot);
    try {
      await this.#sessions.resume(await this.#providers.get(row.provider, row.isolation), {
        sessionId: id,
        providerRef,
        cwd,
        mode,
        mcpServers: mcpHandles,
        ...(model ? { model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
        ...(isClaude || isAisdk
          ? {
              systemPromptAppend: promptAppend,
              repoInstructions: repoInstructionsFor(cwd, this.repoRoot),
              workspaceRoot: cwd,
            }
          : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError("provider_error", `could not resume session: ${message}`);
    }
    // Truthfully idle: a resume re-mounts the adapter with no turn in flight
    // (the manager seeds its tracked state `idle` too — see SessionManager.resume).
    return this.#registry.setStatus(id, stateIdle, "resumed");
  }

  /**
   * Re-drive sessions the previous daemon left mid-run (`[auto_resume]`). Each
   * one is revived from its persisted provider ref — the transcript comes back
   * with it — and sent a `[loom]` message to pick the turn back up, mirroring
   * the auto-rebase nudge (Loom's own message, so it seeds neither the undo
   * picker nor the auto-title). Sessions that were blocked on a human decision
   * (`awaiting_input`) stay parked: the pending permission / question died with
   * the old process, and answering one automatically is never safe.
   */
  async #autoResumeInterrupted(entries: MidRunSession[]): Promise<void> {
    for (const { id, was } of entries) {
      if (this.#stopping) return;
      if (was === "awaiting_input") continue;
      if (this.#sessions.has(id)) continue; // somehow live again; not ours to re-drive
      try {
        const snap = await this.#reviveSession(id);
        this.#publishState(snap.id);
        this.#onActivityChange("session-resumed");
      } catch (err) {
        this.#log.warn("auto-resume: could not revive session", {
          id,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const text =
        "[loom] The daemon restarted mid-turn and cut your previous turn off. " +
        (was === "working_background"
          ? "Its background tasks died with the old process — check them and re-run what's still needed. "
          : "") +
        "Re-check any state you need, then continue the work from where you left off; " +
        "if it was already finished, report the outcome instead of starting over.";
      // Loom's own message, like the auto-rebase nudge: keep it out of
      // `#lastSend` so it seeds neither the undo picker nor the auto-title.
      this.emitEvent({
        type: "user_message",
        sessionId: id,
        ts: Date.now(),
        text,
        injected: false,
      });
      void this.#sessions.send(id, text).catch((err) => {
        this.#log.warn("auto-resume send failed", { id, err: String(err) });
      });
    }
  }

  #enrichAll(list: SessionSnapshot[]): SessionSnapshot[] {
    return list.map((s) => this.#enrich(s));
  }

  /** A state transition the session manager derived from the event stream. */
  #onDerivedStatus(id: string, state: SessionState, note?: string): void {
    if (this.#stopping) return;
    const snap = this.#registry.setStatus(id, state, note ?? null);
    this.emitEvent({
      type: "status_changed",
      sessionId: id,
      status: state,
      ts: Date.now(),
      ...(note !== undefined ? { note } : {}),
    });
    this.#publishState(snap.id);
    this.#onActivityChange(`status:${state.kind}`);

    // A turn just ended (this hook only fires for event-stream-derived
    // transitions — not rewind / fork, which set idle directly). Good moment to
    // pull the branch up to its base and, failing that, to flag a worktree the
    // agent left with uncommitted changes.
    if (state.kind === "idle" && !this.#maybeAutoRebase(id)) this.#maybeCommitNudge(id);

    this.#fireStatusHooks(snap, state);
  }

  /**
   * `[[hooks]]` for a transition the event stream produced. Only the states a
   * human would want to hear about fire: the turn finished, or it stopped and
   * is waiting on someone. `running` / `starting` / `working_background` are
   * mid-turn and would be pure noise; `done` is a human marking the session
   * closed, not the agent reaching anything.
   *
   * Deliberately *after* the auto-rebase / commit nudge above: those can send
   * the agent a message, which moves the session back to `running`, and a
   * notifier should be told the state the session actually settled in.
   */
  #fireStatusHooks(snap: SessionSnapshot, state: SessionState): void {
    if (this.#hooks.empty) return;
    const current = this.#registry.get(snap.id) ?? snap;
    const session = hookSessionOf(current);
    switch (state.kind) {
      case "idle":
        this.#hooks.turnEnded(session);
        return;
      case "awaiting_input":
        this.#hooks.waiting(session, state.on);
        return;
      case "error":
        this.#hooks.stopped(session, "error", state.message);
        return;
      case "interrupted":
        this.#hooks.stopped(session, "interrupted", state.by);
        return;
      default:
        return;
    }
  }

  /**
   * Keep a session's branch current with its base (`[auto_rebase]`) when a turn
   * ends. Returns true when it messaged the agent (asked it to integrate the
   * base itself) — the caller then skips the commit reminder so a dirty branch
   * doesn't get two nudges in one breath. Runs synchronously: the `git`
   * shell-out blocks the loop, which is also what keeps it from racing an
   * incoming `session.send`.
   */
  #maybeAutoRebase(id: string): boolean {
    if (this.#stopping || !this.config.autoRebase.enabled) return false;
    const snap = this.#registry.get(id);
    if (!snap?.worktree) return false; // in-place sessions have no branch to move
    return this.#syncOntoBase(id, true).nudged;
  }

  /**
   * One `syncOntoBase` pass for a session that has a worktree. `nudge` — the
   * auto path — messages the agent once per base commit on a dirty / conflicted
   * tree; the manual `session.rebase` RPC passes false and reports the outcome
   * to its caller instead. Returns the raw outcome (null when the session is
   * gone or has no worktree) plus whether it messaged the agent.
   */
  #syncOntoBase(id: string, nudge: boolean): { outcome: RebaseOutcome | null; nudged: boolean } {
    const snap = this.#registry.get(id);
    if (!snap?.worktree) return { outcome: null, nudged: false };

    const { mode } = this.config.autoRebase;
    const res = this.#worktrees.syncOntoBase(snap.worktree, snap.baseBranch, mode);
    if (res.outcome === "no-base" || res.outcome === "current") {
      return { outcome: res, nudged: false };
    }
    // The agent is mid-rebase/merge in its own worktree — leave it entirely
    // alone (don't nudge, don't clear the nudge record) and try again next idle.
    if (res.outcome === "busy") {
      this.#log.debug("auto-rebase skipped — agent op in progress", { id, op: res.op });
      return { outcome: res, nudged: false };
    }

    if (res.outcome === "updated") {
      this.#registry.store.setAutoRebaseNudgedSha(id, "");
      this.#emitNotice(
        `${snap.branch}: ${mode === "merge" ? "merged" : "rebased onto"} ` +
          `${res.base} (+${res.behind}) → ${res.head}`,
        "info",
      );
      this.#publishState(id);
      return { outcome: res, nudged: false };
    }

    // dirty | conflict | error — the agent has to integrate it. Nudge once per
    // base commit so a branch that stays behind doesn't nag every turn (and,
    // now that it's persisted, doesn't nag again after a daemon restart). A
    // manual rebase skips the nudge — its caller surfaces the outcome directly.
    if (!nudge) return { outcome: res, nudged: false };
    if (this.#registry.store.autoRebaseNudgedSha(id) === res.baseHead) {
      return { outcome: res, nudged: false };
    }
    this.#registry.store.setAutoRebaseNudgedSha(id, res.baseHead);

    const verb = mode === "merge" ? "merge" : "rebase";
    const why =
      res.outcome === "dirty"
        ? "your worktree has uncommitted changes, so it was left alone"
        : `an automatic ${verb} hit conflicts, so your branch is unchanged`;
    const text =
      `[loom] The base branch \`${res.base}\` advanced by ${res.behind} commit(s) and ${why}. ` +
      `When you're at a clean stopping point, ${verb} \`${res.base}\` into this branch ` +
      `and resolve any conflicts.`;
    // Mirror the `session.send` RPC's echo, minus `#lastSend`: this nudge is
    // Loom's, so it shouldn't seed the undo picker or the next auto-title.
    this.emitEvent({ type: "user_message", sessionId: id, ts: Date.now(), text, injected: false });
    void this.#sessions.send(id, text).catch((err) => {
      this.#log.warn("auto-rebase nudge failed", { id, err: String(err) });
    });
    return { outcome: res, nudged: true };
  }

  /**
   * When a turn ends with uncommitted changes in the session's worktree, remind
   * the agent to commit them (`[commit_reminder]`). The HEAD it was last nudged
   * at is persisted (`commit_nudged_sha`, so a restart doesn't repeat it); while
   * HEAD doesn't move the reminder stays quiet, so an agent that left the tree
   * dirty on purpose isn't nagged. Once it commits, HEAD advances and a later
   * batch of uncommitted work earns one fresh reminder; a clean tree clears the
   * record. Never commits anything itself.
   */
  #maybeCommitNudge(id: string): void {
    if (this.#stopping || !this.config.commitReminder.enabled) return;
    const snap = this.#registry.get(id);
    if (!snap?.worktree) return; // in-place sessions have no isolated tree

    const store = this.#registry.store;
    if (!this.#worktrees.isDirty(snap.worktree)) {
      if (store.commitNudgedSha(id) !== "") store.setCommitNudgedSha(id, "");
      return;
    }
    // A paused rebase / merge / cherry-pick reads as "dirty" too, but "commit
    // this" is the wrong advice mid-operation — leave it alone.
    if (this.#worktrees.pendingGitOp(snap.worktree)) return;

    const head = this.#worktrees.headSha(snap.worktree) ?? "";
    if (head !== "" && store.commitNudgedSha(id) === head) return; // already nudged since the last commit
    store.setCommitNudgedSha(id, head);

    const text =
      "[loom] This turn ended with uncommitted changes in your worktree. If that " +
      "work is done, commit it (the `commit` tool, or `git commit`). If you left it " +
      "uncommitted on purpose, ignore this — you won't be reminded again until you commit.";
    // Loom's own message, like the auto-rebase nudge: keep it out of `#lastSend`
    // so it seeds neither the undo picker nor the auto-title.
    this.emitEvent({ type: "user_message", sessionId: id, ts: Date.now(), text, injected: false });
    void this.#sessions.send(id, text).catch((err) => {
      this.#log.warn("commit reminder failed", { id, err: String(err) });
    });
  }

  /** Retry unfinished naming on successful turns, independently of turn count. */
  async #maybeAutoTitle(id: string): Promise<void> {
    if (this.#stopping || !this.config.titles.enabled || this.#titling.has(id)) return;
    const snap = this.#registry.get(id);
    if (!snap?.title || snap.status.kind === "done") return;
    const store = this.#registry.store;
    const needsTitle = !store.titleLocked(id) && !store.autoTitleDone(id);
    const needsBranch = snap.branch === `loom/${id.slice(0, 8)}` || snap.branch === `loom/${id}`;
    if (!needsTitle && !needsBranch) return;
    this.#titling.add(id);
    try {
      if (needsTitle && this.#providers.has(snap.provider)) {
        const provider = await this.#providers.get(snap.provider, snap.isolation);
        const model =
          (isClaudeId(snap.provider)
            ? this.config.providers.claude.titleModel
            : this.config.providers.aisdk[snap.provider]?.titleModel) ||
          cheapModelFor(snap.provider);
        const title = await generateTitle({
          provider,
          prompt: snap.title,
          cwd: snap.worktree ?? this.repoRoot,
          log: this.#log.child("titler"),
          ...(model ? { model } : {}),
        });
        const current = this.#registry.get(id);
        if (this.#stopping || !current || current.status.kind === "done") return;
        if (title && !store.titleLocked(id)) {
          this.#registry.setFields(id, { title, autoTitleDone: true });
        }
      }
    } catch (err) {
      this.#log.warn("auto-title failed; will retry after a later turn", { id, err: String(err) });
    } finally {
      // Read the current row: generation may race a manual title, archive, or removal.
      this.#titling.delete(id);
      if (!this.#stopping) {
        this.#maybeNameBranch(id);
        if (this.#registry.get(id)) this.#publishState(id);
      }
    }
  }

  /** Naming the branch must not depend on a successful model request. */
  #maybeNameBranch(id: string): void {
    const snap = this.#registry.get(id);
    if (!snap?.title || !snap.worktree || snap.status.kind === "done") return;
    if (snap.branch !== `loom/${id.slice(0, 8)}` && snap.branch !== `loom/${id}`) return;
    const branch = this.#worktrees.renameBranch(snap.title, snap.branch);
    if (branch !== snap.branch) this.#registry.setFields(id, { branch });
  }

  /**
   * Isolate advertised rates by provider, endpoint, and credential identity.
   */
  #pricingScope(provider: string): string {
    const p = this.config.providers.aisdk[provider];
    return createHash("sha256")
      .update(JSON.stringify([provider, p?.sdk, p?.baseUrl, p ? resolveApiKey(p) : ""]))
      .digest("hex");
  }

  async #refreshEndpointPricing(force = false): Promise<void> {
    await Promise.all(
      Object.entries(this.config.providers.aisdk).map(async ([id, p]) => {
        if (p.sdk !== "openai" || !p.baseUrl) return;
        try {
          await this.#pricing.refresh(this.#pricingScope(id), p.baseUrl, resolveApiKey(p), force);
        } catch (err) {
          this.#log.debug("endpoint pricing unavailable", { provider: id, err: String(err) });
        }
      }),
    );
  }

  #priceTable(provider: string): PriceTable {
    const p = this.config.providers.aisdk[provider];
    if (p?.sdk === "openai" && p.baseUrl) {
      void this.#pricing
        .refresh(this.#pricingScope(provider), p.baseUrl, resolveApiKey(p))
        .catch((err) =>
          this.#log.debug("endpoint pricing unavailable", { provider, err: String(err) }),
        );
    }
    return this.#pricing.table(this.#pricingScope(provider));
  }

  /**
   * Reported costs always win. Otherwise use fresh endpoint prices, or mark
   * the delta unpriced. Never reinterpret an unknown rate as a free request.
   */
  #priceUsage(id: string, delta: UsageDelta): UsageDelta {
    // Claude reports costs across subagents and internal calls, which may
    // use different models. Repricing everything at the main model is wrong.
    const owner = this.#registry.get(id)?.provider;
    if (delta.costSource === "provider") return delta;
    const tokens =
      (delta.input ?? 0) + (delta.output ?? 0) + (delta.cacheRead ?? 0) + (delta.cacheWrite ?? 0);
    if (tokens <= 0) return delta; // a bare { turns: 1 } — nothing to price
    const model = this.#registry.get(id)?.model ?? null;
    // The TTL this turn wrote at, so a table that prices no cache write can
    // still charge the right ephemeral multiple for it rather than nothing.
    const tableCost = costOf(
      this.#priceTable(owner ?? ""),
      model,
      {
        input: delta.input ?? 0,
        output: delta.output ?? 0,
        cacheRead: delta.cacheRead ?? 0,
        cacheWrite: delta.cacheWrite ?? 0,
      },
      delta.lastCacheTtlMinutes ?? 0,
      delta.cacheCreation,
    );
    if (tableCost != null) return { ...delta, costUsd: tableCost, costSource: "table" };
    if ((delta.costUsd ?? 0) > 0) return { ...delta, costSource: "provider" };
    return { ...delta, costSource: "none" };
  }

  #isAisdk(providerId: string): boolean {
    return this.config.providers.aisdk[providerId] !== undefined;
  }

  #accountScope(provider: string): string {
    const profile = this.config.claudeProfiles.find((p) => claudeProfileId(p) === provider);
    const account = profile ? readClaudeAccount(profile.dir) : null;
    const p = this.config.providers.aisdk[provider];
    // Hash the identity; never put an API key or account email in the database.
    // Unknown identities stay isolated to their configured profile.
    let identity: Array<string | undefined> = [provider];
    if (account?.email) identity = ["claude", account.email, account.org, account.loginMethod];
    else if (profile) identity = ["claude-profile", profile.dir, account?.loginMethod];
    else if (p) identity = [p.sdk, p.baseUrl, p.configDir || provider, resolveApiKey(p)];
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  }

  /** Whether `providerId`'s adapter can `undo` — its real `capabilities.rewind`
   *  once the provider's been built, else a guess from the provider type. Every
   *  adapter Loom ships rewinds; the guess only bridges the gap before a
   *  provider's first construction. */
  #canRewind(providerId: string, isolation?: "vm" | "local"): boolean {
    const caps = this.#providers.capsOf(providerId, isolation);
    if (caps) return caps.rewind;
    return this.#isAisdk(providerId) || providerId === "fake" || isClaudeId(providerId);
  }

  /** Whether `providerId`'s adapter owns its transcript in Loom's own store
   *  (`provider_messages`) rather than a thread the provider owns — its real
   *  `capabilities.ownsTranscript` once built, else a guess from the provider
   *  type (matches every aisdk profile Loom ships) before its first
   *  construction. */
  #ownsTranscript(providerId: string, isolation?: "vm" | "local"): boolean {
    const caps = this.#providers.capsOf(providerId, isolation);
    if (caps) return caps.ownsTranscript;
    return this.#isAisdk(providerId);
  }

  /** Whether `id` (a session row, not a provider) can be resumed. Only
   *  sessions on a `sdk = "chatgpt"` profile (the literal `chatgpt` id, or a
   *  custom `[providers.<id>]` one) that predate Phase 4's Codex cutover
   *  (`history_backend = 'aisdk'`, migration 20 — evidence from
   *  `provider_messages`, not the provider's name) are excluded: their
   *  `provider_ref` is a Loom transcript-store id, not a Codex thread id, and
   *  handing it to `CodexAppServerSession.resume()` would either error
   *  confusingly or silently start an unrelated new thread. History stays
   *  readable; only resuming is blocked. Checked against *live* config, not
   *  a name literal, so a custom chatgpt-sdk profile is covered exactly like
   *  the built-in `chatgpt` id. */
  #resumeBlockedReason(row: SessionSnapshot): string | undefined {
    if (this.#sessions.has(row.id) || this.#revivals.has(row.id) || row.status.kind === "starting")
      return;
    const unavailable = this.#providers.unavailableReason(row.provider);
    if (unavailable) return unavailable;
    if (row.isolation === "vm") {
      const reason = this.#providers.vmUnavailableReason(row.provider);
      if (reason) return `${reason}. Fork with Local isolation to continue.`;
    }
    if (
      this.config.providers.aisdk[row.provider]?.sdk === "chatgpt" &&
      this.#registry.store.historyBackend(row.id) === "aisdk"
    )
      return "This session used the old ChatGPT backend. Start a new session; its history remains viewable.";
    if (
      this.#isAisdk(row.provider) &&
      this.config.providers.aisdk[row.provider]?.sdk !== "chatgpt" &&
      this.#registry.store.providerRef(row.id)
    ) {
      const savedVm = existsSync(join(sessionVmDirectory(this.repoRoot, row.id), "aisdk"));
      const vm = row.isolation === "vm";
      if (savedVm !== vm)
        return "This session used a different isolation mode. Fork to continue with the current policy.";
    }
    if (
      this.config.providers.aisdk[row.provider]?.sdk === "chatgpt" &&
      this.#registry.store.providerRef(row.id)
    ) {
      const savedVm = existsSync(join(sessionVmDirectory(this.repoRoot, row.id), "codex-ref"));
      const vm = row.isolation === "vm";
      if (
        vm &&
        savedVm &&
        !existsSync(join(sessionVmDirectory(this.repoRoot, row.id), "profile/sessions"))
      )
        return "No saved Codex VM history. Fork to continue.";
      if (savedVm !== vm)
        return "This session used a different isolation mode. Fork to continue with the current policy.";
    }
    if (isClaudeId(row.provider)) {
      const ref = this.#registry.store.providerRef(row.id);
      if (ref) return vmResumeBlockedReason(this.repoRoot, row.id, ref, row.isolation === "vm");
    }
    return undefined;
  }

  /** Effort strings `providerId`/`model` actually advertises, beyond Loom's own
   *  five-value union — the same discovery data `#providerList` already
   *  exposes to the picker (Claude's shared catalog, or an aisdk profile's
   *  probed `modelEfforts`). */
  #advertisedEfforts(providerId: string, model?: string | null): readonly string[] {
    if (isClaudeId(providerId)) {
      return this.#claudeChoices?.find((c) => c.id === model)?.effortLevels ?? [];
    }
    const p = this.config.providers.aisdk[providerId];
    return (model && p?.modelEfforts[model]) || [];
  }

  /** Snapshot a completed turn so it can be rewound / forked from later. */
  #recordCheckpoint(id: string): void {
    const snap = this.#registry.get(id);
    if (!snap || snap.turns <= 0) return;
    // A provider that owns its transcript (aisdk) → the fork point is a
    // message count; one that rewinds through its own harness (Claude) → it's
    // the turn's last chain-entry UUID (from the adapter's mapper). Both live
    // in `fork_point`.
    const forkPoint = this.#ownsTranscript(snap.provider, snap.isolation)
      ? String(this.#pmsgs.count(id))
      : (this.#sessions.snapshot(id)?.rewindRef ?? "");
    // The full text that started this turn — the undo picker prefills a fresh
    // prompt with it ("redo this"), so it's kept whole (newlines and all); the
    // TUI clips it for the row label. Unbounded, like the event log.
    const userText = (this.#lastSend.get(id) ?? snap.title ?? "").trim();
    // Where the working tree is at this turn boundary, so `session.rewind` can
    // offer to restore it (or at least report how far it has drifted). Skipped
    // for in-place sessions — no isolated worktree to reset.
    const headSha = snap.worktree ? (this.#worktrees.headSha(snap.worktree) ?? "") : "";
    const headDirty = snap.worktree ? this.#worktrees.isDirty(snap.worktree) : false;
    this.#checkpoints.record(id, {
      turn: snap.turns,
      providerRef: this.#registry.store.providerRef(id) ?? "",
      forkPoint,
      userText,
      headSha,
      headDirty,
    });
  }

  /** ~cost to re-prime an aisdk transcript truncated to `keepMessages` (a cache write). */
  #rewindCostUsd(model: string | null, keepMessages: number, id: string): number {
    const keep = Math.min(Math.max(0, keepMessages), this.#pmsgs.count(id));
    if (keep <= 0) return 0;
    const tokens = estimateTokens(this.#pmsgs.load(id).slice(0, keep));
    // Priced at the TTL this session was last seen writing at — a re-prime is a
    // cache write, and quoting it at zero is what made undo look free.
    const ttl = this.#registry.get(id)?.cache.ttlMinutes ?? 0;
    return (
      costOf(
        this.#priceTable(this.#registry.get(id)?.provider ?? ""),
        model,
        { input: 0, output: 0, cacheRead: 0, cacheWrite: tokens },
        ttl,
      ) ?? 0
    );
  }

  #onActivityChange(why: string): void {
    if (this.#stopping) return;
    const busy = this.#isBusy();
    this.#log.debug("activity change", { why, busy });
    this.#idle.poke(busy);
  }

  #isBusy(): boolean {
    if (this.#server.clientCount > 0) return true;
    return this.#registry.list().some((s) => isLiveState(s.status));
  }

  /**
   * Re-prime the prompt cache for any keep-warm session whose TTL is about to
   * lapse. Runs on a timer ({@link KEEP_WARM_SWEEP_MS}); a no-op unless a
   * session has keep-warm on and has gone quiet with its cache in the red band.
   */
  async #sweepKeepWarm(): Promise<void> {
    if (this.#stopping || this.#sweepingWarm) return;
    this.#sweepingWarm = true;
    try {
      for (const id of this.#sessions.keepWarmIds()) {
        const snap = this.#registry.get(id);
        if (!snap) continue;
        const move = keepWarmMove(
          this.#enrich(snap, false),
          Date.now(),
          this.#sessions.warmPingCount(id),
        );
        if (move === "skip") continue;
        if (move === "giveup") {
          this.#sessions.setKeepWarm(id, false);
          this.#publishState(id);
          this.#emitNotice(
            `keep-warm off for ${id.slice(0, 8)} — re-primed ${KEEP_WARM_MAX_PINGS}× with no reply`,
            "info",
          );
          continue;
        }
        try {
          await this.#sessions.send(id, KEEP_WARM_PROMPT, { keepWarm: true });
          this.#log.debug("keep-warm ping", { id });
          this.#onActivityChange("keep-warm");
        } catch (err) {
          this.#log.warn("keep-warm ping failed", {
            id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.#sweepingWarm = false;
    }
  }

  /**
   * Re-derive git facts for every worktree / in-place session and push a
   * one snapshot if any of them moved. These are the maintained facts every
   * other publication reads, so nothing else has to shell out: without the
   * sweep an idle session's branch / ahead / behind / dirty line would go
   * stale the moment the base branch advanced from outside Loom (a plain
   * `git commit` on `main`) until that session next had activity.
   *
   * Skipped when no client is attached (no point shelling out `git` for
   * nobody). `facts()` shells out synchronously — the sweep can't overlap
   * itself.
   */
  #sweepGitFacts(): void {
    if (this.#stopping || this.#server.clientCount === 0) return;
    // `facts()` is cached per path; compute once per distinct worktree, since
    // sessions share them (every in-place session shares the repo root).
    const seen = new Set<string>();
    let moved = false;
    for (const snap of this.#registry.list()) {
      const gitPath = snap.worktree ?? (snap.inPlace ? this.repoRoot : null);
      if (!gitPath || seen.has(gitPath)) continue;
      seen.add(gitPath);
      const prev = this.#worktrees.cachedFacts(gitPath);
      const next = this.#worktrees.facts(gitPath, snap.baseBranch);
      if (next != null && JSON.stringify(prev) !== JSON.stringify(next)) moved = true;
    }
    if (moved) this.#publishState();
  }

  // -------------------------------------------------------------------------
  // live config reload
  // -------------------------------------------------------------------------

  /** A successful publication is the only signal to replace idle VMs. */
  async #checkEnvironment(): Promise<void> {
    if (this.#stopping || this.#checkingEnvironment || this.#vmGenerations.size === 0) return;
    this.#checkingEnvironment = true;
    try {
      for (const [id, previous] of this.#vmGenerations) {
        const provider = this.#registry.get(id)?.provider;
        const policy = provider ? this.#providers.vmPolicy(provider) : undefined;
        const base = await currentRepoBase(
          repoBaseDirectory(this.repoRoot),
          policy ? await Deno.realPath(policy.artifact) : undefined,
        );
        if (this.#stopping) return;
        if (!base) continue;
        const generation = basename(base);
        if (
          !this.#sessions.has(id) &&
          !this.#revivals.has(id) &&
          this.#registry.get(id)?.status.kind !== "starting"
        ) {
          this.#vmGenerations.delete(id);
          continue;
        }
        if (
          generation === previous ||
          this.#shells.has(id) ||
          this.#revivals.has(id) ||
          !this.#sessions.canRefresh(id) ||
          this.#hooks.isRunning(id)
        )
          continue;
        const operation = this.#queue
          .run(id, async () => {
            if (
              this.#stopping ||
              this.#shells.has(id) ||
              !this.#sessions.canRefresh(id) ||
              this.#hooks.isRunning(id)
            )
              return this.#registry.mustGet(id);
            const warm = this.#sessions.keepWarm(id);
            const stopped = this.#sessions.suspendIdle(id);
            this.#registry.setStatus(id, stateStarting, "updating environment");
            this.emitEvent({
              type: "startup_progress",
              sessionId: id,
              ts: Date.now(),
              message: "Updating session to the new prepared environment…",
            });
            this.#publishState(id);
            await stopped;
            if (this.#stopping) return this.#registry.mustGet(id);
            const snap = await this.#reviveLocked(id);
            if (warm) this.#sessions.setKeepWarm(id, true);
            return snap;
          })
          .catch((error: unknown) => {
            if (!this.#stopping) {
              const message = error instanceof Error ? error.message : String(error);
              this.#registry.setStatus(id, stateError(message));
              this.emitEvent({
                type: "error",
                sessionId: id,
                ts: Date.now(),
                message: `Environment update failed: ${message}`,
                fatal: true,
              });
            }
            throw error;
          })
          .finally(() => {
            this.#revivals.delete(id);
            if (!this.#stopping) this.#publishState(id);
          });
        this.#revivals.set(id, operation);
        void operation.catch(() => {});
      }
    } catch (error) {
      this.#log.warn("prepared environment check failed", { err: String(error) });
    } finally {
      this.#checkingEnvironment = false;
    }
  }

  /** Poll the trusted config file: survives atomic saves and exhausted OS watcher limits. */
  #watchConfig(): void {
    watchFile(this.#configFile, { persistent: false, interval: 250 }, this.#onConfigChange);
  }

  /**
   * Re-read config on the fly. Fields that only steer *new* sessions or a timer
   * are hot-applied; a change to the provider set / base branch / dirs / buffer
   * size / mcp list needs a restart, so the operator gets a nudge instead.
   */
  #reloadConfig(): void {
    if (this.#stopping) return;
    let next: LoomConfig;
    try {
      next = loadConfig(this.repoRoot, this.#configFile);
    } catch (err) {
      this.#log.warn("config reload failed — keeping the running config", { err: String(err) });
      this.#emitNotice(`config reload failed — kept the running one: ${String(err)}`, "warn");
      return;
    }
    // Deep copy, not an alias: the hot-apply block below mutates `this.config`
    // in place, and `needsRestart` must diff `next` against the pre-reload state.
    const before = JSON.parse(JSON.stringify(this.config)) as LoomConfig;
    if (JSON.stringify(next) === JSON.stringify(before)) return;

    // Hot-apply: these are read afresh when a session starts, or drive a timer.
    this.config.worktree = next.worktree;
    this.config.autoNix = next.autoNix;
    if (this.config.isolation.environment) this.config.isolation.environment.autoNix = next.autoNix;
    this.config.autoRebase = next.autoRebase;
    this.config.commitReminder = next.commitReminder;
    this.config.notify = next.notify;
    this.config.titles = next.titles;
    // Hooks are re-read per fire, so a new command takes effect on the next
    // event — no restart, and no need to touch a running session.
    if (JSON.stringify(next.hooks) !== JSON.stringify(before.hooks)) {
      this.config.hooks = next.hooks;
      this.#hooks.setHooks(next.hooks);
    }
    if (next.daemon.idleShutdownMinutes !== before.daemon.idleShutdownMinutes) {
      this.config.daemon = {
        ...this.config.daemon,
        idleShutdownMinutes: next.daemon.idleShutdownMinutes,
      };
      this.#idle.setMinutes(next.daemon.idleShutdownMinutes);
      this.#idle.poke(this.#isBusy());
    }

    for (const warning of lintConfig(this.config)) this.#log.warn("config", { warning });
    for (const warning of this.#orphanedProviderWarnings()) this.#log.warn("config", { warning });

    const needsRestart =
      JSON.stringify(next.providers) !== JSON.stringify(before.providers) ||
      JSON.stringify(next.claudeProfiles) !== JSON.stringify(before.claudeProfiles) ||
      JSON.stringify(next.providerAccess) !== JSON.stringify(before.providerAccess) ||
      JSON.stringify(next.isolation) !== JSON.stringify(this.config.isolation) ||
      next.baseBranch !== before.baseBranch ||
      next.worktreeDir !== before.worktreeDir ||
      next.db !== before.db ||
      JSON.stringify(next.mcp) !== JSON.stringify(before.mcp) ||
      JSON.stringify(next.httpMcp) !== JSON.stringify(before.httpMcp);

    this.#log.info("config reloaded", { needsRestart });
    this.#emitNotice(
      needsRestart
        ? "config changed — press R to restart the daemon and apply provider / mcp changes"
        : "config reloaded",
      needsRestart ? "warn" : "info",
    );
  }

  // -------------------------------------------------------------------------
  // RPC handlers
  // -------------------------------------------------------------------------

  #registerHandlers(): void {
    const d = this.#dispatcher;

    d.register("hello", (params, ctx) => this.#hHello(params, ctx));
    d.register("tui.focus", (params, ctx) => {
      ctx.conn.tuiFocused = params.focused;
      return { ok: true };
    });

    d.register("ping", (params) => {
      const nonce = params.nonce;
      return {
        nonce: nonce ?? null,
        pid: Deno.pid,
        startedAt: this.startedAt,
        uptimeMs: Date.now() - this.startedAt,
      };
    });

    d.register("daemon.status", () => ({
      pid: Deno.pid,
      epoch: this.epoch,
      version: LOOM_VERSION,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      repoRoot: this.repoRoot,
      sessions: this.#registry.list().length,
      runningSessions: this.#sessions.count,
      providers: this.#providers.live().map((p) => p.id),
      loomTools: ["ask_user", "commit"],
      mcpMounts: [...this.config.mcp, ...this.config.httpMcp].map((m) => m.name),
      clients: this.#server.clientCount,
      connections: this.#server.connectionCount,
      eventSeq: this.#eventSeq,
      hygiene: this.#hygiene,
    }));

    d.register("daemon.shutdown", () => {
      setImmediate(() => void this.stop("rpc"));
      return { ok: true };
    });

    d.register("pricing.reload", async () => {
      await this.#refreshEndpointPricing(true);
      return {
        models: [
          ...new Set(
            Object.keys(this.config.providers.aisdk).flatMap((id) => [
              ...this.#pricing.table(this.#pricingScope(id)).keys(),
            ]),
          ),
        ],
        reloaded: true,
      };
    });

    d.register("providers.list", () => this.#providerList());

    d.register("providers.probeModels", async (params) => {
      const id = params.id;
      if (isClaudeId(id)) {
        try {
          const provider = await this.#providers.get(
            this.#providers.has(id) ? id : this.#claudeCatalogId,
          );
          const discovered = await provider.listModels?.();
          const models = discovered
            ? discovered.map((m) => m.id)
            : this.config.providers.claude.models;
          return { models };
        } catch (err) {
          throw new RpcError(
            "provider_error",
            `could not list models: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const profile = this.config.providers.aisdk[id];
      if (!profile) throw new RpcError("not_found", `no aisdk provider: ${id}`);
      if (profile.sdk === "chatgpt") {
        try {
          return {
            models: ((await (await this.#providers.get(id)).listModels?.()) ?? []).map((m) => m.id),
          };
        } catch (err) {
          throw new RpcError(
            "provider_error",
            `could not list models: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Only OpenAI-compatible endpoints have a uniform `/models`; other
      // native SDKs just hand back their configured list.
      if (profile.sdk !== "openai") return { models: profile.models };
      try {
        const probed = await probeOpenAiModels(profile.baseUrl, resolveApiKey(profile));
        this.#pricing.record(this.#pricingScope(id), probed);
        return { models: probed.map((m) => m.id) };
      } catch (err) {
        throw new RpcError(
          "provider_error",
          `could not list models: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    d.register("config.check", () => ({
      warnings: [...lintConfig(this.config), ...this.#orphanedProviderWarnings()],
    }));

    d.register("daemon.relinkProvider", (params) => {
      const from = params.from;
      const to = params.to;
      if (!this.#providers.has(to)) throw new RpcError("bad_request", `unknown provider: ${to}`);
      const relinked = this.#registry.relinkProvider(from, to);
      return { relinked };
    });

    d.register("daemon.doctor", () => this.#doctorReport());

    d.register("session.list", () => this.#enrichAll(this.#registry.listSorted()));

    d.register("session.openShell", (params, { conn }) =>
      this.#queue.run(params.id, async () => {
        const session = this.#registry.get(params.id);
        if (!session) throw new RpcError("not_found", `no such session: ${params.id}`);
        if (this.#revivals.has(params.id)) throw new RpcError("busy", "The session is starting.");
        return await this.#shells.open(this.repoRoot, session, conn, (cwd) =>
          this.#providers.shellEnvironment(session.id, cwd, conn.signal),
        );
      }),
    );
    d.register("session.closeShell", (params, { conn }) => {
      this.#shells.close(params.token, conn);
      this.#publishState("all");
      return {};
    });

    d.register("session.get", (params) => {
      const id = params.id;
      const s = this.#registry.get(id);
      if (!s) throw new RpcError("not_found", `no such session: ${id}`);
      return this.#enrich(s);
    });

    d.register("session.history", (params) => {
      const id = params.id;
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      return this.#registry.store.statusHistory(id);
    });

    // Token spend broken out by the provider+model that made it — the view
    // that answers "is this model caching, and for how long". Optional `id`
    // narrows it to one session's breakdown.
    d.register("stats.models", (params) => {
      const p = params;
      const id = p.id || undefined;
      if (id && !this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      return { models: this.#registry.store.modelUsage(id) };
    });

    // Durable transcript history supports recall, reconnect and scrollback.
    d.register("session.messages", (params) => {
      const id = params.id;
      this.#registry.mustGet(id);
      return this.#sessionEvents.messages(id);
    });

    d.register("session.events", (params) => {
      const id = params.id;
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      const p = params;
      const limit = p.limit;
      const olderThan = p.cursor?.olderThan;
      return this.#sessionEvents.page(id, {
        limit,
        ...(olderThan === undefined ? {} : { olderThan }),
      });
    });

    /**
     * Cross-session search over durable transcript text. Read-only, and
     * deliberately pull-only: it answers the query it was asked, once. There
     * is no live ranked view maintained per client — a client that wants
     * fresher results asks again.
     */
    d.register("session.search", async (params) => {
      const query = params.query;
      return {
        query,
        ids: (await this.#search.rank(this.#registry.listSorted(), query)).map((hit) => hit.id),
      } satisfies SearchResult;
    });

    // --- session control (Claude adapter, milestone 2) --------------------

    d.register("session.create", async (params) => {
      const p = params;
      const prompt = p.prompt;

      const providerId = p.provider ?? this.#defaultProviderId();
      const mode = p.mode ?? this.#defaultMode();
      const aisdkProfile = this.config.providers.aisdk[providerId];
      const explicitModel = p.model ?? null;
      // Tell the operator once when the model we'd have reused has dropped out of
      // the endpoint's list since it last ran (item: "handle when the default is
      // no longer there").
      if (!explicitModel && aisdkProfile) {
        const remembered = this.#providerDefaults.model(providerId);
        if (
          remembered &&
          aisdkProfile.models.length > 0 &&
          !aisdkProfile.models.includes(remembered)
        ) {
          this.#emitNotice(
            `${providerId}: last model "${remembered}" is no longer offered — using ${
              this.#defaultModelFor(providerId) || "the provider default"
            }`,
            "warn",
          );
        }
      }
      const model = explicitModel ?? (this.#defaultModelFor(providerId) || null);
      const explicitEffort = p.effort ?? null;
      const effort =
        explicitEffort ?? (this.#defaultEffortFor(providerId, model ?? undefined) || null);
      const parentId = p.parentId ?? null;
      if (parentId && !this.#registry.get(parentId)) {
        throw new RpcError("not_found", `no such parent session: ${parentId}`);
      }

      // By default each session gets its own worktree + branch off the
      // configured base. `[worktree] enabled = false` (or a per-session
      // `worktree: false`) runs it in the repo working dir instead — no branch
      // isolation, concurrent sessions can collide, hard-fork unavailable.
      const wantWorktree = p.worktree ?? this.config.worktree.enabled;

      return this.#startSession({
        prompt,
        providerId,
        model,
        effort,
        mode,
        parentId,
        wantWorktree,
        ...(p.isolation ? { isolation: p.isolation } : {}),
        by: params.by,
      });
    });

    d.register("session.resume", async (params) => {
      const id = params.id;
      if (this.#sessions.has(id)) throw new RpcError("conflict", "session is already running");
      const snap = await this.#reviveSession(id);
      this.#publishState(snap.id);
      this.#onActivityChange("session-resumed");
      return snap;
    });

    d.register("session.send", async (params) => {
      const id = params.id;
      const text = params.text;
      this.#registry.mustGet(id);
      try {
        while (this.#revivals.has(id)) await this.#revivals.get(id);
        // A cold session (daemon restarted, or a turn that ended) is brought back
        // transparently — `send` is the one verb for "talk to this session", it
        // doesn't need a separate resume step.
        if (!this.#sessions.has(id)) {
          const revived = await this.#reviveSession(id);
          // An archived session's revive restores a worktree and flips it off
          // `done` — push that before the turn's own updates so clients don't
          // briefly show a running session with no tree.
          this.#publishState(revived.id);
          this.#onActivityChange("session-resumed");
        }
        // A `compact` / `rewind` holds the session's op gate — a straight send
        // would park behind it (a compaction can run for minutes). Fast-fail with
        // a distinct `code` the TUI recognises and re-routes to its own outgoing
        // queue (which drains when the compaction boundary lands).
        while (this.#revivals.has(id)) await this.#revivals.get(id);
        const restructuring = this.#sessions.isRestructuring(id);
        if (this.#sessions.isStopping(id))
          throw new RpcError("busy", "session is stopping — the message was not sent");
        if (restructuring) {
          const doing = restructuring === "provider" ? "switching provider" : `${restructuring}ing`;
          throw new RpcError(
            "busy",
            `session is ${doing} — the message was not sent, retry in a moment`,
          );
        }
        const { injected } = await this.#sessions.send(id, text);
        // Always emit the message so every client renders it from one source
        // (clients don't local-echo sends). `injected: true` = it landed in a
        // live turn (aisdk splices after the current tool result; Claude queues
        // for the next boundary); false = it started a fresh turn.
        this.emitEvent({ type: "user_message", sessionId: id, ts: Date.now(), text, injected });
        // Only the text that *starts* a turn is the checkpoint / auto-title seed.
        if (!injected) this.#lastSend.set(id, text);
        return { ...this.#registry.mustGet(id), injected };
      } catch (error) {
        // Busy sends are queued by the client and have not been accepted yet.
        if (error instanceof RpcError && error.code === "busy") throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.emitEvent({
          type: "user_message",
          sessionId: id,
          ts: Date.now(),
          text,
          injected: false,
        });
        this.emitEvent({ type: "error", sessionId: id, ts: Date.now(), message, fatal: false });
        this.#publishState(id);
        throw new RpcError(error instanceof RpcError ? error.code : "provider_error", message, {
          sessionId: id,
        });
      }
    });

    d.register("session.checkpoints", (params) => {
      const id = params.id;
      const snap = this.#registry.get(id);
      if (!snap) throw new RpcError("not_found", `no such session: ${id}`);
      const model = snap.model;
      return this.#checkpoints.list(id).map((cp) => ({
        turn: cp.turn,
        userText: cp.userText,
        createdAt: cp.createdAt,
        rewindCostUsd: this.#ownsTranscript(snap.provider, snap.isolation)
          ? this.#rewindCostUsd(model, Number(cp.forkPoint) || 0, id)
          : 0,
      }));
    });

    d.register("session.rewind", async (params) => {
      const id = params.id;
      const toTurn = params.toTurn;
      const snap = this.#registry.get(id);
      if (!snap) throw new RpcError("not_found", `no such session: ${id}`);
      const provider = await this.#providers.get(snap.provider, snap.isolation).catch(() => null);
      if (!provider?.capabilities.rewind) {
        throw new RpcError("bad_request", "this session's provider can't undo a turn");
      }
      if (snap.turns < 1) {
        throw new RpcError("bad_request", "this session has no turn to undo");
      }
      // `toTurn` is how many turns to keep: 0 wipes the transcript (redo the
      // first message from scratch), `turns - 1` drops just the last turn.
      if (toTurn >= snap.turns) {
        throw new RpcError("bad_request", `toTurn must be 0..${snap.turns - 1}`);
      }
      if (!["idle", "interrupted", "error"].includes(snap.status.kind)) {
        // rewind() awaits the in-flight #turn, which for a running / parked
        // session never settles until it's interrupted → the RPC would hang.
        throw new RpcError("bad_request", "interrupt the session before rewinding it");
      }

      // A transcript-owning provider (aisdk) can truncate its own array (or
      // wipe it, for toTurn 0) while cold. A harness-driven adapter (Claude)
      // rewinds by forking + resuming its live query, so it needs the session
      // loaded and can't fork "to empty".
      const ownsTranscript = provider.capabilities.ownsTranscript;
      if (!ownsTranscript) {
        if (toTurn === 0) {
          throw new RpcError(
            "bad_request",
            "can't undo the first turn of this session — start a new one instead",
          );
        }
        if (!this.#sessions.has(id)) {
          throw new RpcError(
            "bad_request",
            "send this session a message before undoing it — it isn't loaded",
          );
        }
      }

      // The fork point: a message count for aisdk, a chain-entry ref for Claude.
      let keep = 0;
      let at: string | undefined;
      let checkpointSha = "";
      if (toTurn > 0) {
        const cp = this.#checkpoints.at(id, toTurn);
        if (!cp) throw new RpcError("not_found", `no checkpoint at turn ${toTurn}`);
        checkpointSha = cp.headSha;
        if (ownsTranscript) {
          keep = Number(cp.forkPoint) || 0;
        } else {
          at = cp.forkPoint || undefined;
          if (!at) throw new RpcError("bad_request", `turn ${toTurn} has no fork point recorded`);
        }
      }

      // Undo only moves the model's context. Unless the caller opts in, the
      // working tree is left exactly where it is — which may be many commits /
      // edits *ahead* of the turn we just rewound to. Figure out the drift now
      // (before `restoreWorktree` potentially erases it).
      const restoreWorktree = params.restoreWorktree === true;
      const wt = snap.worktree;
      let worktreeDrift: {
        checkpointSha: string;
        currentSha: string;
        dirty: boolean;
        laterCommits: string[];
        restored: boolean;
      } | null = null;
      if (wt && checkpointSha) {
        const currentSha = this.#worktrees.headSha(wt) ?? "";
        const dirty = this.#worktrees.isDirty(wt);
        if (currentSha !== checkpointSha || dirty) {
          worktreeDrift = {
            checkpointSha,
            currentSha,
            dirty,
            laterCommits: this.#worktrees.commitsBetween(wt, checkpointSha, currentSha),
            restored: false,
          };
        }
      }
      if (restoreWorktree) {
        if (!wt) {
          throw new RpcError("bad_request", "this session has no worktree to restore");
        }
        if (!checkpointSha) {
          throw new RpcError(
            "bad_request",
            "no git HEAD was recorded for that turn — can't restore the worktree",
          );
        }
        if (this.#worktrees.isDirty(wt)) {
          throw new RpcError(
            "bad_request",
            "the worktree has uncommitted changes — commit or discard them, then retry with restoreWorktree",
          );
        }
      }

      // Restore the worktree first (when opted in) — a `git reset --hard`
      // failure then aborts the whole undo with nothing touched. The tree was
      // already checked clean above.
      if (restoreWorktree && wt && checkpointSha) {
        const r = this.#worktrees.restoreTo(wt, checkpointSha);
        if (!r.ok)
          throw new RpcError("worktree_error", `could not restore the worktree: ${r.error}`);
        if (worktreeDrift) worktreeDrift.restored = true;
      }

      // Do the rewind, *then* truncate the bookkeeping — a rewind that throws
      // (a refused resume, say) must not leave the row claiming fewer turns
      // than the transcript actually has.
      if (this.#sessions.has(id)) {
        this.#hooks.forget(id);
        await this.#sessions.rewind(id, keep, at);
      } else {
        this.#pmsgs.replaceFrom(id, keep, []);
      }
      this.#checkpoints.truncate(id, toTurn);
      this.#registry.setTurns(id, toTurn);

      if (worktreeDrift?.restored) {
        this.#emitNotice(
          `undo: worktree reset to ${checkpointSha.slice(0, 8)} (turn ${toTurn})`,
          "info",
        );
      } else if (worktreeDrift) {
        const n = worktreeDrift.laterCommits.length;
        this.#emitNotice(
          `undo moved the model's context to turn ${toTurn}, but the worktree is still at ` +
            `${(worktreeDrift.currentSha || "?").slice(0, 8)}` +
            (n > 0 ? ` — ${n} later commit(s) now post-date it` : "") +
            (worktreeDrift.dirty ? " (and it has uncommitted changes)" : "") +
            ". Re-run undo with restoreWorktree to git reset --hard.",
          "warn",
        );
      }

      this.emitEvent({ type: "rewind", sessionId: id, ts: Date.now(), toTurn });

      // SessionManager.rewind already published a snapshot from its idle
      // transition, but with the pre-truncation turn count — publish again with
      // the corrected one. The cold path drives the status itself.
      const updated = this.#sessions.has(id)
        ? this.#registry.mustGet(id)
        : this.#registry.setStatus(id, stateIdle, "rewind");
      this.#publishState(updated.id);
      return { ...updated, ...(worktreeDrift ? { worktreeDrift } : {}) };
    });

    d.register("session.fork", async (params) => {
      const id = params.id;
      const parent = this.#registry.get(id);
      if (!parent) throw new RpcError("not_found", `no such session: ${id}`);
      // Resolve the provider's real capabilities rather than guess from
      // config membership — an unloaded ChatGPT provider is configured under
      // `providers.aisdk` (sdk = "chatgpt") but its real `ownsTranscript` is
      // conservatively `false` (it may route through Codex's own thread),
      // so a config-membership guess would wrongly authorize a hard fork.
      const p = params;
      const fallback = this.#providers.has(parent.provider)
        ? parent.provider
        : this.#defaultProviderId();
      const providerId = p.provider ?? fallback;
      const isolation =
        p.isolation ?? parent.isolation ?? this.#providers.defaultIsolation(providerId);
      await this.#preflightTools(providerId, isolation);
      const parentProvider = await this.#providers.get(providerId, isolation);
      // Changing environment carries portable context, never native history.
      // VM transcript stores are not the host transcript store either.
      const continuation =
        isolation !== (parent.isolation ?? "local") ||
        isolation === "vm" ||
        !parentProvider.capabilities.ownsTranscript ||
        providerId !== parent.provider ||
        !!this.#resumeBlockedReason(parent);
      const model =
        providerId === parent.provider ? parent.model : this.#defaultModelFor(providerId);
      const effort =
        providerId === parent.provider ? parent.effort : this.#defaultEffortFor(providerId);
      if (parent.inPlace && !continuation) {
        throw new RpcError(
          "bad_request",
          "the parent runs in-place (no worktree) — hard fork needs an isolated branch",
        );
      }
      if (!["idle", "interrupted", "done", "error"].includes(parent.status.kind)) {
        // Forking mid-turn copies a transcript whose last message is an
        // assistant tool-call with no tool_result yet — the fork's first
        // request would 400 on most endpoints.
        throw new RpcError("bad_request", "the parent is mid-turn — interrupt it before forking");
      }
      const forkPrompt = p.prompt?.trim() ?? "";

      const context = continuation
        ? forkContext(id, this.#sessionEvents.page(id, { limit: 5000 }))
        : "";
      const source = parent.inPlace ? this.repoRoot : parent.worktree;
      if (source && !this.#worktrees.headSha(source))
        throw new RpcError("worktree_error", "The parent worktree is missing or has no HEAD");
      const baseRef = source ? this.#worktrees.headSha(source)! : parent.branch;
      const newId = randomUUID();
      let wt;
      try {
        wt = this.#worktrees.create(newId, {
          ...(baseRef ? { baseRef } : {}),
          model: model || providerId,
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new RpcError("worktree_error", `could not create the fork's worktree: ${m}`);
      }

      // Everything past the worktree is torn down together on any failure so a
      // failed fork doesn't leave an orphan worktree / branch / row / rows.
      try {
        // The fork runs in the parent's permission mode; record it on the row
        // so the chip and a restart's revive (which reads the row) agree with
        // the adapter — an omitted mode stored `default` while the adapter
        // actually resumed in the parent's mode.
        const mode: SessionMode = isSessionMode(parent.mode) ? parent.mode : "default";
        if (source) this.#worktrees.copyChanges(source, wt.path);
        this.#registry.create({
          id: newId,
          provider: providerId,
          model,
          effort,
          mode,
          parentId: id,
          title: `${(parent.title ?? "session").slice(0, 180)} (fork)`,
          worktree: wt.path,
          branch: wt.branch,
          baseBranch: wt.baseRef,
          isolation,
        });
        this.#registry.setFields(newId, {
          forkTurn: parent.turns,
          ...(!continuation ? { providerRef: newId } : {}),
        });
        if (!continuation) this.#pmsgs.copyTo(id, newId);
        this.#publishState(newId);

        const mcpHandles = this.#mcpHandles();
        if (continuation) {
          const prompt = context + (forkPrompt ? `\n\nNew user instruction: ${forkPrompt}` : "");
          this.#lastSend.set(newId, prompt);
          await this.#sessions.create(parentProvider, {
            sessionId: newId,
            cwd: wt.path,
            prompt,
            mode,
            parentId: id,
            mcpServers: mcpHandles,
            loomServer: true,
            disableTools: this.config.providers.claude.disableBuiltin,
            settingSources: this.config.providers.claude.settingSources,
            systemPromptAppend: systemPromptAppendFor(
              !!this.config.providers.aisdk[providerId],
              mcpHandles.length > 0,
              wt.path,
              this.repoRoot,
            ),
            repoInstructions: repoInstructionsFor(wt.path, this.repoRoot),
            workspaceRoot: wt.path,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          });
          this.emitEvent({
            type: "user_message",
            sessionId: newId,
            ts: Date.now(),
            text: prompt,
            injected: false,
          });
        } else
          await this.#sessions.resume(parentProvider, {
            initHooks: { hooks: [], env: {} }, // A new conversation despite copying its transcript.
            sessionId: newId,
            providerRef: newId,
            cwd: wt.path,
            mode,
            mcpServers: mcpHandles,
            systemPromptAppend: systemPromptAppendFor(
              true,
              mcpHandles.length > 0,
              wt.path,
              this.repoRoot,
            ),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          });
      } catch (err) {
        await this.#sessions.close(newId).catch(() => {});
        let removed = false;
        try {
          await withStoppedSessionVm(this.repoRoot, newId, () =>
            this.#worktrees.remove(wt.path, { force: true }),
          );
          removed = true;
        } catch (rmErr) {
          this.#log.warn("fork cleanup: could not remove the worktree", {
            id: newId,
            path: wt.path,
            err: rmErr instanceof Error ? rmErr.message : String(rmErr),
          });
        }
        if (removed) {
          this.#registry.store.delete(newId); // cascades provider_messages / checkpoints
        } else {
          // The tree is still on disk — keep the row (worktree path intact) and
          // mark it error so a later `session.gc { id }` can still reclaim it,
          // rather than deleting the row and orphaning the directory.
          if (!this.#registry.get(newId))
            this.#registry.create({
              id: newId,
              provider: providerId,
              parentId: id,
              worktree: wt.path,
              branch: wt.branch,
            });
          this.#registry.setStatus(newId, stateError("fork start failed"));
        }
        this.#publishState();
        this.#lastSend.delete(newId);
        const m = err instanceof Error ? err.message : String(err);
        throw new RpcError("provider_error", `could not start the fork: ${m}`);
      }

      if (!continuation) this.#registry.setStatus(newId, stateIdle, "forked");
      if (forkPrompt && !continuation) {
        this.#lastSend.set(newId, forkPrompt);
        await this.#sessions.send(newId, forkPrompt);
      }
      const snap = this.#registry.mustGet(newId);
      this.#publishState(snap.id);
      this.#onActivityChange("session-forked");
      return snap;
    });

    d.register("session.interrupt", async (params) => {
      const id = params.id;
      const startup = this.#startups.get(id);
      if (startup && !this.#sessions.has(id)) {
        startup.abort();
        this.#hooks.forget(id);
        this.#registry.setStatus(id, stateInterrupted("user"));
        this.#publishState(id);
        return this.#registry.mustGet(id);
      }
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      this.#hooks.forget(id);
      await this.#sessions.interrupt(id);
      return this.#registry.mustGet(id);
    });

    d.register("session.compact", async (params) => {
      const id = params.id;
      const p = params;
      const instructions = p.instructions?.trim() || undefined;
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      if (instructions) {
        const row = this.#registry.get(id);
        const caps = row && this.#providers.capsOf(row.provider, row.isolation);
        // A provider that hasn't reported real capabilities yet can't be
        // running a session already (creation always resolves the provider
        // first), so `caps` is only absent here for an unknown row.
        if (caps && !caps.compactionInstructions) {
          throw new RpcError(
            "bad_request",
            `${row?.provider} does not support custom compaction instructions — retry without them`,
          );
        }
      }
      await this.#sessions.compact(id, instructions);
      return this.#registry.mustGet(id);
    });

    // Manual counterpart to `[auto_rebase]`: replay (or merge) this session's
    // branch onto its base now, on operator command, regardless of whether the
    // auto path is enabled. No running provider needed — it's pure git — and no
    // agent nudge on a dirty / conflicted tree: the caller gets the outcome.
    d.register("session.rebase", async (params) => {
      const id = params.id;
      const snap = this.#registry.get(id);
      if (!snap) throw new RpcError("not_found", `no such session: ${id}`);
      if (!snap.worktree)
        throw new RpcError("bad_request", "session runs in place — no branch to rebase");
      return this.#syncOntoBase(id, false).outcome ?? { outcome: "no-base" as const };
    });

    d.register("session.setKeepWarm", async (params) => {
      const id = params.id;
      const p = params;
      const on = p["on"] === true;
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      const snap = this.#enrich(this.#registry.mustGet(id), false);
      // Gate on the TTL the countdown will actually run on — the measured one,
      // or the config pin standing in for it — not on the provider or on the
      // pin alone. `prompt_cache_ttl` defaults to unset now that the TTL is
      // measured, so a provider+pin test rejects every session; and an aisdk
      // Anthropic session has a real measured TTL to race, same as Claude.
      if (on && snap.cache.ttlMinutes <= 0) {
        throw new RpcError(
          "bad_request",
          "keep-warm needs a known prompt-cache TTL — take a turn on a caching " +
            "provider first, or pin one with prompt_cache_ttl",
        );
      }
      this.#sessions.setKeepWarm(id, on);
      this.#publishState(id);
      return this.#enrich(this.#registry.mustGet(id));
    });

    d.register("session.respondPermission", async (params) => {
      const id = params.id;
      const requestId = params.requestId;
      const p = params;
      const decision = permissionDecisionSchema.parse({ ...p, behavior: p.decision });
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      return this.#sessions.respondToPermission(id, requestId, decision);
    });

    // Resolve an outstanding `plan_review` (milestone 8).
    d.register("session.respondPlan", async (params) => {
      const id = params.id;
      const requestId = params.requestId;
      const p = params;
      const action = p.action;
      const mode = p.mode;

      const parent = this.#registry.get(id);
      if (!parent) throw new RpcError("not_found", `no such session: ${id}`);
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);

      // `implement_fresh` may retarget the model / effort / provider the
      // implementation runs under (the plan review's `⌥p`).
      const retargetModel = p.model ?? undefined;
      const retargetEffort = p.effort ?? undefined;
      const retargetProvider = p.provider ?? undefined;
      if (
        retargetEffort !== undefined &&
        !EFFORT_LEVELS.includes(retargetEffort) &&
        !this.#advertisedEfforts(
          retargetProvider ?? parent.provider,
          retargetModel ?? parent.model,
        ).includes(retargetEffort)
      ) {
        throw new RpcError("bad_request", "effort must be a level this model supports");
      }

      // A different provider can't switch live — fork a fresh session on it,
      // seeded with the approved plan + the original goal, and end the planning
      // session's review as a handoff (its turn ends, it goes idle).
      if (
        action === "implement_fresh" &&
        retargetProvider !== undefined &&
        retargetProvider !== parent.provider
      ) {
        if (!this.#providers.has(retargetProvider)) {
          throw new RpcError("bad_request", `unknown provider: ${retargetProvider}`);
        }
        const planText = p.plan?.trim() ?? "";
        if (planText === "") {
          throw new RpcError("bad_request", "a provider fork needs the approved plan text");
        }
        const goal = parent.title ?? "the original goal";
        const seed = `Implement this approved plan.\n\nOriginal goal: ${goal}\n\n${planText}`;
        const runMode: SessionMode =
          mode ??
          (isSessionMode(parent.mode) && parent.mode !== "plan" ? parent.mode : "acceptEdits");
        const snap = await this.#startSession({
          prompt: seed,
          providerId: retargetProvider,
          model: retargetModel ?? (this.#defaultModelFor(retargetProvider) || null),
          effort: retargetEffort ?? (this.#defaultEffortFor(retargetProvider) || null),
          mode: runMode,
          parentId: id,
          wantWorktree: this.config.worktree.enabled,
          ...(parent.isolation ? { isolation: parent.isolation } : {}),
          by: params.by,
        });
        await this.#sessions.respondToPlan(id, requestId, { action: "handoff" });
        this.#onActivityChange("session-forked");
        return snap;
      }

      const decision = planDecisionSchema.parse(p);
      return this.#sessions.respondToPlan(id, requestId, decision);
    });

    // Answer an outstanding `ask_user` question (loom MCP server, milestone 4).
    d.register("session.answer", async (params) => {
      const id = params.id;
      const requestId = params.requestId;
      const text = params.text;
      if (!this.#sessions.has(id)) throw new RpcError("not_found", `session not running: ${id}`);
      return this.#sessions.answerQuestion(id, requestId, text);
    });

    d.register("session.setMode", async (params) => {
      const id = params.id;
      const mode = params.mode;
      // The target is the client's, computed against what it displays — never
      // re-derived here as "the next mode after the current one", which would
      // resolve differently depending on where in the queue this lands.
      return this.#queue.run(id, async () => {
        // Rechecked *inside* the queue: the session may have been removed, or a
        // plan review raised, while this command waited its turn.
        if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
        if (this.#sessions.has(id)) {
          const r = await this.#sessions.setMode(id, mode);
          // Rejected: leave the registry and the defaults alone. Publishing the
          // requested mode here would advertise a value the adapter refused.
          if (!r.ok) {
            throw new RpcError(
              "plan_pending",
              "a plan review is pending — resolve it in the plan review before changing mode",
            );
          }
        }
        const snap = this.#registry.setFields(id, { mode });
        // A deliberate switch is also "the last mode used" for the next new session.
        this.#providerDefaults.rememberMode(mode);
        this.#publishState(snap.id);
        return this.#enrich(snap, false);
      });
    });

    d.register("session.setModel", async (params) => {
      const id = params.id;
      const model = params.model;
      return this.#queue.run(id, async () => {
        // Reread inside the queue — a command ahead of this one may have moved
        // the provider (and with it which defaults store to write).
        const row = this.#registry.get(id);
        if (!row) throw new RpcError("not_found", `no such session: ${id}`);
        if (this.#sessions.has(id)) await this.#sessions.setModel(id, model);
        const snap = this.#registry.setFields(id, { model });
        // Later commits carry the model that runs them — re-point the worktree
        // identity after a deliberate switch.
        if (row.worktree) this.#worktrees.setIdentity(row.worktree, model);
        // A deliberate switch is also "the last model used" for this provider.
        if (isClaudeId(row.provider) || this.config.providers.aisdk[row.provider]) {
          this.#providerDefaults.remember(row.provider, model);
        }
        this.#publishState(snap.id);
        return snap;
      });
    });

    d.register("session.setEffort", async (params) => {
      const id = params.id;
      const effort = params.effort;
      return this.#queue.run(id, async () => {
        const row = this.#registry.get(id);
        if (!row) throw new RpcError("not_found", `no such session: ${id}`);
        if (this.#sessions.has(id)) await this.#sessions.setEffort(id, effort);
        const snap = this.#registry.setFields(id, { effort });
        // A deliberate switch is also "the last effort used" for this provider.
        if (isClaudeId(row.provider) || this.config.providers.aisdk[row.provider]) {
          this.#providerDefaults.rememberEffort(row.provider, effort);
        }
        this.#publishState(snap.id);
        return snap;
      });
    });

    // Switch a live session onto a different provider (the mid-chat `⌥p`).
    // Same provider → a plain model / effort change (so the TUI can always call
    // this and never branch). Different provider → tear the adapter down and
    // rebuild on the new one, keeping the session id / transcript / worktree.
    // Phase 1: cross-provider is aisdk↔aisdk only — those share a
    // provider-agnostic transcript store, so the new adapter resumes with full
    // history. A switch touching Claude needs history reconstruction (Phase 2).
    d.register("session.setProvider", async (params) => {
      const id = params.id;
      const provider = params.provider;
      const p = params;
      const wantModel = p.model ?? undefined;
      const wantEffort = p.effort ?? undefined;
      // Rechecked inside the queue, and held for the whole swap: a mode /
      // model / effort change arriving mid-swap applies to the new adapter
      // rather than to one that is being torn down.
      return this.#queue.run(id, async () => {
        this.#shells.assertClosed(id);
        const row = this.#registry.get(id);
        if (!row) throw new RpcError("not_found", `no such session: ${id}`);
        if (!this.#providers.has(provider)) {
          throw new RpcError("bad_request", `unknown provider: ${provider}`);
        }
        // A compact / rewind already holds the op gate, and the swap below
        // would park on it — while holding this session's command queue, so
        // every other command for it would park behind a restructure that can
        // run for minutes. Fast-fail instead, the way `session.send` does.
        const busy = this.#sessions.isRestructuring(id);
        if (busy) {
          const doing = busy === "provider" ? "switching provider" : `${busy}ing`;
          throw new RpcError("busy", `session is ${doing} — retry in a moment`);
        }

        const model = wantModel ?? (this.#defaultModelFor(provider) || null);
        if (
          wantEffort !== undefined &&
          !EFFORT_LEVELS.includes(wantEffort) &&
          !this.#advertisedEfforts(provider, model ?? undefined).includes(wantEffort)
        ) {
          throw new RpcError("bad_request", "effort must be a level this model supports");
        }
        const effort = wantEffort ?? (this.#defaultEffortFor(provider, model ?? undefined) || null);

        // Same provider: this is a model / effort change, nothing more.
        if (provider === row.provider) {
          if (this.#sessions.has(id)) {
            if (model) await this.#sessions.setModel(id, model);
            if (effort) await this.#sessions.setEffort(id, effort);
          }
          const snap = this.#registry.setFields(id, {
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          });
          if (row.worktree && model) this.#worktrees.setIdentity(row.worktree, model);
          if (isClaudeId(row.provider) || this.config.providers.aisdk[row.provider]) {
            if (model) this.#providerDefaults.remember(row.provider, model);
            if (effort) this.#providerDefaults.rememberEffort(row.provider, effort);
          }
          this.#publishState(snap.id);
          return snap;
        }

        // Resolve real capabilities for both providers rather than guess from
        // config membership — an unloaded ChatGPT provider is configured under
        // `providers.aisdk` (sdk = "chatgpt") but its real `ownsTranscript` is
        // conservatively `false`, so a config-membership guess would wrongly
        // authorize a transcript-based switch into (or out of) it.
        const [fromProvider, toProvider] = await Promise.all([
          this.#providers.get(row.provider, row.isolation),
          this.#providers.get(provider, row.isolation),
        ]);
        if (!toProvider.capabilities.ownsTranscript || !fromProvider.capabilities.ownsTranscript) {
          throw new RpcError(
            "bad_request",
            "switching to or from a provider that doesn't own its transcript isn't supported yet — start a fresh session on it instead",
          );
        }
        if (!model) {
          throw new RpcError("bad_request", `no model available for ${provider}`);
        }
        if (!this.#sessions.has(id)) {
          throw new RpcError(
            "bad_request",
            "send the session a message to revive it before switching its provider",
          );
        }

        const cwd = row.worktree ?? this.repoRoot;
        const mcpHandles = this.#mcpHandles();
        const ref: SessionRef = {
          sessionId: id,
          providerRef: this.#registry.store.providerRef(id) ?? id,
          cwd,
          mode: isSessionMode(row.mode) ? row.mode : "default",
          mcpServers: mcpHandles,
          systemPromptAppend: systemPromptAppendFor(
            true,
            mcpHandles.length > 0,
            cwd,
            this.repoRoot,
          ),
          model,
          ...(effort ? { effort } : {}),
        };

        try {
          await this.#sessions.setProvider(id, toProvider, ref);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/interrupt the session/.test(message)) {
            throw new RpcError("bad_request", message);
          }
          throw new RpcError("provider_error", `could not switch provider: ${message}`);
        }

        const snap = this.#registry.setFields(id, { provider, model, effort });
        if (row.worktree) this.#worktrees.setIdentity(row.worktree, model);
        this.#providerDefaults.remember(provider, model);
        if (effort) this.#providerDefaults.rememberEffort(provider, effort);
        this.#providerDefaults.rememberProvider(provider);
        this.emitEvent({
          type: "provider_changed",
          sessionId: id,
          ts: Date.now(),
          from: row.provider,
          provider,
          model,
          effort,
          lossy: false,
        });
        this.#publishState(snap.id);
        this.#onActivityChange("provider-switched");
        return snap;
      });
    });

    d.register("session.setTitle", (params) => {
      const id = params.id;
      const title = params.title;
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      // A manual rename pins the title — the auto-titler won't touch it again.
      const snap = this.#registry.setFields(id, { title, titleLocked: true });
      if (this.config.titles.enabled) this.#maybeNameBranch(id);
      this.#publishState(snap.id);
      return this.#enrich(this.#registry.mustGet(id));
    });

    d.register("session.setComment", (params) => {
      const id = params.id;
      const p = params;
      const comment = p.comment?.trim().slice(0, 2000) || null;
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      const snap = this.#registry.setFields(id, { comment });
      this.#publishState(snap.id);
      return this.#enrich(snap);
    });

    // markDone: archive a session. The run is stopped and its worktree is
    // reclaimed — in git the branch is left looking like any other branch —
    // but the row, the branch, and the stored transcript are kept. Messaging
    // the session again checks the branch back out into a fresh tree and
    // resumes (see `#reviveSession`). A dirty worktree needs `force` to
    // archive, the way `remove` / `gc` already gate discarding live changes.
    d.register("session.markDone", async (params) => {
      const id = params.id;
      const force = params.force === true;
      return this.#queue.run(id, async () => {
        this.#shells.assertClosed(id);
        const row = this.#registry.get(id);
        if (!row) throw new RpcError("not_found", `no such session: ${id}`);
        if (!force && row.worktree && this.#worktrees.isDirty(row.worktree)) {
          throw new RpcError(
            "bad_request",
            "the worktree has uncommitted changes — commit them, or archive with force to discard",
          );
        }
        this.#hooks.forget(id);
        if (this.#sessions.has(id)) await this.#sessions.close(id);
        return await withStoppedSessionVm(this.repoRoot, id, async () => {
          if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
          this.#lastSend.delete(id);
          this.#cacheTtlSeen.delete(id);
          if (row.worktree && !row.inPlace) {
            try {
              await this.#worktrees.removeAsync(row.worktree, { force: true });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              this.#log.warn("session.markDone: worktree removal failed", { id, error: msg });
              throw new RpcError("worktree_error", `could not remove the worktree: ${msg}`);
            }
            this.#registry.setFields(id, { worktree: null });
          }
          const snap = this.#registry.setStatus(id, stateDone, "marked_done");
          this.emitEvent({
            type: "status_changed",
            sessionId: id,
            status: stateDone,
            ts: Date.now(),
            note: "marked_done",
          });
          this.#publishState(snap.id);
          this.#onActivityChange("marked-done");
          return this.#enrich(snap);
        });
      });
    });

    // remove: delete a session row for good — its worktree and its stored
    // transcript / history / checkpoints go with it (child tables cascade).
    // The branch is left alone (like `gc`) unless `deleteBranch` is set. An
    // in-place session shares the repo working dir, so its "worktree" is never
    // removed and it has no branch to delete.
    d.register("session.remove", async (params) => {
      const id = params.id;
      const p = params;
      const alsoBranch = p["deleteBranch"] === true;
      const force = p["force"] === true;
      return this.#queue.run(id, async () => {
        this.#shells.assertClosed(id);
        const s = this.#registry.get(id);
        if (!s) throw new RpcError("not_found", `no such session: ${id}`);
        // Removing a worktree with uncommitted / untracked changes discards that
        // work silently. Make the caller opt in, the way `gc` already threads
        // `force` — the row / transcript deletion is inherently destructive, but
        // live file changes deserve an explicit ack.
        if (!force && s.worktree && this.#worktrees.isDirty(s.worktree)) {
          throw new RpcError(
            "bad_request",
            "the worktree has uncommitted changes — commit them, or pass force to discard",
          );
        }
        this.#hooks.forget(id);
        if (this.#sessions.has(id)) await this.#sessions.close(id);
        return await withStoppedSessionVm(this.repoRoot, id, async () => {
          this.#lastSend.delete(id);
          this.#cacheTtlSeen.delete(id);
          if (s.worktree) {
            try {
              this.#worktrees.remove(s.worktree, { force: true });
            } catch (err) {
              // The tree is still on disk. Dropping the row now would orphan it —
              // `gc` iterates rows, so nothing could ever reclaim it. Keep the row,
              // flip it to `error` so `session.gc {id}` can retry, and surface it.
              const msg = err instanceof Error ? err.message : String(err);
              this.#log.warn("session.remove: worktree removal failed", { id, error: msg });
              const errSnap = this.#registry.setStatus(
                id,
                stateError(`worktree removal failed: ${msg}`.slice(0, 200)),
                "remove_failed",
              );
              this.#publishState(errSnap.id);
              throw new RpcError("worktree_error", `could not remove the worktree: ${msg}`);
            }
          }
          let branchDeleted = false;
          if (alsoBranch && s.branch && !s.inPlace) {
            this.#worktrees.prune(); // release the worktree's hold on the branch first
            branchDeleted = this.#worktrees.deleteBranch(s.branch);
          }
          await removeSessionVmProfile(this.repoRoot, id);
          this.#registry.remove(id);
          this.#hooks.forget(id);
          this.#publishState();
          this.#worktrees.prune();
          this.#onActivityChange("session-removed");
          return { removed: id, branchDeleted };
        });
      });
    });

    // gc: remove worktrees for sessions marked done. `markDone` already reclaims
    // the tree as it archives, so this is now a repair sweep — it mops up a
    // `done` (or explicitly targeted `error`) row whose tree removal failed then.
    // Branches are never auto-deleted; the row is retained as a record (spec §6).
    d.register("session.gc", async (params) => {
      const p = params;
      const only = p.id ?? null;
      const force = p["force"] === true;
      // Bulk sweep: `done` only (an `error` session may still be resumable).
      // An explicit `id` may also target an `error` row — that's how a fork
      // whose worktree-remove failed on the error path gets reclaimed.
      const eligible = (kind: SessionStateKind): boolean =>
        only ? kind === "done" || kind === "error" : kind === "done";
      if (only) {
        const s = this.#registry.get(only);
        if (!s) throw new RpcError("not_found", `no such session: ${only}`);
        if (!eligible(s.status.kind)) {
          throw new RpcError("bad_request", `session ${only} is ${s.status.kind} — nothing to gc`);
        }
      }
      const removed: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      const targets = this.#registry
        .list()
        .filter((s) => eligible(s.status.kind) && s.worktree && (!only || s.id === only));
      for (const t of targets) {
        await this.#queue.run(t.id, async () => {
          // Re-read under the gate: a concurrent `remove` may have deleted it.
          const s = this.#registry.get(t.id);
          if (!s?.worktree || !eligible(s.status.kind)) return;
          try {
            this.#shells.assertClosed(s.id);
            // A `done` session was only interrupted, not closed — its provider
            // process is still registered with this worktree as its cwd. Close
            // it before pulling the directory out from under it.
            if (this.#sessions.has(s.id)) await this.#sessions.close(s.id);
            await withStoppedSessionVm(this.repoRoot, s.id, async () => {
              this.#worktrees.remove(s.worktree!, { force });
              const snap = this.#registry.setFields(s.id, { worktree: null });
              this.#publishState(snap.id);
              removed.push(s.id);
            });
          } catch (err) {
            failed.push({ id: s.id, error: err instanceof Error ? err.message : String(err) });
          }
        });
      }
      this.#worktrees.prune();
      return { removed, failed };
    });

    // --- development / test hooks (no provider adapter yet) -----------------

    d.register("session.createStub", (params) => {
      const p = params;
      const id = randomUUID();
      const prompt = p.prompt ?? null;
      this.#registry.create({
        id,
        provider: p.provider ?? "stub",
        isolation: this.#providers.defaultIsolation(p.provider ?? "stub"),
        model: p.model ?? null,
        mode: p.mode ?? "default",
        parentId: p.parentId ?? null,
        title: prompt,
      });
      const kind = p.status ?? "idle";
      const detail = p.reason ?? null;
      const state = parseSessionState(kind, detail);
      const snap = this.#registry.setStatus(id, state, detail);
      this.emitEvent({
        type: "status_changed",
        sessionId: id,
        status: state,
        ts: Date.now(),
        ...(detail !== null ? { note: detail } : {}),
      });
      this.#publishState(snap.id);
      this.#onActivityChange("stub-created");
      return snap;
    });

    d.register("session.setStatus", (params) => {
      const id = params.id;
      const kind = params.status;
      if (!this.#registry.get(id)) throw new RpcError("not_found", `no such session: ${id}`);
      const detail = params.reason ?? null;
      const state = parseSessionState(kind, detail);
      const snap = this.#registry.setStatus(id, state, detail);
      this.emitEvent({
        type: "status_changed",
        sessionId: id,
        status: state,
        ts: Date.now(),
        ...(detail !== null ? { note: detail } : {}),
      });
      this.#publishState(snap.id);
      this.#onActivityChange("set-status");
      return snap;
    });

    d.register("dev.emit", (params) => {
      const event = { ...params.event, ts: Date.now() };
      const seq = this.emitEvent(event);
      return { seq };
    });
  }

  #hHello(p: RpcParams<"hello">, ctx: RpcContext): HelloResult {
    if (p.protocolVersion !== undefined && p.protocolVersion !== PROTOCOL_VERSION) {
      // The version rides in `data` as well as the message: the client renders
      // its own "upgrade" line from it, and parsing that out of prose would be
      // a second, worse protocol.
      throw new RpcError(
        "protocol_mismatch",
        `client protocol ${p.protocolVersion} != daemon ${PROTOCOL_VERSION}`,
        { daemon: PROTOCOL_VERSION },
      );
    }
    ctx.conn.clientId = p.clientId ?? `anon-${ctx.conn.id}`;

    // Subscribe and enqueue the opening snapshot as one synchronous operation:
    // any state change from here on is published *after* this frame, so the
    // client cannot miss one in the gap and cannot install an older baseline
    // over a newer push. The hello *result* carries handshake metadata only.
    this.#server.subscribe(ctx.conn);
    ctx.conn.pushState(this.#stateFrame("all"));

    this.#onActivityChange("hello");

    return {
      protocolVersion: PROTOCOL_VERSION,
      daemon: {
        pid: Deno.pid,
        version: LOOM_VERSION,
        startedAt: this.startedAt,
        repoRoot: this.repoRoot,
        epoch: this.epoch,
      },
    };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** Reject invalid tool selections before allocating session resources. */
  async #preflightTools(
    provider: string,
    isolation = this.#providers.defaultIsolation(provider),
  ): Promise<void> {
    try {
      await preflightTools(this.#providers.configFor(provider, isolation), provider);
    } catch (error) {
      throw new RpcError("bad_request", error instanceof Error ? error.message : String(error));
    }
  }

  /** Vendor-neutral handles for the selected tools. */
  #mcpHandles(): McpServerHandle[] {
    const commands: McpServerHandle[] = this.config.mcp.map((m) => {
      if ("runtime" in m)
        return {
          name: m.name,
          ...(m.required ? { required: true } : {}),
          ...(m.defaultFor ? { defaultFor: m.defaultFor } : {}),
          spec: { transport: "runtime", runtime: m.runtime, isolation: m.isolation },
        };
      const { command, args } = m;
      return {
        name: m.name,
        ...(m.required ? { required: true } : {}),
        ...(m.defaultFor ? { defaultFor: m.defaultFor } : {}),
        spec: { transport: "stdio", command, args: args ?? [] },
      };
    });
    const http: McpServerHandle[] = this.config.httpMcp.map((m) => {
      const token =
        m.bearerToken || (m.bearerTokenEnv ? Deno.env.get(m.bearerTokenEnv) : undefined);
      if (m.bearerTokenEnv && !token)
        throw new Error("MCP " + m.name + ": " + m.bearerTokenEnv + " is not set");
      return {
        name: m.name,
        ...(m.required ? { required: true } : {}),
        defaultFor: m.defaultFor,
        ...(m.bearerTokenEnv ? { credentialEnv: m.bearerTokenEnv } : {}),
        spec: {
          transport: "http",
          url: m.url,
          ...(token ? { headers: { Authorization: "Bearer " + token } } : {}),
        },
      };
    });
    return [...commands, ...http];
  }

  /**
   * Sessions whose stored `provider` id no longer resolves in the current
   * config — typically a `providers.claude.profiles` key (hence id) or a
   * `providers.<family>.profiles` entry was renamed out from under it. A Claude-family id
   * with a live transcript match self-heals in {@link #reviveSession}; this
   * only reports what's left — aisdk ids (no on-disk ownership evidence) and
   * Claude ids with zero/ambiguous matches — so it stays visible instead of
   * `#autoResumeInterrupted` silently skipping the session.
   */
  #orphanedProviderWarnings(): string[] {
    const ids = new Set(this.#registry.list().map((s) => s.provider));
    const w: string[] = [];
    for (const id of ids) {
      if (this.#providers.has(id)) continue;
      w.push(
        `sessions reference provider "${id}", which no longer exists in config — ` +
          "did you rename a providers.<family>.profiles entry? " +
          `fix with \`loom relink-provider ${id} <current-id>\``,
      );
    }
    return w;
  }

  /**
   * `daemon.doctor` — what a new session's tool / connector / MCP environment
   * looks like right now, plus daemon vitals. The provider-native built-in
   * lists (`tools.claude` / `tools.aisdk`) mirror the connector packages
   * (`aisdk/src/tools/builtins.ts`; Claude Code's own suite minus
   * `providers.claude.disable_builtin`) — the daemon never imports them, so
   * they're spelled out here and flagged as indicative.
   */
  async #doctorReport(): Promise<DoctorReport> {
    const mcp: DoctorMcpServer[] = await Promise.all(
      this.config.mcp.map(async (m): Promise<DoctorMcpServer> => {
        if ("runtime" in m) {
          try {
            const prepared = await resolveRuntime(m.runtime);
            return {
              name: m.name,
              command: `runtime ${m.runtime}`,
              resolved: prepared.manifest.entrypoint,
              status: "ok",
              note: `Separate tool VM; network disabled. ${m.required ? "Required. " : ""}VM boot checked at session startup.`,
            };
          } catch (error) {
            return {
              name: m.name,
              command: `runtime ${m.runtime}`,
              resolved: "",
              status: "missing",
              note: error instanceof Error ? error.message : String(error),
            };
          }
        }
        const { command, args = [] } = m;
        return {
          name: m.name,
          command: m.command,
          resolved: [command, ...args].join(" "),
          status: mcpStatusOf(command),
          note: ["Host tool.", m.required ? "Required." : ""].filter(Boolean).join(" "),
        };
      }),
    );

    for (const m of this.config.httpMcp) {
      const missing = !m.bearerToken && m.bearerTokenEnv && !Deno.env.get(m.bearerTokenEnv);
      mcp.push({
        name: m.name,
        command: "HTTP MCP",
        resolved: new URL(m.url).origin,
        status: missing ? "missing" : "ok",
        note: missing
          ? m.bearerTokenEnv + " is not set"
          : "Isolated HTTP relay; preferred for: " +
            (m.defaultFor.join(", ") || "none") +
            (m.required ? ". Required remote tool." : ""),
      });
    }
    const s = this.config.search;
    const searchKey = s.backend === "none" ? "" : resolveApiKey(s);

    return {
      daemon: {
        pid: Deno.pid,
        version: LOOM_VERSION,
        startedAt: this.startedAt,
        uptimeMs: Date.now() - this.startedAt,
        epoch: this.epoch,
        repoRoot: this.repoRoot,
        clients: this.#server.clientCount,
        connections: this.#server.connectionCount,
        eventSeq: this.#eventSeq,
        sessions: this.#registry.list().length,
        runningSessions: this.#sessions.count,
      },
      connectors: this.#providers.connectorReport(),
      mcp,
      tools: {
        loom: ["ask_user", "commit"],
        claude: ["Read", "Write", "Edit", "Bash", "Task", "TodoWrite", "WebFetch"],
        aisdk: ["bash", "edit", "grep"],
        claudeDisabled: [...this.config.providers.claude.disableBuiltin],
      },
      webSearch: {
        backend: s.backend,
        enabled: s.backend !== "none" && searchKey !== "",
        note: searchNoteOf(s.backend, searchKey),
      },
      configWarnings: [...lintConfig(this.config), ...this.#orphanedProviderWarnings()],
    };
  }
}

// ---------------------------------------------------------------------------
// daemon.doctor helpers
// ---------------------------------------------------------------------------

/** MCP command health for {@link DoctorReport}: whether the configured binary is executable. */
const mcpStatusOf = (command: string): DoctorMcpServer["status"] =>
  onPath(command) ? "ok" : "missing";

const searchNoteOf = (backend: string, resolvedKey: string): string => {
  if (backend === "none") return "no backend configured";
  if (resolvedKey === "") return "backend set but no api_key / api_key_env resolved";
  return "";
};
