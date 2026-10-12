/**
 * Settings Loom renamed or stopped reading. They keep parsing: before the
 * schema sees a config layer, a renamed key moves to its replacement and a
 * removed one is dropped, and each is recorded so Loom can say so once.
 */
import { absurd } from "@loom/core/absurd";

type Raw = Record<string, unknown>;

/** Paths are layer-relative and dotted; a `repos[]` entry's carry its `repos[<path>].` prefix. */
export type ConfigKeyNotice =
  | { readonly kind: "removed"; readonly key: string; readonly reason: string }
  | {
      readonly kind: "renamed";
      readonly key: string;
      readonly replacement: string;
      readonly value: unknown;
    }
  /** Both the old key and its replacement are set in one layer; the replacement wins. */
  | { readonly kind: "superseded"; readonly key: string; readonly replacement: string }
  /** Still read as before, because its replacement means something else. */
  | {
      readonly kind: "deprecated";
      readonly key: string;
      readonly replacement: string;
      readonly advice: string;
    }
  /** Not a setting of the section it is in; ignored. */
  | { readonly kind: "unknown"; readonly key: string };

/** What an old key becomes. */
type Mapped =
  | { readonly kind: "moved"; readonly value: unknown }
  /** No new key means it; the old one is dropped. */
  | { readonly kind: "dropped"; readonly reason: string }
  /** Read as it is, since moving it would change its meaning. */
  | { readonly kind: "kept"; readonly advice: string }
  /** Already the current form under the same name. */
  | { readonly kind: "current" };

interface Rename {
  readonly to: string;
  /** Old keys folding into `to`; `value` gets theirs in this order, undefined where unset. */
  readonly from: readonly string[];
  readonly value: (old: readonly unknown[]) => Mapped;
}

interface Scope {
  /** Why each removed setting is no longer read. */
  readonly removed: Readonly<Record<string, string>>;
  readonly renames: readonly Rename[];
}

const moved = (value: unknown): Mapped => ({ kind: "moved", value });
const rename = (from: string, to: string): Rename => ({
  to,
  from: [from],
  value: ([v]) => moved(v),
});

// A value the new key does not accept passes through, so the schema reports it there.
const LAYER: Scope = {
  removed: {
    db: "the database lives in $XDG_STATE_HOME/loom/repos/<repo>/loom.db",
    "session.isolation.launcher": "session VMs always start through the isolation library",
    "session.titles": "session titles are always generated",
    "session.notify":
      'webhooks are hooks now: add a hooks entry with on: "waiting" and run: "curl …"',
    "session.isolation.environment.nix":
      "Loom supplies the writable Nix store automatically; session.environment.auto_nix allows project shell activation",
  },
  renames: [
    {
      to: "session.defaults.isolation",
      from: ["session.isolation.enabled"],
      value: ([enabled]) => {
        if (enabled === true) return moved("vm");
        if (enabled === false) return moved("none");
        return moved(enabled);
      },
    },
    {
      to: "session.defaults.workspace",
      from: ["session.worktree.enabled", "session.isolation.checkout.mode"],
      // Worktrees off always meant in place; checkout.mode only chose how a VM reached one.
      value: ([worktree, mode]) => {
        if (worktree === false) return moved("in-place");
        if (mode === undefined || mode === "mount") return moved("worktree");
        return moved(mode);
      },
    },
    rename("session.isolation.extra_allowed_hosts", "session.isolation.network.allowed_hosts"),
    rename("session.isolation.network_presets", "session.isolation.network.presets"),
    {
      to: "session.auto_rebase",
      from: ["session.auto_rebase.enabled", "session.auto_rebase.mode"],
      // `mode` meant nothing while `enabled` was off, its default.
      value: ([enabled, mode]) => {
        if (enabled === true) return moved(mode ?? "rebase");
        if (enabled === false || enabled === undefined) return moved("off");
        return moved(enabled);
      },
    },
    rename("session.auto_resume.enabled", "session.auto_resume"),
    rename("session.commit_reminder.enabled", "session.commit_reminder"),
    rename("daemon.idle_shutdown_minutes", "daemon.idle_stop_minutes"),
    rename("session.isolation.idle_timeout_minutes", "session.isolation.idle_stop_minutes"),
    rename("session.isolation.checkout.visible_refs", "session.clone.visible_refs"),
    rename("session.isolation.checkout.max_push_bytes", "session.clone.max_push_bytes"),
    ...(["claude", "aisdk", "codex"] as const).map((name) =>
      rename(`session.isolation.${name}`, `session.isolation.runtimes.${name}`),
    ),
    {
      to: "providers.claude.default_mode",
      from: ["providers.claude.permission_default"],
      value: ([mode]) =>
        mode === "bypassPermissions"
          ? {
              kind: "dropped",
              reason:
                "bypassPermissions is not a session mode; new sessions take default, plan, acceptEdits or auto",
            }
          : moved(mode),
    },
    {
      to: "providers.claude.network.allowed_hosts",
      from: ["providers.claude.worker_allowed_hosts"],
      value: () => ({
        kind: "kept",
        advice:
          "it replaces Claude's built-in hosts, while providers.claude.network.allowed_hosts adds to them; list only the extra hosts there",
      }),
    },
    rename("session.provider_access.only", "session.provider_access.allow"),
    rename("session.provider_access.disabled", "session.provider_access.deny"),
    {
      to: "providers.echo",
      from: ["providers.echo.enabled"],
      value: ([enabled]) => {
        if (enabled === true) return moved({});
        if (enabled === false)
          return {
            kind: "dropped",
            reason: "the echo provider is shown only while providers.echo is set",
          };
        return moved(enabled);
      },
    },
    rename("session.auto_nix", "session.environment.auto_nix"),
    ...(["command_prefix", "timeout_seconds", "cpus", "memory_mib"] as const).map((key) =>
      rename(`session.isolation.environment.${key}`, `session.environment.${key}`),
    ),
    rename("base_branch", "session.defaults.base_branch"),
    rename("worktree_dir", "session.worktree_dir"),
  ],
};

/** Collections whose entries carry old keys of their own: arrays by index, records by name. */
const ENTRIES: readonly { readonly path: string; readonly scope: Scope }[] = [
  { path: "hooks", scope: { removed: {}, renames: [rename("timeout", "timeout_seconds")] } },
  { path: "agents.profiles", scope: { removed: {}, renames: [rename("mcp", "mcp_servers")] } },
  {
    path: "mcp_servers",
    scope: {
      removed: { execution: "a local source always runs in a VM, so source.kind says it" },
      renames: [
        {
          to: "grants.network.allowed_hosts",
          from: ["grants.network"],
          value: ([network]) => (Array.isArray(network) ? moved(network) : { kind: "current" }),
        },
      ],
    },
  },
];

/**
 * One config layer (the user defaults, or one `repos[]` entry's overrides) in
 * current names, and what it still sets under old ones. `at` prefixes the
 * reported keys.
 */
export const migrateConfigLayer = (
  layer: Raw,
  at = "",
): { readonly layer: Raw; readonly notices: readonly ConfigKeyNotice[] } =>
  ENTRIES.reduce(
    (acc, { path, scope }) => {
      const entries = migrateEntries(readPath(acc.layer, path), scope, at + path);
      return entries.notices.length === 0
        ? acc
        : {
            layer: writePath(acc.layer, path.split("."), entries.value),
            notices: [...acc.notices, ...entries.notices],
          };
    },
    migrateScope(layer, LAYER, at),
  );

/** One line per notice, naming what to write instead. */
export const showConfigKeyNotice = (d: ConfigKeyNotice): string => {
  switch (d.kind) {
    case "removed":
      return `${d.key} is no longer read (${d.reason}); remove it from the config`;
    case "renamed":
      return typeof d.value === "string"
        ? `${d.key} is deprecated; write ${d.replacement}: ${JSON.stringify(d.value)} instead`
        : `${d.key} is deprecated; write ${d.replacement} instead`;
    case "superseded":
      return `${d.key} is deprecated and ignored: ${d.replacement} is also set and wins; remove ${d.key}`;
    case "deprecated":
      return `${d.key} is deprecated and still read as before: ${d.advice}`;
    case "unknown":
      return `${d.key} is not a Loom setting and is ignored; check its spelling and section`;
    default:
      return absurd(d);
  }
};

const migrateScope = (
  layer: Raw,
  scope: Scope,
  at: string,
): { readonly layer: Raw; readonly notices: readonly ConfigKeyNotice[] } => {
  const removed = Object.keys(scope.removed).filter((key) => readPath(layer, key) !== undefined);
  const renamed = scope.renames.reduce(
    (acc, rename) => {
      const old = rename.from.map((key) => readPath(layer, key));
      const set = rename.from.filter((_, i) => old[i] !== undefined);
      if (set.length === 0) return acc;
      const mapped = rename.value(old);
      if (mapped.kind === "current") return acc;
      const cleared = set.reduce(deletePath, acc.layer);
      // `to` can be the section that held the old keys (auto_rebase), so read it once they are gone.
      if (readPath(cleared, rename.to) !== undefined)
        return {
          layer: cleared,
          notices: [
            ...acc.notices,
            ...set.map((key): ConfigKeyNotice => ({
              kind: "superseded",
              key: at + key,
              replacement: at + rename.to,
            })),
          ],
        };
      const step = ((): {
        readonly layer: Raw;
        readonly notice: (key: string) => ConfigKeyNotice;
      } => {
        switch (mapped.kind) {
          case "moved":
            return {
              layer: writePath(cleared, rename.to.split("."), mapped.value),
              notice: (key) => ({
                kind: "renamed",
                key: at + key,
                replacement: at + rename.to,
                value: mapped.value,
              }),
            };
          case "dropped":
            return {
              layer: cleared,
              notice: (key) => ({ kind: "removed", key: at + key, reason: mapped.reason }),
            };
          case "kept":
            return {
              layer: acc.layer,
              notice: (key) => ({
                kind: "deprecated",
                key: at + key,
                replacement: at + rename.to,
                advice: mapped.advice,
              }),
            };
          default:
            return absurd(mapped);
        }
      })();
      return { layer: step.layer, notices: [...acc.notices, ...set.map(step.notice)] };
    },
    {
      layer: removed.reduce(deletePath, layer),
      notices: removed.map((key): ConfigKeyNotice => ({
        kind: "removed",
        key: at + key,
        reason: scope.removed[key] ?? "",
      })),
    },
  );
  return renamed;
};

/** Each entry of an array (reported as `path[i].`) or a record (`path.name.`) migrated alone. */
const migrateEntries = (
  collection: unknown,
  scope: Scope,
  at: string,
): { readonly value: unknown; readonly notices: readonly ConfigKeyNotice[] } => {
  const one = (entry: unknown, prefix: string) =>
    isRecord(entry) ? migrateScope(entry, scope, prefix) : { layer: entry, notices: [] };
  if (Array.isArray(collection)) {
    const out = collection.map((entry, i) => one(entry, `${at}[${i}].`));
    return { value: out.map((m) => m.layer), notices: out.flatMap((m) => m.notices) };
  }
  if (!isRecord(collection)) return { value: collection, notices: [] };
  const out = Object.entries(collection).map(
    ([name, entry]) => [name, one(entry, `${at}.${name}.`)] as const,
  );
  return {
    value: Object.fromEntries(out.map(([name, m]) => [name, m.layer])),
    notices: out.flatMap(([, m]) => m.notices),
  };
};

const isRecord = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

const record = (v: unknown): Raw => (isRecord(v) ? v : {});

export const readPath = (layer: Raw, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (value, key) => (isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined),
      layer,
    );

const writePath = (layer: Raw, segments: readonly string[], value: unknown): Raw => {
  const [head, ...rest] = segments;
  if (head === undefined) return layer;
  return {
    ...layer,
    [head]: rest.length === 0 ? value : writePath(record(layer[head]), rest, value),
  };
};

/** Drops `path`, and any parent object left empty by dropping it. */
export const deletePath = (layer: Raw, path: string): Raw => {
  const [head, ...rest] = path.split(".");
  if (head === undefined || !Object.hasOwn(layer, head)) return layer;
  const { [head]: child, ...others } = layer;
  if (rest.length === 0) return others;
  if (!isRecord(child)) return layer;
  const next = deletePath(child, rest.join("."));
  return Object.keys(next).length === 0 ? others : { ...layer, [head]: next };
};
