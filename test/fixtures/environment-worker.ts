import { FakeProvider } from "../../connectors/mock/src/fake.ts";
import type { CreateSessionOptions, SessionRef } from "../../core/src/types.ts";
import { serveWorker } from "../../runtime/src/worker/serve.ts";

const record = async (cwd: string) => {
  // Simulate a native launcher whose profile discarded the project PATH.
  const result = await new Deno.Command("sh", {
    args: [
      "-c",
      'loom_bash=$(command -v bash); PATH=/usr/bin:/bin; export PATH; exec "$loom_bash" -c project-tool',
    ],
    cwd,
    stdout: "piped",
  }).output();
  if (!result.success) throw new Error("project-tool failed");
  await Deno.writeTextFile(cwd + "/worker-environment", new TextDecoder().decode(result.stdout));
  await Deno.writeTextFile(cwd + "/worker-private", Deno.env.get("TMPDIR") ?? "missing");
};
class EnvironmentProvider extends FakeProvider {
  override async createSession(options: CreateSessionOptions) {
    await record(options.cwd);
    return super.createSession(options);
  }
  override async resumeSession(options: SessionRef) {
    await record(options.cwd);
    return super.resumeSession(options);
  }
}
await serveWorker(Deno.stdin.readable, Deno.stdout.writable, async () => new EnvironmentProvider());
Deno.exit(0);
