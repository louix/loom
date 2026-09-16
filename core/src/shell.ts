/** A daemon-issued shell target. The client owns the terminal and child process. */
export interface SessionShell {
  token: string;
  sessionId: string;
  cwd: string;
  isolation: "local" | "vm";
  vm?: { executable: string; args: string[]; env: Record<string, string> };
}
