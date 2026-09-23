/** Read and renew only the selected Claude profile, preserving its other credentials. */
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";

export const claudeCredentialServices = (profile: string, home = homedir()): string[] => {
  const path = resolve(profile);
  const suffix = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return [
    `Claude Code-credentials-${suffix}`,
    ...(path === join(home, ".claude") ? ["Claude Code-credentials"] : []),
  ];
};
const keychain = async (service: string): Promise<unknown> => {
  const child = Deno.spawn(
    "/usr/bin/security",
    ["find-generic-password", "-a", userInfo().username, "-w", "-s", service],
    { stdin: "null", stdout: "piped", stderr: "null" },
  );
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, 3000);
  try {
    const result = await child.output();
    return result.success ? JSON.parse(new TextDecoder().decode(result.stdout)) : undefined;
  } finally {
    clearTimeout(timer);
  }
};
export const readClaudeCredentialStore = async (
  profile: string,
  lookup: ((service: string) => Promise<unknown>) | undefined = Deno.build.os === "darwin"
    ? keychain
    : undefined,
): Promise<ClaudeCredentialStore> => {
  if (lookup) {
    for (const service of claudeCredentialServices(profile)) {
      try {
        const value = await lookup(service);
        if (value && typeof value === "object" && !Array.isArray(value)) return { value, service };
      } catch {
        /* The CLI also falls back to its file when Keychain is unavailable. */
      }
    }
  }
  return { value: JSON.parse(await Deno.readTextFile(join(profile, ".credentials.json"))) };
};

export interface ClaudeCredentialStore {
  value: unknown;
  /** The exact Keychain entry that supplied the credentials; absent for file storage. */
  service?: string;
}
export const readClaudeCredentials = async (
  profile: string,
  lookup?: (service: string) => Promise<unknown>,
): Promise<unknown> => (await readClaudeCredentialStore(profile, lookup)).value;

export const writeClaudeCredentialStore = async (
  profile: string,
  store: ClaudeCredentialStore,
  value: unknown,
): Promise<void> => {
  const serialized = JSON.stringify(value);
  if (store.service) {
    // Match the CLI's security(1) format, using stdin to keep normal-sized
    // credentials out of process arguments. security -i has a 4096-byte limit.
    const username = userInfo().username;
    const quote = (s: string) => '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
    const hex = Buffer.from(serialized).toString("hex");
    const command =
      "add-generic-password -U -a " +
      quote(username) +
      " -s " +
      quote(store.service) +
      " -X " +
      quote(hex) +
      "\n";
    const stdin = new TextEncoder().encode(command);
    const interactive = stdin.length <= 4032;
    const child = new Deno.Command("/usr/bin/security", {
      args: interactive
        ? ["-i"]
        : ["add-generic-password", "-U", "-a", username, "-s", store.service, "-X", hex],
      stdin: interactive ? "piped" : "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* exited */
      }
    }, 3000);
    try {
      if (interactive) {
        const writer = child.stdin.getWriter();
        try {
          await writer.write(stdin);
          await writer.close();
        } finally {
          writer.releaseLock();
        }
      }
      if (!(await child.status).success) throw new Error("Claude Keychain update failed");
    } finally {
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* exited */
      }
      await child.status;
    }
    return;
  }
  const path = join(profile, ".credentials.json");
  const temporary = await Deno.makeTempFile({
    dir: profile,
    prefix: ".credentials-",
    suffix: ".tmp",
  });
  try {
    await Deno.chmod(temporary, 0o600);
    await Deno.writeTextFile(temporary, serialized);
    await Deno.rename(temporary, path);
  } finally {
    await Deno.remove(temporary).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
};
