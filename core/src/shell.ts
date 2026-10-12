/** A daemon-issued shell target. The client owns the terminal and child process. */
export interface SessionShell {
  token: string;
  sessionId: string;
  cwd: string;
  isolation: "none" | "vm";
  environment?: import("./environment-changes.ts").EnvironmentChanges;
  vm?: { executable: string; args: string[]; env: Record<string, string> };
}
