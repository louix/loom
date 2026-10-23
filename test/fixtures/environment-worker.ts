import { FakeProvider } from "../../connectors/mock/src/fake.ts";
import type { CreateSessionOptions, SessionRef } from "../../core/src/types.ts";
import { serveWorker } from "../../runtime/src/worker/serve.ts";

const record = async (cwd: string, projectDir?: string) => {
  if (!projectDir || Deno.env.get("LOOM_PROJECT_DIR") !== projectDir)
    throw new Error("Missing project files environment");
  try {
    Deno.readDirSync(projectDir + "/..");
    throw new Error("Worker can list other repositories' project files");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotCapable)) throw error;
  }
  const report = projectDir + "/worker-report";
  await Deno.writeTextFile(report, Deno.env.get("PROJECT_VALUE")!, { append: true });
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
    await record(options.cwd, options.projectDir);
    return super.createSession(options);
  }
  override async resumeSession(options: SessionRef) {
    await record(options.cwd, options.projectDir);
    return super.resumeSession(options);
  }
}
await serveWorker(Deno.stdin.readable, Deno.stdout.writable, async () => new EnvironmentProvider());
Deno.exit(0);
