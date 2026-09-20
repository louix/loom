import assert from "node:assert/strict";
import { join } from "node:path";
import { startGuestRelay } from "../../runtime/src/session-vm/guest-relay.ts";
import { startGitRelay } from "../../runtime/src/session-vm/git-relay.ts";

export const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
export const packet = (body: string) =>
  new TextEncoder().encode((body.length + 4).toString(16).padStart(4, "0") + body);

/** A host repository with history the session must never see, served as the guest sees it. */
export const gitRelayFixture = async (
  options: { maxConnections?: number; requestTimeoutMs?: number } = {},
) => {
  const root = await Deno.realPath(await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-relay-" }));
  const host = join(root, "host");
  const run = async (cwd: string, args: string[], env: Record<string, string> = {}) => {
    const result = await new Deno.Command("git", {
      args,
      cwd,
      clearEnv: true,
      env: {
        HOME: root,
        PATH: Deno.env.get("PATH") ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Loom test",
        GIT_AUTHOR_EMAIL: "loom@example.invalid",
        GIT_COMMITTER_NAME: "Loom test",
        GIT_COMMITTER_EMAIL: "loom@example.invalid",
        GIT_TERMINAL_PROMPT: "0",
        ...env,
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { ok: result.success, out: text(result.stdout).trim(), err: text(result.stderr) };
  };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await run(cwd, args);
    assert.ok(result.ok, result.err);
    return result.out;
  };
  await git(root, "init", "-q", "--initial-branch=main", host);
  await Deno.writeTextFile(join(host, "file.txt"), "base\n");
  await git(host, "add", "file.txt");
  await git(host, "commit", "-qm", "base");
  await git(host, "tag", "v1");
  for (const name of ["loom/own", "loom/sibling", "mainline"]) await git(host, "branch", name);
  // The host checkout sits on a hidden branch, so an advertised HEAD would leak it.
  await git(host, "checkout", "-qb", "secret");
  await Deno.writeTextFile(join(host, "secret.txt"), "secret\n");
  await git(host, "add", "secret.txt");
  await git(host, "commit", "-qm", "secret");
  const secret = await git(host, "rev-parse", "HEAD");
  const secretBlob = await git(host, "rev-parse", "HEAD:secret.txt");
  // Repository hooks must never run for a session push.
  const ran = join(root, "repo-hook-ran");
  for (const name of ["pre-receive", "update", "post-receive", "post-update"]) {
    const hook = join(host, ".git/hooks", name);
    await Deno.writeTextFile(hook, `#!/bin/sh\necho ${name} >> ${ran}\n`);
    await Deno.chmod(hook, 0o755);
  }
  const policyFile = join(root, "git-policy.json");
  const setPolicy = (policy: unknown) => Deno.writeTextFile(policyFile, JSON.stringify(policy));
  await setPolicy({ branch: "loom/own", base: "main" });
  const socket = join(root, "git.sock");
  const relay = startGitRelay(socket, { gitDir: join(host, ".git"), policyFile, ...options });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const bridge = startGuestRelay(listener, socket);
  const url = `git://127.0.0.1:${(listener.addr as Deno.NetAddr).port}/repo`;
  return {
    root,
    host,
    url,
    socket,
    secret,
    secretBlob,
    ran,
    git,
    run,
    setPolicy,
    relay,
    clone: async (...extra: string[]) => {
      const guest = join(root, `guest-${crypto.randomUUID().slice(0, 8)}`);
      // The guest asks for protocol v2; the relay must not honour it.
      await git(
        root,
        "-c",
        "protocol.version=2",
        "clone",
        "-q",
        ...extra,
        "-b",
        "main",
        url,
        guest,
      );
      return guest;
    },
    close: async () => {
      await bridge.close();
      await relay.close();
      await Deno.remove(root, { recursive: true });
    },
  };
};
