// One test run: the selected files type-checked once, then run as
// `deno test --parallel` plus one process for each file that owns
// process-wide state, all inside a throwaway HOME/XDG root
// (scripts/lib/test-home.ts).
//
// `--parallel` runs every file on its own thread of a single process, so
// files share the environment, the working directory and signal handlers. A
// file that changes any of them (`Deno.env.set`, `Deno.chdir`, …) says so
// with an `OWN_PROCESS_MARKER` line and its reason, and gets a process of its
// own instead; those run alongside the parallel pass. `test/test-run.test.ts`
// fails a test file that mutates process state without the marker.
//
// Less visibly, they share a descriptor table: every subprocess a thread
// spawns holds a copy of every open descriptor until its exec, flock'd files
// and listening sockets included. A file that releases a `tryLock` or a port
// and takes it straight back fails a large share of those retakes next to
// other files' spawns, so it needs a process of its own too.

import { basename, join } from "node:path";
import {
  mergeSuites,
  parseJunit,
  stripTrailingTestFailedNotice,
  type JunitReport,
} from "../junit.ts";
import { createTestHome } from "./test-home.ts";
import { shardBase, shardsOf } from "./test-shards.ts";

/** A whole line of its own in the test file, followed by why. */
export const OWN_PROCESS_MARKER = "// test-run: own-process";

/** `deno test`'s default module pattern: `test.ts`, `*_test.ts`, `*.test.ts` and kin. */
const TEST_MODULE = /(^|[._])test\.(ts|tsx|mts|js|mjs|jsx)$/;

/** Our own flags; a caller's copy would make `deno test` refuse a repeated argument. */
const OWN_FLAGS = new Set(["--parallel", "--no-check", "--check"]);

export type TestOutput = "live" | "junit";

export interface TestPlan {
  /** `deno test` flags, passed to every process. */
  flags: string[];
  parallel: string[];
  ownProcess: string[];
}

export interface TestRunResult {
  code: number;
  /** Merged over every process; `null` for live output. */
  report: JunitReport | null;
  /** Each process's stderr, for `junit` output (live output went to the terminal). */
  stderr: string;
}

const testModulesUnder = (path: string): string[] =>
  Deno.statSync(path).isDirectory
    ? [...Deno.readDirSync(path)]
        .map((entry) => join(path, entry.name))
        .flatMap(testModulesUnder)
        .filter((file) => TEST_MODULE.test(basename(file)))
        .sort()
    : [path];

const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false; // Not a path: a flag's value, like `--filter <name>`.
  }
};

export const ownsProcess = (source: string): boolean =>
  source.split("\n").some((line) => line.startsWith(OWN_PROCESS_MARKER));

/** Split `deno task test` arguments into flags and files; `test/` when no files are named. */
export const planTests = (args: string[], readFile: (path: string) => string): TestPlan => {
  const targets = args.filter((arg) => !arg.startsWith("-") && exists(arg));
  const flags = args.filter((arg) => !targets.includes(arg) && !OWN_FLAGS.has(arg));
  const selected = (targets.length > 0 ? targets : ["test"]).flatMap(testModulesUnder);
  // A shard stands for its whole file: the file and every shard run, and a
  // shard runs where and when its file would.
  const files = [
    ...new Set(
      selected.flatMap((file) => {
        const base = shardBase(file) ?? file;
        return [base, ...shardsOf(base)];
      }),
    ),
  ]
    .map((file) => ({ file, source: readFile(shardBase(file) ?? file) }))
    // Largest first: `--parallel` starts files in the order given, and the run
    // lasts at least as long as its slowest file, which tends to be a large one.
    .sort((a, b) => b.source.length - a.source.length);
  return {
    flags,
    parallel: files.filter(({ source }) => !ownsProcess(source)).map(({ file }) => file),
    ownProcess: files.filter(({ source }) => ownsProcess(source)).map(({ file }) => file),
  };
};

/** `DENO_JOBS` when set, as `deno test --parallel` reads it; else every core. */
const jobs = (env: Record<string, string>) => {
  const configured = Number(env["DENO_JOBS"]);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : navigator.hardwareConcurrency;
};

/** Run `tasks` with at most `limit` in flight; results in order. */
const pooled = async <T>(limit: number, tasks: Array<() => Promise<T>>): Promise<T[]> => {
  // The lanes share one queue and fill one result array: a work queue is the point.
  const mutQueue = tasks.entries().toArray();
  const mutResults: T[] = [];
  const lane = async (): Promise<void> => {
    const next = mutQueue.shift();
    if (!next) return;
    mutResults[next[0]] = await next[1]();
    return lane();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
  return mutResults;
};

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

const text = (stream: ReadableStream<Uint8Array> | null) =>
  stream ? new Response(stream).text() : Promise.resolve("");

const run = async (
  args: string[],
  env: Record<string, string>,
  output: "inherit" | "piped",
): Promise<ProcessResult> => {
  const child = new Deno.Command(Deno.execPath(), {
    args,
    clearEnv: true,
    env,
    stdout: output,
    stderr: output,
  }).spawn();
  const [stdout, stderr, status] = await Promise.all([
    output === "piped" ? text(child.stdout) : "",
    output === "piped" ? text(child.stderr) : "",
    child.status,
  ]);
  return { code: status.code, stdout, stderr };
};

const write = (s: string) => Deno.stdout.write(new TextEncoder().encode(s));

/** Run the planned tests inside a fresh test home; resolves to the combined exit code. */
export const runTests = async (args: string[], output: TestOutput): Promise<TestRunResult> => {
  const plan = planTests(args, Deno.readTextFileSync);
  const home = await createTestHome();
  // Ctrl-C reaches the children too; outlive them so the test home is still removed.
  const ignore = () => {};
  Deno.addSignalListener("SIGINT", ignore);
  try {
    // One check of every selected module: Deno caches it by module graph, so
    // an unchanged tree checks in milliseconds, and the processes below skip it.
    const check = await run(["check", ...plan.parallel, ...plan.ownProcess], home.env, "piped");
    if (check.code !== 0) {
      await Deno.stderr.write(new TextEncoder().encode(check.stderr));
      return { code: check.code, report: null, stderr: "" };
    }
    const reporter = output === "junit" ? ["--reporter=junit"] : [];
    const test = ["test", "-A", "--no-check", ...reporter, ...plan.flags];
    const started_ms = performance.now();
    const ownProcess = pooled(
      jobs(home.env),
      plan.ownProcess.map((file) => () => run([...test, file], home.env, "piped")),
    );
    const parallel =
      plan.parallel.length > 0
        ? run(
            [...test, "--parallel", ...plan.parallel],
            home.env,
            output === "live" ? "inherit" : "piped",
          )
        : Promise.resolve({ code: 0, stdout: "", stderr: "" });
    const results = [await parallel, ...(await ownProcess)];
    const wall_ms = performance.now() - started_ms;
    // Held back until the parallel pass, which owns the terminal, is done.
    if (output === "live")
      for (const result of results.slice(1)) await write(result.stdout + result.stderr);
    const failed = results.find((result) => result.code !== 0);
    return {
      code: failed?.code ?? 0,
      report:
        output === "junit"
          ? {
              wallMs: wall_ms,
              suites: mergeSuites(results.flatMap((result) => parseJunit(result.stdout).suites)),
            }
          : null,
      stderr: results.map((result) => stripTrailingTestFailedNotice(result.stderr)).join(""),
    };
  } finally {
    Deno.removeSignalListener("SIGINT", ignore);
    await home.remove();
  }
};
