/**
 * `loom config convert`: print the environment settings of Loom's config.jsonc
 * in the versioned environment format (environment.jsonc), and say what was
 * left behind. The old file is only read. Loom keeps reading it, so everything
 * Loom owns stays there, including the settings that were also converted.
 *
 * Everything in the old file is trusted host configuration, so it converts into
 * host layers (user defaults and `repos[]` overrides), never into project
 * requests that would need grants. Old repo overrides append hooks to inherited
 * ones; new layers replace hook arrays, so a repo entry lists both explicitly.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { z } from "zod";
import {
  DEFAULT_CONFIG,
  HOOK_EVENTS,
  expandTilde,
  mergeRepoOverride,
  normalizeConfig,
  parseConfig,
} from "@loom/daemon/config/config";
import { migrateConfigLayer } from "../../backend/daemon/src/config/legacy-keys.ts";
import { createConfigSchema, parseSettings } from "../../backend/daemon/src/config/schema.ts";
import { userConfigPath } from "../../backend/daemon/src/config-path.ts";
import { environmentUserConfigPath } from "@loom/environment-config/paths";
import { normalizeExtraHosts } from "../../runtime/src/session-vm/network-policy.ts";
import { environmentUserSchema, type EnvironmentUserInput } from "@loom/environment-config/schema";

const settingsSchema = createConfigSchema(DEFAULT_CONFIG, HOOK_EVENTS);
type Settings = z.output<typeof settingsSchema>;
type Raw = Record<string, unknown>;

export interface ConversionReport {
  source: string;
  /** The new user file, as written by --out. */
  user: EnvironmentUserInput;
  converted: Array<{ from: string; to: string; note?: string }>;
  /** Loom-owned settings: not part of environment configuration. */
  staysInLoomConfig: Array<{ path: string; reason: string }>;
  /** Environment settings the new format cannot express; left out. */
  unsupported: Array<{ path: string; reason: string }>;
}

const tools = "agent tools and MCP servers";
const STAYS: Record<string, string> = {
  providers: "agent providers, models and permission modes",
  default_provider: "agent provider selection",
  tui: "TUI settings",
  daemon: "daemon lifetime",
  "session.defaults.base_branch": "session workspace policy",
  "session.worktree_dir": "session workspace policy",
  git: "Git identity of Loom sessions",
  search: "agent web search",
  mcp_servers: tools,
  "session.mcp_servers": tools,
  "session.auto_rebase": "session policy",
  "session.auto_resume": "session policy (auto-resume)",
  "session.commit_reminder": "session policy",
  "session.provider_access": "agent provider access",
  "session.isolation.runtimes": "agent provider runtimes; launch profiles run plain entrypoints",
  "session.clone": "private-clone publication policy",
};
const CONVERTED: Record<string, string> = {
  "session.environment.auto_nix": "environment.nix.auto",
  "session.environment.command_prefix": "environment.commandPrefix",
  "session.environment.timeout_seconds": "environment.timeoutSeconds",
  "session.environment.cpus": "environment.resources.cpus",
  "session.environment.memory_mib": "environment.resources.memoryMiB",
  "session.isolation.network.allowed_hosts": "access.network.allowedHosts",
  "session.isolation.network.presets": "access.network.presets",
  "session.defaults.isolation": "lifecycle.execution",
  "session.defaults.workspace": "lifecycle.workspace",
  "session.isolation.idle_stop_minutes": "lifecycle.idleTimeoutMinutes",
};
const SECTIONS = new Set([
  "session",
  "session.defaults",
  "session.environment",
  "session.isolation",
  "session.isolation.network",
]);
const WORKSPACE_EVENTS = { workspace_prepare: "prepare", workspace_start: "start" } as const;

const record = (value: unknown): Raw =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What one effective old configuration means in new terms. */
const effective = (settings: Settings) => {
  const { session } = settings;
  const { isolation } = session;
  const hooks = (event: keyof typeof WORKSPACE_EVENTS) =>
    settings.hooks
      .filter((hook) => hook.on.includes(event) && !hook.project && !hook.async)
      .map((hook) => ({
        // Keep Loom's labels: an unnamed hook is named by its first word.
        name: hook.name || hook.run.split(/\s+/)[0]!,
        run: hook.run,
        timeoutSeconds: Math.ceil(hook.timeout_seconds / 1000),
      }));
  const { environment } = session;
  const prefix = environment.command_prefix;
  return {
    environment: {
      // Loom ignores auto_nix while a command prefix is set; the new format rejects both.
      nix: environment.auto_nix && !prefix.length,
      commandPrefix: prefix,
      timeoutSeconds: environment.timeout_seconds,
      cpus: environment.cpus,
      memoryMiB: environment.memory_mib,
      prepare: hooks("workspace_prepare"),
      start: hooks("workspace_start"),
    },
    network: {
      presets: isolation.network.presets,
      allowedHosts: normalizeExtraHosts(isolation.network.allowed_hosts),
    },
    lifecycle: {
      workspace: session.defaults.workspace,
      execution: session.defaults.isolation,
      idleTimeoutMinutes: isolation.idle_stop_minutes,
    },
    autoNixIgnored: environment.auto_nix && prefix.length > 0,
  };
};
type Effective = ReturnType<typeof effective>;
const NEUTRAL: Effective["environment"] = {
  nix: false,
  commandPrefix: [],
  timeoutSeconds: 900,
  cpus: 1,
  memoryMiB: 2048,
  prepare: [],
  start: [],
};

/** New-format fields where `next` differs from `base`; `undefined` when nothing does. */
const environmentLayer = (
  next: Effective["environment"],
  base: Effective["environment"],
  unrepresentable: (reason: string) => void,
) => {
  const out: Record<string, unknown> = {};
  if (!same(next.nix, base.nix)) out.nix = { auto: next.nix };
  if (!same(next.commandPrefix, base.commandPrefix)) {
    if (next.commandPrefix.length) out.commandPrefix = next.commandPrefix;
    else unrepresentable("clearing an inherited command_prefix");
  }
  if (next.timeoutSeconds !== base.timeoutSeconds) out.timeoutSeconds = next.timeoutSeconds;
  const resources: Record<string, number> = {};
  if (next.cpus !== base.cpus) resources.cpus = next.cpus;
  if (next.memoryMiB !== base.memoryMiB) resources.memoryMiB = next.memoryMiB;
  if (Object.keys(resources).length) out.resources = resources;
  for (const kind of ["prepare", "start"] as const)
    if (!same(next[kind], base[kind])) out[kind] = next[kind];
  return Object.keys(out).length ? out : undefined;
};

export const convertLoomConfig = (raw: Raw, source: string): ConversionReport => {
  const report: ConversionReport = {
    source,
    user: { version: 1 },
    converted: [],
    staysInLoomConfig: [],
    unsupported: [],
  };
  const { repos = [], ...defaults } = raw;
  if (!Array.isArray(repos)) throw new Error("repos must be an array of objects");

  /** Classify every setting present in one layer of the old file, under current names. */
  const classify = (raw: Raw, prefix: string, target: string) => {
    const { layer, notices } = migrateConfigLayer(raw, prefix);
    const renamedFrom = (at: string) =>
      notices.filter((d) => d.kind === "renamed" && d.replacement === at).map((d) => d.key);
    for (const d of notices) {
      if (d.kind === "removed")
        report.unsupported.push({ path: d.key, reason: "no longer read: " + d.reason });
      if (d.kind === "superseded")
        report.unsupported.push({ path: d.key, reason: `ignored: ${d.replacement} is also set` });
    }
    const walk = (value: Raw, path: string) => {
      for (const [key, child] of Object.entries(value)) {
        const name = path ? path + "." + key : key;
        const at = prefix + name;
        if (name === "$schema" || (prefix && name === "path")) continue;
        if (name === "hooks") continue;
        const old = renamedFrom(at);
        if (CONVERTED[name])
          report.converted.push({
            from: at,
            to: target + CONVERTED[name],
            ...(old.length ? { note: `written as deprecated ${old.join(" and ")}` } : {}),
          });
        else if (STAYS[name]) report.staysInLoomConfig.push({ path: at, reason: STAYS[name] });
        else if (SECTIONS.has(name)) walk(record(child), name);
        else report.unsupported.push({ path: at, reason: "not a Loom setting; Loom ignores it" });
      }
    };
    walk(layer, "");
    const hooks = Array.isArray(layer.hooks) ? layer.hooks : [];
    hooks.forEach((value, index) => {
      const hook = record(value);
      const at = `${prefix}hooks[${index}]`;
      const on = (Array.isArray(hook.on) ? hook.on : [hook.on]).map(String);
      const other = on.filter((event) => !(event in WORKSPACE_EVENTS));
      if (other.length)
        report.staysInLoomConfig.push({
          path: `${at} (${other.join(", ")})`,
          reason: "session, write-feedback and notification hooks",
        });
      for (const event of on.filter((event) => event in WORKSPACE_EVENTS)) {
        const kind = WORKSPACE_EVENTS[event as keyof typeof WORKSPACE_EVENTS];
        const path = `${at} (${event})`;
        if (typeof hook.project === "string" && hook.project.trim())
          report.unsupported.push({
            path,
            reason: `project-scoped hook; add it to repos[].environment.${kind} of each repository it matches`,
          });
        else if (hook.async === true)
          report.unsupported.push({
            path,
            reason: "async workspace_start hook; environment start hooks block startup",
          });
        else
          report.converted.push({
            from: path,
            to: target + "environment." + kind,
            ...(kind === "start"
              ? { note: "a failing start hook now fails startup; Loom reported it to the agent" }
              : {}),
            ...(prefix
              ? {
                  note:
                    "repo hooks appended to inherited hooks; this entry lists both" +
                    (kind === "start" ? "; a failing start hook now fails startup" : ""),
                }
              : {}),
          });
      }
    });
  };

  const parse = (layer: Raw) => {
    normalizeConfig(layer); // Loom's own validation: never convert a file Loom rejects
    return effective(parseSettings(settingsSchema, layer).value);
  };
  // Each layer in current names before merging, as Loom reads them.
  const current = (layer: Raw) => migrateConfigLayer(layer).layer;
  const global = parse(current(defaults));
  classify(defaults, "", "");
  if (global.autoNixIgnored)
    report.unsupported.push({
      path: "session.environment.auto_nix",
      reason: "Loom ignores it while a command_prefix is set; the new format rejects both",
    });
  const user: Raw = { version: 1 };
  const environment = environmentLayer(global.environment, NEUTRAL, () => {});
  if (environment) user.environment = environment;
  const network: Raw = {};
  if (global.network.presets.length) network.presets = global.network.presets;
  if (global.network.allowedHosts.length) network.allowedHosts = global.network.allowedHosts;
  if (Object.keys(network).length) user.access = { network };
  // Always explicit: other consumers default to worktree + VM, Loom to local.
  user.lifecycle = global.lifecycle;

  const entries: Raw[] = [];
  repos.forEach((value, index) => {
    const { path, ...overrides } = record(value);
    if (typeof path !== "string" || !path.trim())
      throw new Error("Every repos entry requires a nonempty path");
    const prefix = `repos[${index}].`;
    const absolute = expandTilde(path.trim());
    if (!isAbsolute(absolute))
      throw new Error("repo.path must be an absolute path or start with ~/");
    const repo = parse(mergeRepoOverride(current(defaults), current(overrides)));
    classify(overrides, prefix, "repos[].");
    if (repo.autoNixIgnored && !global.autoNixIgnored)
      report.unsupported.push({
        path: prefix + "session.environment.auto_nix",
        reason: "Loom ignores it while a command_prefix is set; the new format rejects both",
      });
    const entry: Raw = { path: resolve(absolute) };
    const environment = environmentLayer(repo.environment, global.environment, (what) =>
      report.unsupported.push({ path: prefix + "session.environment", reason: what }),
    );
    if (environment) entry.environment = environment;
    const network: Raw = {};
    for (const key of ["presets", "allowedHosts"] as const)
      if (!same(repo.network[key], global.network[key])) network[key] = repo.network[key];
    if (Object.keys(network).length) entry.access = { network };
    const lifecycle = Object.fromEntries(
      Object.entries(repo.lifecycle).filter(
        ([key, value]) => global.lifecycle[key as keyof typeof global.lifecycle] !== value,
      ),
    );
    if (Object.keys(lifecycle).length) entry.lifecycle = lifecycle;
    if (Object.keys(entry).length > 1) entries.push(entry);
  });
  if (entries.length) user.repos = entries;
  // The output must load as written.
  environmentUserSchema.parse(user);
  report.user = user as EnvironmentUserInput;
  return report;
};

const section = (title: string, lines: string[]) =>
  lines.length ? [title, ...lines.map((line) => "  " + line)] : [];

/** Report text for a terminal: optional file body, then what went where. */
export const formatConversion = (report: ConversionReport, written?: string): string =>
  [
    ...(written
      ? [`wrote ${written}`, `Loom keeps reading ${report.source}; it was not changed.`, ""]
      : [
          `// Environment settings from ${report.source}, in the versioned format.`,
          `// Loom keeps reading ${report.source}; nothing in it was changed.`,
          `// Save with --out FILE; loom-isolate reads ${environmentUserConfigPath()}.`,
          JSON.stringify(report.user, null, 2),
          "",
        ]),
    ...section(
      "converted:",
      report.converted.map(
        (entry) => `${entry.from} -> ${entry.to}${entry.note ? " (" + entry.note + ")" : ""}`,
      ),
    ),
    ...section(
      "stays in Loom config:",
      report.staysInLoomConfig.map((entry) => `${entry.path}: ${entry.reason}`),
    ),
    ...section(
      "not converted:",
      report.unsupported.map((entry) => `${entry.path}: ${entry.reason}`),
    ),
  ].join("\n") + "\n";

/**
 * Read `file` (default: Loom's config.jsonc) and return the command output.
 * Writes only to an explicit `out`, and never over an existing file.
 */
export const configConvert = async (options: {
  file?: string | undefined;
  out?: string | undefined;
  json?: boolean;
}): Promise<string> => {
  const source = resolve(options.file ?? userConfigPath());
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${source}: ${(error as Error).message}`);
  }
  const report = convertLoomConfig(parseConfig(text), source);
  let written: string | undefined;
  if (options.out) {
    written = resolve(options.out);
    try {
      await Deno.writeTextFile(written, JSON.stringify(report.user, null, 2) + "\n", {
        createNew: true,
      });
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists)
        throw new Error(`Refusing to overwrite ${written}; choose a new --out path.`);
      throw error;
    }
  }
  return options.json
    ? JSON.stringify({ ...report, ...(written ? { written } : {}) }, null, 2) + "\n"
    : formatConversion(report, written);
};
