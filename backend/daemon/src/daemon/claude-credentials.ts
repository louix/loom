/** Read only the selected Claude profile. The CLI remains the credential writer. */
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
export const readClaudeCredentials = async (
  profile: string,
  lookup: ((service: string) => Promise<unknown>) | undefined = Deno.build.os === "darwin"
    ? keychain
    : undefined,
): Promise<unknown> => {
  if (lookup) {
    for (const service of claudeCredentialServices(profile)) {
      try {
        const value = await lookup(service);
        if (value && typeof value === "object" && !Array.isArray(value)) return value;
      } catch {
        /* The CLI also falls back to its file when Keychain is unavailable. */
      }
    }
  }
  return JSON.parse(await Deno.readTextFile(join(profile, ".credentials.json")));
};
