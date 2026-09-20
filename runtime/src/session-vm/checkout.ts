/**
 * The session's working clone, prepared inside the guest. Its only remote is the
 * host relay. Every step is idempotent: a first start, a resume, a renamed
 * branch and a directory copied from a forked parent all converge here.
 */
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { gitBranchSchema } from "./git-relay.ts";

export const guestGitPort = 3129;
export const guestGitRemote = `git://127.0.0.1:${guestGitPort}/repo`;

export const checkoutSchema = z.strictObject({
  path: z.string().refine((v) => isAbsolute(v) && v !== "/"),
  branch: gitBranchSchema,
  base: gitBranchSchema,
  identity: z.strictObject({ name: z.string().min(1).max(200), email: z.string().min(1).max(200) }),
});
export type Checkout = z.infer<typeof checkoutSchema>;

export interface CheckoutOptions {
  remote?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export class CheckoutError extends Error {}

const runner = (cwd: string, options: CheckoutOptions) => {
  const run = async (...args: string[]) => {
    const result = await new Deno.Command("git", {
      args,
      cwd,
      env: { ...options.env, GIT_TERMINAL_PROMPT: "0" },
      clearEnv: options.env !== undefined,
      ...(options.signal ? { signal: options.signal } : {}),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      ok: result.success,
      out: new TextDecoder().decode(result.stdout).trim(),
      err: new TextDecoder().decode(result.stderr).trim(),
    };
  };
  const must = async (...args: string[]) => {
    const result = await run(...args);
    // Git's own message is the diagnosis; keep the tail, where the cause is.
    if (!result.ok) throw new CheckoutError(`git ${args[0]} failed: ${result.err.slice(-600)}`);
    return result.out;
  };
  return { run, must };
};

/** Loom's record of which local branch is the session's, so a rename can follow it. */
const sessionBranchKey = "loom.sessionBranch";

export const prepareCheckout = async (
  input: Checkout,
  options: CheckoutOptions = {},
): Promise<{ created: boolean; head: string }> => {
  const spec = checkoutSchema.parse(input);
  const remote = options.remote ?? guestGitRemote;
  const local = `refs/heads/${spec.branch}`;
  await Deno.mkdir(spec.path, { recursive: true });
  const { run, must } = runner(spec.path, options);

  // `init` and `fetch` rather than `clone`: the directory may already hold provider
  // files, and an interrupted first start must be able to continue.
  let exists = true;
  try {
    await Deno.lstat(join(spec.path, ".git"));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    exists = false;
  }
  if (!exists) await must("init", "-q", `--initial-branch=${spec.branch}`);
  if ((await run("remote", "get-url", "origin")).ok)
    await must("remote", "set-url", "origin", remote);
  else await must("remote", "add", "origin", remote);

  // The host renames the session branch from its title, and a fork starts as a
  // copy of its parent's clone. Either way the old name is ours to move.
  const previous = (await run("config", "--local", "--get", sessionBranchKey)).out;
  if (previous && previous !== spec.branch) {
    const hasPrevious = (await run("show-ref", "--verify", "--quiet", `refs/heads/${previous}`)).ok;
    const hasCurrent = (await run("show-ref", "--verify", "--quiet", local)).ok;
    if (hasPrevious && !hasCurrent) await must("branch", "-m", previous, spec.branch);
  }

  await must("fetch", "-q", "--prune", "origin");
  const created = !(await run("show-ref", "--verify", "--quiet", local)).ok;
  // The host creates the session ref before the first start, so it is always there.
  if (created) await must("checkout", "-q", "-B", spec.branch, `origin/${spec.branch}`);

  const settings: Array<[string, string]> = [
    [sessionBranchKey, spec.branch],
    [`branch.${spec.branch}.remote`, "origin"],
    [`branch.${spec.branch}.merge`, local],
    // A rewritten branch replaces the host ref; the host never moves it itself.
    ["remote.origin.push", `+${local}:${local}`],
    ["user.name", spec.identity.name],
    ["user.email", spec.identity.email],
  ];
  for (const [key, value] of settings) await must("config", "--local", "--replace-all", key, value);
  return { created, head: await must("rev-parse", "HEAD") };
};

/** Publish the session branch to the host. Safe to repeat; a no-op when current. */
export const pushCheckout = async (
  input: Pick<Checkout, "path" | "branch">,
  options: CheckoutOptions = {},
): Promise<{ pushed: boolean; head: string }> => {
  const { run, must } = runner(input.path, options);
  const local = `refs/heads/${input.branch}`;
  const head = await must("rev-parse", "--verify", local);
  const known = await run(
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${input.branch}`,
  );
  if (known.ok && known.out === head) return { pushed: false, head };
  await must("push", "-q", "origin", `+${local}:${local}`);
  return { pushed: true, head };
};
