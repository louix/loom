/** Host-side preparation of a clone session: its directory, ref policy and relay binding. */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { privateWorkspacePath, workspaceMount } from "./workspace.ts";
import type { VmBinding } from "../packaged/vm.ts";
import { checkoutSchema } from "./checkout.ts";
import { gitPolicySchema, type GitPolicy } from "./git-relay.ts";
import { writeRecoveryFile } from "./persistence.ts";

export interface SessionClone {
  branch: string;
  base: string;
  visible?: string[];
  identity: { name: string; email: string };
  maxPushBytes?: number;
}

/** The clone lives beside the provider profile, outside the repository and any host Git path. */
export const sessionCheckoutPath = (sessionDirectory: string) =>
  existsSync(join(sessionDirectory, "checkout"))
    ? join(sessionDirectory, "checkout")
    : join(privateWorkspacePath(sessionDirectory), "checkout");
const policyName = "git-policy.json";

/** The relay reads this per connection, so a rename applies to a running session. */
export const writeGitPolicy = async (sessionDirectory: string, policy: GitPolicy) => {
  await Deno.mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await writeRecoveryFile(sessionDirectory, policyName, gitPolicySchema.parse(policy));
};

export const prepareCloneBinding = async (
  repoRoot: string,
  sessionDirectory: string,
  clone: SessionClone,
): Promise<NonNullable<VmBinding["git"]>> => {
  const path = sessionCheckoutPath(sessionDirectory);
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  if ((await Deno.realPath(path)) !== path) throw new Error("Session clone must not be a symlink");
  // Host Git runs here against the host repository only, never against the clone.
  const result = await new Deno.Command("git", {
    args: ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error("Cannot resolve the repository's Git directory");
  const dir = await Deno.realPath(new TextDecoder().decode(result.stdout).trim());
  await writeGitPolicy(sessionDirectory, {
    branch: clone.branch,
    base: clone.base,
    visible: clone.visible ?? [],
  });
  return {
    dir,
    policy: join(sessionDirectory, policyName),
    ...(clone.maxPushBytes ? { maxPushBytes: clone.maxPushBytes } : {}),
    checkout: checkoutSchema.parse({
      path: workspaceMount(path).checkout,
      branch: clone.branch,
      base: clone.base,
      identity: clone.identity,
    }),
  };
};
