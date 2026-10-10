/**
 * Guest-only: the existing connector worker, launched as a leased execution inside
 * an environment guest that guest.ts has already initialized. That guest owns the
 * proxy, MCP and Git relays and the activated checkout; this process only restores
 * its environment and serves the unchanged worker protocol on stdio.
 */
import { GIT_DIR_SHARED_ENV } from "../../../core/src/git-lock.ts";
import { runWorker } from "../worker/main.ts";
import { publishAfterTurn, readGuestCheckout } from "./guest-publish.ts";
import { reportStartup } from "./progress.ts";
import { guestWorkerEnvironmentPath } from "./shell.ts";

// The runtime wrapper that started this process reset caches and PATH. Restore the
// initialized guest's environment: credentials, proxies, identity and dev shell.
const environment: Record<string, string> = JSON.parse(
  await Deno.readTextFile(guestWorkerEnvironmentPath),
);
for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
const checkout = await readGuestCheckout();
// Without a private clone the worktree and Git directory are the host's: the
// commit tool must not remove a lock a host `git` may hold (core/src/git-lock.ts).
Deno.env.set(GIT_DIR_SHARED_ENV, checkout ? "0" : "1");
await runWorker(async () => reportStartup("provider"), "session-vm", publishAfterTurn(checkout));
