/**
 * The single seam that turns "an executable, an environment, a cwd, and a
 * state location" into a running `codex app-server` process. Session
 * start/resume (`app-server.ts`) and model discovery (`discovery.ts`) both
 * go through this instead of calling `node:child_process`'s `spawn`
 * themselves, so a test (or, later, a non-local execution path) has one
 * place to substitute a different launch mechanism.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CodexHome } from "./codex-home.ts";

export interface CodexLaunchSpec {
  cliPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Where this process's persisted state (`auth.json`, `config.toml`) lives
   *  — already folded into `env.CODEX_HOME`, but carried explicitly too so a
   *  non-default launcher can see it without parsing env. */
  codexHome: CodexHome;
}

export type CodexLauncher = (spec: CodexLaunchSpec) => ChildProcessWithoutNullStreams;

/** The only place that actually calls `spawn` for a Codex process. */
export const spawnCodex: CodexLauncher = (spec) =>
  spawn(spec.cliPath, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: spec.cwd,
    env: spec.env,
  }) as ChildProcessWithoutNullStreams;
