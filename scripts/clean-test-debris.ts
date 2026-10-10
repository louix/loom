// Find (and optionally remove) test-suite debris in the developer's real Loom
// state: session VM directories, environment homes, VM inventory records,
// session worktree directories and model catalogues created by test runs that
// predate scripts/lib/test-home.ts.
//
// Default is a dry run: classify every entry as delete / uncertain / keep and
// write a manifest. Nothing is modified (owner locks are probed with a shared,
// non-blocking flock that is released immediately).
//
//   deno run -A scripts/clean-test-debris.ts [--out /tmp/loom-debris-manifest]
//   deno run -A scripts/clean-test-debris.ts --apply --manifest /tmp/loom-debris-manifest.json
//
// --apply removes exactly the manifest's "delete" entries, each only if it is
// re-classified as "delete" with the same evidence and an unchanged mtime
// immediately before removal. Out of scope and never read or touched:
// conversations, conversation-repositories, runtimes, VM lock files.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, resolve } from "node:path";
import { userDirectory } from "../core/src/user-dirs.ts";

type Category = "delete" | "uncertain" | "keep";
type Kind = "session-vms" | "environments" | "vms" | "worktrees" | "model-catalogues";
interface Entry {
  kind: Kind;
  path: string;
  category: Category;
  evidence: string[];
  bytes: number;
  mtime: string | null;
}

const state = join(userDirectory("state"), "loom");
const ROOTS: Record<Kind, string> = {
  "session-vms": join(state, "session-vms"),
  environments: join(state, "environments"),
  vms: join(state, "vms"),
  worktrees: join(userDirectory("data"), "loom", "worktrees"),
  "model-catalogues": join(userDirectory("cache"), "loom", "model-catalogues"),
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const exists = (path: string) => {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const readText = (path: string) => {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return undefined;
  }
};
const children = (dir: string) => {
  try {
    return [...Deno.readDirSync(dir)];
  } catch {
    return [];
  }
};
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** A temp-dir repository from a test fixture: gone, under /tmp, loom-/nix-shell-named. */
const FIXTURE = /^\/tmp\/(?:[^/]+\/)*(?:loom-[^/]*|nix-shell[^/]*)\//;
const fixtureRepo = (repo: string) => FIXTURE.test(repo + "/") && !exists(repo);

// ---------------------------------------------------------------------------
// Evidence sources

interface VmRecordLite {
  id?: string;
  repo?: string;
  state?: string;
  sessionId?: string | null;
  paths?: Record<string, string | null>;
}
const recordOf = (dir: string): VmRecordLite | undefined => {
  try {
    return JSON.parse(Deno.readTextFileSync(join(dir, "record.json")));
  } catch {
    return undefined;
  }
};

interface Context {
  /** sha256(resolve(repo)) → repo, for every repository that exists or is known. */
  knownRepos: Map<string, string>;
  /** sha256(realpath(repo))[:16] of known repos: worktree directory suffixes. */
  knownTreeHashes: Set<string>;
  /** Hash → repository path recovered from debris itself (VM records, checkouts, gitdirs). */
  recovered: Map<string, string>;
  /** Session ids and paths referenced by known repositories' Loom databases. */
  dbSessions: Set<string>;
  dbPaths: Set<string>;
  dbErrors: string[];
  /** Command lines and working directories of running processes. */
  processes: string[];
}

const addRepo = (ctx: Context, repo: string) => {
  for (const path of new Set([resolve(repo), real(repo)])) {
    ctx.knownRepos.set(sha(path).slice(0, 32), path);
    ctx.knownTreeHashes.add(sha(path).slice(0, 16));
  }
};

const gitdirRepo = (worktree: string) => {
  const match = readText(join(worktree, ".git"))?.match(/^gitdir: (.+)\/worktrees\/[^/]+\s*$/m);
  if (!match) return undefined;
  const gitdir = match[1]!;
  return basename(gitdir) === ".git" ? dirname(gitdir) : gitdir;
};

const checkoutOrigin = (sessionDir: string) =>
  readText(join(sessionDir, "workspace/checkout/.git/config"))?.match(
    /\[remote "origin"\][^[]*?\burl = (\/[^\n]+)/,
  )?.[1];

const loadContext = (): Context => {
  const ctx: Context = {
    knownRepos: new Map(),
    knownTreeHashes: new Set(),
    recovered: new Map(),
    dbSessions: new Set(),
    dbPaths: new Set(),
    dbErrors: [],
    processes: [],
  };
  let repos: string[] = [];
  try {
    repos = JSON.parse(Deno.readTextFileSync(join(state, "repositories.json")));
  } catch (error) {
    ctx.dbErrors.push(`repositories.json unreadable: ${error}`);
  }
  // Known repositories: the recent list, their linked worktrees, existing
  // non-temp repositories named by VM records or session worktrees.
  const candidates = new Set(repos);
  for (const entry of children(ROOTS.vms)) {
    const repo = recordOf(join(ROOTS.vms, entry.name))?.repo;
    if (repo && exists(repo)) candidates.add(repo);
  }
  for (const dir of children(ROOTS.worktrees))
    for (const tree of children(join(ROOTS.worktrees, dir.name))) {
      const repo = gitdirRepo(join(ROOTS.worktrees, dir.name, tree.name));
      if (repo && exists(repo)) candidates.add(repo);
    }
  for (const repo of candidates) {
    addRepo(ctx, repo);
    for (const sub of [".loom/trees", ".claude/worktrees"])
      for (const tree of children(join(repo, sub))) addRepo(ctx, join(repo, sub, tree.name));
    for (const linked of children(join(repo, ".git/worktrees"))) {
      const gitfile = readText(join(repo, ".git/worktrees", linked.name, "gitdir"))?.trim();
      if (gitfile) addRepo(ctx, dirname(gitfile));
    }
    const db = join(repo, ".loom/loom.db");
    if (!exists(db)) continue;
    try {
      const handle = new DatabaseSync(db, { readOnly: true });
      try {
        for (const row of handle.prepare("SELECT id, worktree FROM sessions").all()) {
          ctx.dbSessions.add(String(row["id"]));
          if (row["worktree"]) ctx.dbPaths.add(resolve(String(row["worktree"])));
        }
      } finally {
        handle.close();
      }
    } catch (error) {
      ctx.dbErrors.push(`${db}: ${error instanceof Error ? error.message : error}`);
    }
  }
  // Repositories recovered from the debris itself, each verified by its hash.
  const recover = (repo: string | undefined) => {
    if (repo) ctx.recovered.set(sha(resolve(repo)).slice(0, 32), resolve(repo));
  };
  for (const entry of children(ROOTS.vms)) recover(recordOf(join(ROOTS.vms, entry.name))?.repo);
  for (const hash of children(ROOTS["session-vms"]))
    for (const session of children(join(ROOTS["session-vms"], hash.name)))
      recover(checkoutOrigin(join(ROOTS["session-vms"], hash.name, session.name)));
  for (const dir of children(ROOTS.worktrees))
    for (const tree of children(join(ROOTS.worktrees, dir.name)))
      recover(gitdirRepo(join(ROOTS.worktrees, dir.name, tree.name)));
  ctx.processes = processes();
  return ctx;
};

/** Command lines and working directories of every visible process. */
const processes = () => {
  const seen: string[] = [];
  for (const proc of children("/proc")) {
    if (!/^\d+$/.test(proc.name) || proc.name === String(Deno.pid)) continue;
    const cmdline = readText(`/proc/${proc.name}/cmdline`)?.replaceAll("\0", " ");
    if (cmdline) seen.push(cmdline);
    try {
      seen.push(Deno.readLinkSync(`/proc/${proc.name}/cwd`));
    } catch {
      // Not ours or already gone.
    }
  }
  return seen;
};

/** True when another process holds the lock (shared probe, released at once). */
const locked = async (path: string): Promise<boolean> => {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return false;
  }
  try {
    const free = await file.tryLock(false);
    if (free) await file.unlock();
    return !free;
  } finally {
    file.close();
  }
};

const liveProcess = (ctx: Context, needles: (string | undefined | null)[]) =>
  needles.filter((n): n is string => !!n).find((n) => ctx.processes.some((p) => p.includes(n)));

const size = (path: string): number => {
  const info = Deno.lstatSync(path);
  let bytes = (info.blocks ?? 0) * 512;
  if (info.isDirectory)
    for (const child of children(path)) {
      try {
        bytes += size(join(path, child.name));
      } catch {
        // Vanished while measuring.
      }
    }
  return bytes;
};

// ---------------------------------------------------------------------------
// Classifiers: each returns the category and the evidence behind it.

type Verdict = [Category, string[]];

const classifySessionVms = async (ctx: Context, path: string): Promise<Verdict> => {
  const hash = basename(path);
  const known = ctx.knownRepos.get(hash);
  if (known) return ["keep", [`hash is sha256 of known repository ${known}`]];
  const sessions = children(path).filter((e) => e.isDirectory);
  for (const s of sessions) {
    if (ctx.dbSessions.has(s.name)) return ["keep", [`session ${s.name} is in a Loom database`]];
    const dir = join(path, s.name);
    if (exists(join(dir, "active.json"))) return ["keep", [`${s.name}/active.json present`]];
    if (await locked(join(dir, "owner.lock"))) return ["keep", [`${s.name}/owner.lock is held`]];
  }
  const live = liveProcess(ctx, [path]);
  if (live) return ["keep", [`a running process references ${live}`]];
  const repo = ctx.recovered.get(hash);
  if (!repo) return ["uncertain", ["repository for this hash could not be recovered"]];
  if (exists(repo)) return ["keep", [`hash is sha256 of existing repository ${repo}`]];
  if (!fixtureRepo(repo))
    return ["uncertain", [`repository ${repo} is gone but not a temp-dir test fixture`]];
  return [
    "delete",
    [
      `hash is sha256 of ${repo}`,
      "that repository no longer exists and is a /tmp test fixture",
      `${sessions.length} session(s), none in any known Loom database, none locked or active`,
    ],
  ];
};

const classifyEnvironment = async (ctx: Context, path: string): Promise<Verdict> => {
  const hash = basename(path);
  const known = ctx.knownRepos.get(hash);
  if (known) return ["keep", [`hash is sha256 of known repository ${known}`]];
  const names = children(path).map((e) => e.name);
  if (names.some((n) => n.startsWith("base-") || n.startsWith("current")))
    return ["uncertain", ["holds a prepared environment base"]];
  for (const lock of ["publication.lock", "sessions.lock", "preparation/owner.lock"])
    if (await locked(join(path, lock))) return ["keep", [`${lock} is held`]];
  const live = liveProcess(ctx, [path]);
  if (live) return ["keep", [`a running process references ${live}`]];
  const repo = ctx.recovered.get(hash);
  if (!repo) return ["uncertain", ["repository for this hash could not be recovered"]];
  if (exists(repo)) return ["keep", [`hash is sha256 of existing repository ${repo}`]];
  if (!fixtureRepo(repo))
    return ["uncertain", [`repository ${repo} is gone but not a temp-dir test fixture`]];
  return [
    "delete",
    [
      `hash is sha256 of ${repo}`,
      "that repository no longer exists and is a /tmp test fixture",
      `only unlocked lock files: ${names.join(", ")}`,
    ],
  ];
};

const classifyVm = async (ctx: Context, path: string): Promise<Verdict> => {
  const record = recordOf(path);
  if (!record?.repo) return ["uncertain", ["no readable record.json"]];
  if (record.sessionId && ctx.dbSessions.has(record.sessionId))
    return ["keep", [`session ${record.sessionId} is in a Loom database`]];
  if (exists(record.repo)) return ["keep", [`repository ${record.repo} exists`]];
  if (!fixtureRepo(record.repo))
    return ["uncertain", [`repository ${record.repo} is gone but not a temp-dir test fixture`]];
  if (await locked(join(dirname(path), ".locks", basename(path))))
    return ["keep", ["VM owner lock is held"]];
  const live = liveProcess(ctx, [record.id, record.paths?.["state"]]);
  if (live) return ["keep", [`a running process references ${live}`]];
  return [
    "delete",
    [
      `record repo ${record.repo} no longer exists and is a /tmp test fixture`,
      `state ${record.state}; owner lock free; no running process references it`,
    ],
  ];
};

const classifyWorktrees = (ctx: Context, path: string): Verdict => {
  const hash = basename(path).match(/-([0-9a-f]{16})$/)?.[1];
  if (hash && ctx.knownTreeHashes.has(hash))
    return ["keep", ["hash suffix matches a known repository"]];
  const trees = children(path);
  for (const tree of trees)
    if (ctx.dbPaths.has(join(path, tree.name)))
      return ["keep", [`${tree.name} is a session worktree in a Loom database`]];
  const live = liveProcess(ctx, [path]);
  if (live) return ["keep", [`a running process references ${live}`]];
  if (trees.length === 0) {
    if (/^repo-[0-9a-f]{16}$/.test(basename(path)))
      return [
        "delete",
        [
          "empty directory",
          "named after a test harness repository ('repo'), hash matches no known repository",
        ],
      ];
    return ["uncertain", ["empty, but not named like a test fixture"]];
  }
  const repos = trees.map((t) => gitdirRepo(join(path, t.name)));
  if (repos.every((repo) => repo && fixtureRepo(repo)))
    return [
      "delete",
      [
        `${trees.length} worktree(s) whose repositories no longer exist and are /tmp test fixtures`,
        ...new Set(repos.map((r) => `gitdir repository ${r}`)),
      ],
    ];
  return ["uncertain", ["some worktrees belong to an existing or unrecognised repository"]];
};

const classifyCatalogue = (_ctx: Context, path: string): Verdict => {
  try {
    const value = JSON.parse(Deno.readTextFileSync(path));
    const models = value?.catalogue?.models;
    if (
      Array.isArray(models) &&
      models.length === 1 &&
      JSON.stringify(models[0]) === JSON.stringify({ id: "fixture", label: "fixture" })
    )
      return [
        "delete",
        ['catalogue is exactly the test fixture: [{"id":"fixture","label":"fixture"}]'],
      ];
    return ["keep", ["real model catalogue"]];
  } catch {
    return ["uncertain", ["unreadable catalogue"]];
  }
};

const classifyKind = (ctx: Context, kind: Kind, path: string): Promise<Verdict> | Verdict => {
  switch (kind) {
    case "session-vms":
      return classifySessionVms(ctx, path);
    case "environments":
      return classifyEnvironment(ctx, path);
    case "vms":
      return classifyVm(ctx, path);
    case "worktrees":
      return classifyWorktrees(ctx, path);
    case "model-catalogues":
      return classifyCatalogue(ctx, path);
  }
};

/** Without every known database readable, nothing is provably unreferenced. */
const classify = async (ctx: Context, kind: Kind, path: string): Promise<Verdict> => {
  const [category, evidence] = await classifyKind(ctx, kind, path);
  if (category === "delete" && ctx.dbErrors.length)
    return ["uncertain", ["some Loom databases could not be read", ...evidence]];
  return [category, evidence];
};

const entryNames = (kind: Kind) =>
  children(ROOTS[kind])
    .filter((e) => !e.isSymlink && !e.name.startsWith(".locks"))
    // Catalogues only: catalogue.lock and other lock files are never candidates.
    .filter((e) =>
      kind === "model-catalogues" ? e.isFile && e.name.endsWith(".json") : e.isDirectory,
    )
    .map((e) => e.name)
    .sort();

const mtimeOf = (path: string) => Deno.lstatSync(path).mtime?.toISOString() ?? null;

// ---------------------------------------------------------------------------

const flag = (name: string) => {
  const i = Deno.args.indexOf(name);
  return i < 0 ? undefined : Deno.args[i + 1];
};
const args = {
  apply: Deno.args.includes("--apply"),
  manifest: flag("--manifest"),
  out: flag("--out") ?? "/tmp/loom-debris-manifest",
};

if (args.apply) {
  if (!args.manifest) throw new Error("--apply requires --manifest <file>");
  const manifest = JSON.parse(await Deno.readTextFile(args.manifest)) as {
    roots: Record<Kind, string>;
    entries: Entry[];
  };
  if (JSON.stringify(manifest.roots) !== JSON.stringify(ROOTS))
    throw new Error("Manifest was written for different state directories; re-run the dry run");
  // Recovered repositories come from the debris itself, so gather them before removing any.
  const ctx = loadContext();
  let removed = 0;
  let skipped = 0;
  for (const entry of manifest.entries.filter((e) => e.category === "delete")) {
    ctx.processes = processes();
    // Exactly one level below a known root, never a symlink.
    const root = ROOTS[entry.kind];
    if (!root || dirname(entry.path) !== root || entry.path.includes("/../")) {
      console.log(`skip (outside roots): ${entry.path}`);
      skipped++;
      continue;
    }
    if (!exists(entry.path) || Deno.lstatSync(entry.path).isSymlink) {
      console.log(`skip (missing or symlink): ${entry.path}`);
      skipped++;
      continue;
    }
    const [category, evidence] = await classify(ctx, entry.kind, entry.path);
    if (
      category !== "delete" ||
      JSON.stringify(evidence) !== JSON.stringify(entry.evidence) ||
      mtimeOf(entry.path) !== entry.mtime
    ) {
      console.log(`skip (changed since dry run: ${category}, ${evidence[0]}): ${entry.path}`);
      skipped++;
      continue;
    }
    // Git objects and Nix copies are read-only; make the tree writable first.
    await new Deno.Command("chmod", { args: ["-R", "u+w", "--", entry.path] }).output();
    await Deno.remove(entry.path, { recursive: true });
    console.log(`removed: ${entry.path}`);
    removed++;
  }
  console.log(`${removed} removed, ${skipped} skipped`);
  Deno.exit(0);
}

const ctx = loadContext();
const entries: Entry[] = [];
for (const kind of Object.keys(ROOTS) as Kind[]) {
  for (const name of entryNames(kind)) {
    const path = join(ROOTS[kind], name);
    const [category, evidence] = await classify(ctx, kind, path);
    let bytes = 0;
    try {
      bytes = size(path);
    } catch {
      // Vanished while measuring.
    }
    entries.push({ kind, path, category, evidence, bytes, mtime: mtimeOf(path) });
  }
}

const human = (bytes: number) => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  for (; bytes >= 1024 && i < units.length - 1; i++) bytes /= 1024;
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
};
const lines: string[] = [
  `Loom test debris manifest (dry run) — ${new Date().toISOString()}`,
  `Apply with: deno run -A scripts/clean-test-debris.ts --apply --manifest ${args.out}.json`,
  ...ctx.dbErrors.map((e) => `WARNING: ${e}`),
  `Known repositories: ${new Set(ctx.knownRepos.values()).size}; sessions in Loom databases: ${ctx.dbSessions.size}`,
  "",
];
for (const category of ["delete", "uncertain", "keep"] as Category[]) {
  const group = entries.filter((e) => e.category === category);
  lines.push(
    `== ${category.toUpperCase()}: ${group.length} entries, ${human(group.reduce((n, e) => n + e.bytes, 0))}`,
  );
  for (const kind of Object.keys(ROOTS) as Kind[]) {
    const items = group.filter((e) => e.kind === kind);
    if (!items.length) continue;
    lines.push(`  -- ${kind}: ${items.length}, ${human(items.reduce((n, e) => n + e.bytes, 0))}`);
    for (const e of items)
      lines.push(`     ${e.path}  ${human(e.bytes)}  ${e.mtime}\n       ${e.evidence.join("; ")}`);
  }
  lines.push("");
}
await Deno.writeTextFile(
  `${args.out}.json`,
  JSON.stringify(
    { version: 1, createdAt: new Date().toISOString(), roots: ROOTS, entries },
    null,
    2,
  ),
);
await Deno.writeTextFile(`${args.out}.txt`, lines.join("\n"));
for (const category of ["delete", "uncertain", "keep"] as Category[]) {
  const group = entries.filter((e) => e.category === category);
  console.log(
    `${category}: ${group.length} entries, ${human(group.reduce((n, e) => n + e.bytes, 0))}`,
  );
}
console.log(`Manifest: ${args.out}.json, summary: ${args.out}.txt`);
