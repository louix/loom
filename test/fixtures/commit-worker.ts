import { FakeProvider } from "../../connectors/mock/src/fake.ts";
import { commitInWorktree } from "../../core/src/commit.ts";
import type { CreateSessionOptions } from "../../core/src/types.ts";
import { serveWorker } from "../../runtime/src/worker/serve.ts";

/** Commits once through Loom's commit tool and once as an agent's shell command would. */
class CommitProvider extends FakeProvider {
  override async createSession(options: CreateSessionOptions) {
    await Deno.writeTextFile(options.cwd + "/tool.txt", "tool\n");
    const tool = commitInWorktree(options.cwd, "tool commit", { stageAll: true });
    if (!tool.ok) throw new Error(tool.text);
    await Deno.writeTextFile(options.cwd + "/shell.txt", "shell\n");
    const shell = await new Deno.Command("sh", {
      args: ["-c", "git add shell.txt && git -c commit.gpgsign=false commit -qm 'shell commit'"],
      cwd: options.cwd,
      stderr: "piped",
    }).output();
    if (!shell.success) throw new Error(new TextDecoder().decode(shell.stderr));
    return super.createSession(options);
  }
}
await serveWorker(Deno.stdin.readable, Deno.stdout.writable, async () => new CommitProvider());
Deno.exit(0);
