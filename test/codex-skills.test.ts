// test-run: own-process — exercises the fake Codex app-server with fixture environment variables.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerSession } from "@loom/connector-chatgpt/app-server";
import { CodexRpcClient } from "@loom/connector-chatgpt/rpc";
import { skillConfig } from "../connectors/chatgpt/src/skills.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

test("Codex skill selection reaches start, resume and fork without changing shared config", async () => {
  const dir = Deno.makeTempDirSync();
  const home = { dir, authJsonPath: join(dir, "auth.json") };
  const skills = ["pdf", "docx"].map((name) => {
    const path = join(dir, "skills", name, "SKILL.md");
    Deno.mkdirSync(join(dir, "skills", name), { recursive: true });
    Deno.writeTextFileSync(path, `---\nname: ${name}\ndescription: test\n---\n`);
    return { path, name, enabled: false };
  });
  const config = join(dir, "config.toml");
  Deno.writeTextFileSync(config, "# keep me\n");
  // Include another scope and a duplicate name; selection is by path, not name.
  skills.push({ path: join(dir, "repo/SKILL.md"), name: "pdf", enabled: true });
  Deno.env.set("LOOM_TEST_SKILLS", JSON.stringify(skills));
  try {
    for (const selection of [undefined, [], ["pdf"]] as const) {
      for (const mode of ["start", "resume", "fork"]) {
        const requests: Array<{ method: string; params: any }> = [];
        const launch = (spec: any) => {
          const proc = spawn(fake, spec.args, {
            cwd: dir,
            env: spec.env,
            stdio: ["pipe", "pipe", "pipe"],
          });
          const write = proc.stdin.write.bind(proc.stdin);
          proc.stdin.write = ((chunk: any, ...args: any[]) => {
            for (const line of String(chunk).trim().split("\n")) requests.push(JSON.parse(line));
            return write(chunk, ...args);
          }) as typeof proc.stdin.write;
          return proc;
        };
        const input = {
          sessionId: "s",
          cwd: dir,
          ...(selection === undefined ? {} : { skills: [...selection] }),
        };
        const session =
          mode === "start"
            ? await CodexAppServerSession.start(
                { ...input, prompt: "", mode: "default", mcpServers: [] },
                home,
                fake,
                false,
                undefined,
                launch,
              )
            : await CodexAppServerSession.resume(
                { ...input, providerRef: "fake-thread-1", forkHistory: mode === "fork" },
                home,
                fake,
                false,
                undefined,
                launch,
              );
        await session.close();
        const request = requests.find((r) => r.method === `thread/${mode}`)!;
        assert.ok(request);
        assert.deepEqual(
          request.params.config["skills.config"],
          selection === undefined
            ? undefined
            : skills.map((s, i) => ({
                path: s.path,
                enabled: selection.length > 0 && i === 0,
              })),
        );
        assert.equal(
          requests.some((r) => r.method === "skills/list"),
          selection !== undefined,
        );
        assert.equal(Deno.readTextFileSync(config), "# keep me\n");
      }
    }
    const rpc = new CodexRpcClient(
      spawn(fake, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] }),
    );
    try {
      await assert.rejects(skillConfig(rpc, dir, dir, ["../pdf"]), /not a skill directory name/);
      await assert.rejects(skillConfig(rpc, dir, dir, ["missing"]), /missing.*not found/);
      Deno.mkdirSync(join(dir, "skills/invalid"), { recursive: true });
      Deno.writeTextFileSync(join(dir, "skills/invalid/SKILL.md"), "bad frontmatter");
      await assert.rejects(skillConfig(rpc, dir, dir, ["invalid"]), /Codex could not load/);
    } finally {
      rpc.close();
    }
  } finally {
    Deno.env.delete("LOOM_TEST_SKILLS");
    Deno.removeSync(dir, { recursive: true });
  }
});
