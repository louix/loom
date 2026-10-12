// A worker's own TMPDIR, and the claim that lets a later daemon remove one
// left behind when its worker and the process that launched it are gone
// (a crash, a kill, a close that outlasted shutdown).

import { join } from "node:path";
import { z } from "zod";
import { pidAlive } from "@loom/core/daemon-endpoint";

/**
 * Not the daemon's $TMPDIR: a daemon started in a nix-shell (or on macOS) has
 * one deep enough that the agent's sockets below it run past sun_path.
 */
export const WORKER_SCRATCH_ROOT = "/tmp";

const PREFIXES = ["loom-claude-worker-", "loom-provider-worker-"] as const;

/** Inside the scratch: the agent can rewrite it, but only to have its own directory removed. */
const CLAIM_FILE = "loom-worker.json";

type ScratchPrefix = (typeof PREFIXES)[number];

const pid = z.number().int().positive();
const scratchClaimSchema = z.object({
  /** The process that made the scratch and removes it when its worker exits. */
  owner: pid,
  /** The worker's process group, once launched: the agent and everything it started. */
  group: pid.optional(),
});
type ScratchClaim = z.infer<typeof scratchClaimSchema>;

export const mkWorkerScratch = (prefix: ScratchPrefix): string => {
  const scratch = Deno.realPathSync(Deno.makeTempDirSync({ dir: WORKER_SCRATCH_ROOT, prefix }));
  writeClaim(scratch, { owner: Deno.pid });
  return scratch;
};

/** Record the process group now using `scratch`; only a claimed scratch is ever swept. */
export const claimWorkerScratch = (scratch: string, group: number): void =>
  writeClaim(scratch, { owner: Deno.pid, group });

/** Worker scratch directories under `root` this user owns, with their claims. */
export const workerScratches = async (
  root: string,
): Promise<Array<{ path: string; claim: ScratchClaim }>> => {
  const uid = Deno.uid();
  const paths = (await Array.fromAsync(Deno.readDir(root)))
    .filter((entry) => entry.isDirectory && PREFIXES.some((p) => entry.name.startsWith(p)))
    .map((entry) => join(root, entry.name));
  const claims = await Promise.all(paths.map((path) => readClaim(path, uid)));
  return paths.flatMap((path, i) => {
    const claim = claims[i];
    return claim ? [{ path, claim }] : [];
  });
};

/**
 * Remove scratch left under `root` by workers that are gone: claimed by a
 * launch, with neither the launching process nor the worker's group alive.
 * Assumes one PID namespace shares `root`.
 */
export const sweepWorkerScratch = async (root: string): Promise<string[]> => {
  const stale = (await workerScratches(root)).filter(
    ({ claim }) => claim.group !== undefined && !pidAlive(claim.owner) && !groupAlive(claim.group),
  );
  for (const { path } of stale) await Deno.remove(path, { recursive: true });
  return stale.map(({ path }) => path);
};

const writeClaim = (scratch: string, claim: ScratchClaim) =>
  Deno.writeTextFileSync(join(scratch, CLAIM_FILE), JSON.stringify(claim));

const readClaim = async (scratch: string, uid: number | null): Promise<ScratchClaim | null> => {
  try {
    const directory = await Deno.lstat(scratch);
    const file = await Deno.lstat(join(scratch, CLAIM_FILE));
    if (directory.uid !== uid || file.uid !== uid || !file.isFile || file.size > 1024) return null;
    const claim = scratchClaimSchema.safeParse(
      JSON.parse(await Deno.readTextFile(join(scratch, CLAIM_FILE))),
    );
    return claim.success ? claim.data : null;
  } catch {
    return null; // Gone, unreadable or not JSON: not provably Loom's.
  }
};

const groupAlive = (group: number): boolean => {
  try {
    // Signal 0 only probes; see pidAlive for the cast.
    Deno.kill(-group, 0 as unknown as Deno.Signal);
    return true;
  } catch (error) {
    return !(error instanceof Deno.errors.NotFound);
  }
};
