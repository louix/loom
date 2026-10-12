/**
 * `local_tools`, `vm_tools` and `remote_tools` were three catalogs (and three
 * selection lists) for what `mcp_servers` now says with `source.kind`. One
 * config layer at a time, their entries move into `mcp_servers` and their
 * selections into `session.mcp_servers`.
 */
import { absurd } from "@loom/core/absurd";
import type { ConfigKeyNotice } from "./legacy-keys.ts";

type Raw = Record<string, unknown>;

const GROUPS = ["local_tools", "vm_tools", "remote_tools"] as const;
type Group = (typeof GROUPS)[number];

/** How an entry of each old catalog reads as an `mcp_servers` entry; fields absent stay absent. */
const AS_MCP_SERVER: Record<Group, { readonly suffix: string; readonly how: string }> = {
  local_tools: { suffix: "host", how: 'source.kind "command" and its command and args' },
  vm_tools: {
    suffix: "vm",
    how: 'source.kind "runtime", ref: its runtime, and grants.workspace "read-write"',
  },
  remote_tools: {
    suffix: "remote",
    how: 'source.kind "http" and its url; bearer_token and bearer_token_env move under auth',
  },
};

/**
 * The layer with every old tool key folded into `mcp_servers`. Selections keep
 * the order Loom started servers in: host, VM, remote, then `mcp_servers`.
 * A name defined in two catalogs cannot keep both meanings, so it is an error
 * that says what to write.
 */
export const foldLegacyTools = (
  layer: Raw,
  at: string,
): { readonly layer: Raw; readonly notices: readonly ConfigKeyNotice[] } => {
  const servers = record(layer.mcp_servers);
  const catalogs = GROUPS.filter((group) => layer[group] !== undefined);
  const session = record(layer.session);
  const lists = GROUPS.filter((group) => session[group] !== undefined);
  if (catalogs.length === 0 && lists.length === 0) return { layer, notices: [] };

  const entries = catalogs.flatMap((group) =>
    Object.entries(record(layer[group])).map(([name, entry]) => ({ group, name, entry })),
  );
  const clashes = [...new Set(entries.map((e) => e.name))].filter(
    (name) => Object.hasOwn(servers, name) || entries.filter((e) => e.name === name).length > 1,
  );
  if (clashes.length > 0) throw new Error(clashes.map((name) => clash(name, at, layer)).join("; "));

  const folded = Object.fromEntries(
    entries.map(({ group, name, entry }) => [name, asMcpServer(group, record(entry))]),
  );
  const selected = [
    ...new Set(
      [...lists, "mcp_servers"].flatMap((key): unknown[] => {
        const list = session[key];
        return Array.isArray(list) ? list : [];
      }),
    ),
  ];
  // A list of the wrong type passes through, so the schema reports it there.
  const wrongType = lists.find((group) => !Array.isArray(session[group]));
  return {
    layer: {
      ...withoutGroups(layer),
      ...(entries.length > 0 ? { mcp_servers: { ...servers, ...folded } } : {}),
      ...(lists.length > 0
        ? {
            session: {
              ...withoutGroups(session),
              mcp_servers: wrongType ? session[wrongType] : selected,
            },
          }
        : {}),
    },
    notices: [
      ...catalogs
        .filter((group) => layer[group] !== null && Object.keys(record(layer[group])).length === 0)
        .map((group): ConfigKeyNotice => ({
          kind: "removed",
          key: at + group,
          reason: "tools are mcp_servers entries now, and it defines none",
        })),
      ...entries.map(({ group, name }): ConfigKeyNotice => ({
        kind: "folded",
        key: `${at}${group}.${name}`,
        replacement: `${at}mcp_servers.${name}`,
        how: AS_MCP_SERVER[group].how,
      })),
      ...lists.map((group): ConfigKeyNotice => ({
        kind: "folded",
        key: `${at}session.${group}`,
        replacement: `${at}session.mcp_servers`,
        how: "its names (one list for every kind of server; a repos[] entry's list replaces all of it)",
      })),
    ],
  };
};

// Keys the old entry should not have land in `source`, so the schema rejects them there.
const asMcpServer = (group: Group, entry: Raw): Raw => {
  const { default_for, ...rest } = entry;
  const defaults = default_for !== undefined ? { default_for } : {};
  switch (group) {
    case "local_tools":
      return { ...defaults, source: { kind: "command", ...rest } };
    case "vm_tools": {
      const { runtime, ...other } = rest;
      return {
        ...defaults,
        source: { kind: "runtime", ...(runtime !== undefined ? { ref: runtime } : {}), ...other },
        // What a VM tool always had: the session's workspace, and no network.
        grants: { workspace: "read-write" },
      };
    }
    case "remote_tools": {
      const { bearer_token_env, bearer_token, ...other } = rest;
      // `""` meant no token, which mcp_servers says by leaving it out.
      const auth = {
        ...(bearer_token_env !== undefined && bearer_token_env !== "" ? { bearer_token_env } : {}),
        ...(bearer_token !== undefined ? { bearer_token } : {}),
      };
      return {
        ...defaults,
        source: { kind: "http", ...other },
        ...(Object.keys(auth).length > 0 ? { auth } : {}),
      };
    }
    default:
      return absurd(group);
  }
};

/** Names and kinds only: an entry's values may be credentials. */
const clash = (name: string, at: string, layer: Raw): string => {
  const groups = GROUPS.filter((group) => Object.hasOwn(record(layer[group]), name));
  const existing = Object.hasOwn(record(layer.mcp_servers), name)
    ? [`${at}mcp_servers.${name}`]
    : [];
  const writes = groups.map(
    (group) =>
      `${at}mcp_servers.${name}-${AS_MCP_SERVER[group].suffix} with ${AS_MCP_SERVER[group].how}`,
  );
  return (
    `${[...groups.map((group) => `${at}${group}.${name}`), ...existing].join(" and ")} share the name ${name}, ` +
    `and mcp_servers has one entry per name: write ${writes.join(", and ")}; ` +
    `then select the ones you want by those names in ${at}session.mcp_servers`
  );
};

const withoutGroups = (r: Raw): Raw =>
  Object.fromEntries(
    Object.entries(r).filter(([key]) => !(GROUPS as readonly string[]).includes(key)),
  );

const record = (v: unknown): Raw =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {};
