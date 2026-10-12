/**
 * Settings Loom renamed or stopped reading. They keep parsing: before the
 * schema sees a config layer, a renamed key moves to its replacement and a
 * removed one is dropped, and each is recorded so Loom can say so once.
 */
import { absurd } from "@loom/core/absurd";

type Raw = Record<string, unknown>;

/** Paths are layer-relative and dotted; a `repos[]` entry's carry its `repos[<path>].` prefix. */
export type DeprecatedKey =
  | { readonly kind: "removed"; readonly key: string; readonly reason: string }
  | {
      readonly kind: "renamed";
      readonly key: string;
      readonly replacement: string;
      readonly value: unknown;
    }
  /** Both the old key and its replacement are set in one layer; the replacement wins. */
  | { readonly kind: "superseded"; readonly key: string; readonly replacement: string };

interface Rename {
  readonly to: string;
  /** Old keys folding into `to`; `value` gets theirs in this order, undefined where unset. */
  readonly from: readonly string[];
  readonly value: (old: readonly unknown[]) => unknown;
}

/** Why each removed setting is no longer read. */
export const REMOVED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  db: "the database lives in $XDG_STATE_HOME/loom/repos/<repo>/loom.db",
  "session.isolation.launcher": "session VMs always start through the isolation library",
  "session.titles": "session titles are always generated",
  "session.notify":
    'webhooks are hooks now: add a hooks entry with on: "waiting" and run: "curl …"',
};

// A value the new key does not accept passes through, so the schema reports it there.
const RENAMES: readonly Rename[] = [
  {
    to: "session.defaults.isolation",
    from: ["session.isolation.enabled"],
    value: ([enabled]) => {
      if (enabled === true) return "vm";
      if (enabled === false) return "none";
      return enabled;
    },
  },
  {
    to: "session.defaults.workspace",
    from: ["session.worktree.enabled", "session.isolation.checkout.mode"],
    // Worktrees off always meant in place; checkout.mode only chose how a VM reached one.
    value: ([worktree, mode]) => {
      if (worktree === false) return "in-place";
      if (mode === undefined || mode === "mount") return "worktree";
      return mode;
    },
  },
  {
    to: "session.isolation.network.allowed_hosts",
    from: ["session.isolation.extra_allowed_hosts"],
    value: ([hosts]) => hosts,
  },
  {
    to: "session.isolation.network.presets",
    from: ["session.isolation.network_presets"],
    value: ([presets]) => presets,
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
): { readonly layer: Raw; readonly deprecated: readonly DeprecatedKey[] } => {
  const removed = Object.keys(REMOVED_CONFIG_KEYS).filter(
    (key) => readPath(layer, key) !== undefined,
  );
  const afterRemoved = removed.reduce(deletePath, layer);
  const renamed = RENAMES.reduce(
    (acc, rename) => {
      const old = rename.from.map((key) => readPath(layer, key));
      const set = rename.from.filter((_, i) => old[i] !== undefined);
      if (set.length === 0) return acc;
      const cleared = set.reduce(deletePath, acc.layer);
      const superseded = readPath(layer, rename.to) !== undefined;
      const value = rename.value(old);
      return {
        layer: superseded ? cleared : writePath(cleared, rename.to.split("."), value),
        deprecated: [
          ...acc.deprecated,
          ...set.map((key): DeprecatedKey =>
            superseded
              ? { kind: "superseded", key: at + key, replacement: at + rename.to }
              : { kind: "renamed", key: at + key, replacement: at + rename.to, value },
          ),
        ],
      };
    },
    { layer: afterRemoved, deprecated: [] as readonly DeprecatedKey[] },
  );
  const mcp = migrateMcpGrants(renamed.layer, at);
  return {
    layer: mcp.layer,
    deprecated: [
      ...removed.map((key): DeprecatedKey => ({
        kind: "removed",
        key: at + key,
        reason: REMOVED_CONFIG_KEYS[key] ?? "",
      })),
      ...renamed.deprecated,
      ...mcp.deprecated,
    ],
  };
};

/** One line per deprecated key, naming what to write instead. */
export const showDeprecatedKey = (d: DeprecatedKey): string => {
  switch (d.kind) {
    case "removed":
      return `${d.key} is no longer read (${d.reason}); remove it from the config`;
    case "renamed":
      return typeof d.value === "string"
        ? `${d.key} is deprecated; write ${d.replacement}: ${JSON.stringify(d.value)} instead`
        : `${d.key} is deprecated; write ${d.replacement} instead`;
    case "superseded":
      return `${d.key} is deprecated and ignored: ${d.replacement} is also set and wins; remove ${d.key}`;
    default:
      return absurd(d);
  }
};

/** `grants.network` was a host list; it is `{ allowed_hosts, presets }` now. */
const migrateMcpGrants = (
  layer: Raw,
  at: string,
): { readonly layer: Raw; readonly deprecated: readonly DeprecatedKey[] } => {
  const servers = record(layer.mcp_servers);
  const legacy = Object.keys(servers).filter((name) =>
    Array.isArray(readPath(record(servers[name]), "grants.network")),
  );
  if (legacy.length === 0) return { layer, deprecated: [] };
  return {
    layer: legacy.reduce(
      (acc, name) =>
        writePath(acc, ["mcp_servers", name, "grants", "network"], {
          allowed_hosts: readPath(record(servers[name]), "grants.network"),
        }),
      layer,
    ),
    deprecated: legacy.map((name) => ({
      kind: "renamed",
      key: `${at}mcp_servers.${name}.grants.network`,
      replacement: `${at}mcp_servers.${name}.grants.network.allowed_hosts`,
      value: undefined,
    })),
  };
};

const isRecord = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

const record = (v: unknown): Raw => (isRecord(v) ? v : {});

const readPath = (layer: Raw, path: string): unknown =>
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
const deletePath = (layer: Raw, path: string): Raw => {
  const [head, ...rest] = path.split(".");
  if (head === undefined || !Object.hasOwn(layer, head)) return layer;
  const { [head]: child, ...others } = layer;
  if (rest.length === 0) return others;
  if (!isRecord(child)) return layer;
  const next = deletePath(child, rest.join("."));
  return Object.keys(next).length === 0 ? others : { ...layer, [head]: next };
};
