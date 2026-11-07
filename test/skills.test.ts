import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerProvider } from "../backend/daemon/src/daemon/worker-provider.ts";
import { mockLaunchSpec } from "../backend/daemon/src/daemon/worker-launch.ts";
import { loadSkills, loomSkillsDirectory, withSkillInstructions } from "@loom/core/skills";
import type { CreateSessionOptions, SessionRef } from "@loom/core/types";

Deno.test("a missing Loom skill reports the shared directory across the worker boundary", async () => {
  const provider = await WorkerProvider.create("fake", mockLaunchSpec);
  await assert.rejects(
    provider.createSession({
      sessionId: "missing-skill",
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      prompt: "",
      mode: "default",
      mcpServers: [],
      skills: ["missing-skill-fixture"],
    }),
    /Loom could not load its skills.*Provider-specific skill directories are not used/,
  );
});

Deno.test("Loom skills use the XDG config directory, never provider config directories", () => {
  assert.equal(
    loomSkillsDirectory({ HOME: "/tmp/loom-home" }),
    "/tmp/loom-home/.config/loom/skills",
  );
  assert.equal(
    loomSkillsDirectory({
      HOME: "/tmp/loom-home",
      XDG_CONFIG_HOME: "/tmp/loom-config",
      CODEX_HOME: "/tmp/codex",
      CLAUDE_CONFIG_DIR: "/tmp/claude",
    }),
    "/tmp/loom-config/loom/skills",
  );
  assert.equal(
    loomSkillsDirectory({ HOME: "/tmp/loom-home", XDG_CONFIG_HOME: "relative" }),
    "/tmp/loom-home/.config/loom/skills",
  );
});

Deno.test("Loom skill discovery parses YAML, filters selections and refreshes instructions", () => {
  const root = Deno.makeTempDirSync();
  const directory = join(root, "skills");
  const input: CreateSessionOptions = Object.freeze({
    sessionId: "s",
    cwd: root,
    prompt: "",
    mode: "default",
    mcpServers: [],
    agentPrompt: "Existing instructions",
  });
  try {
    assert.deepEqual(loadSkills(directory), []);
    assert.throws(() => loadSkills(directory, ["pdf"]), /pdf.*not found/);
    for (const name of ["pdf", "coding-style"]) {
      Deno.mkdirSync(join(directory, name), { recursive: true });
      Deno.writeTextFileSync(
        join(directory, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: >-\n  Use for writing:\n  code and documents.\n---\nFULL BODY NOT IN CATALOG`,
      );
    }
    Deno.writeTextFileSync(join(directory, "README.md"), "Installation notes");
    assert.deepEqual(
      loadSkills(directory).map((skill) => skill.name),
      ["coding-style", "pdf"],
    );
    assert.equal(
      loadSkills(directory, ["pdf"])[0]?.description,
      "Use for writing: code and documents.",
    );
    assert.deepEqual(loadSkills(directory, []), []);
    assert.throws(() => loadSkills(directory, ["../pdf"]), /not a skill directory name/);
    const prepared = withSkillInstructions(input, directory);
    assert.match(prepared.agentPrompt ?? "", /Existing instructions.*\n\nLoom skills/);
    assert.match(prepared.agentPrompt ?? "", /coding-style/);
    assert.ok(prepared.agentPrompt?.includes(join(directory, "pdf", "SKILL.md")));
    assert.ok(!prepared.agentPrompt?.includes("FULL BODY"));
    assert.equal(input.agentPrompt, "Existing instructions");
    assert.equal(
      withSkillInstructions({ ...input, skills: [] }, directory).agentPrompt,
      input.agentPrompt,
    );
    assert.equal(
      withSkillInstructions({ ...input, oneShot: true, skills: ["missing"] }, directory)
        .agentPrompt,
      input.agentPrompt,
    );
    Deno.writeTextFileSync(
      join(directory, "pdf", "SKILL.md"),
      '---\nname: pdf\ndescription: "Updated: PDF workflow"\n---\nNew body',
    );
    const resumed = withSkillInstructions<SessionRef>(
      { sessionId: "s", cwd: root, providerRef: "thread", skills: ["pdf"] },
      directory,
    );
    assert.match(resumed.agentPrompt ?? "", /Updated: PDF workflow/);
    assert.ok(!resumed.agentPrompt?.includes("coding-style"));
    Deno.writeTextFileSync(join(directory, "pdf", "SKILL.md"), "not a skill");
    assert.throws(() => loadSkills(directory, ["pdf"]), /requires YAML/);
    assert.equal(loadSkills(directory, ["coding-style"]).length, 1);
    Deno.writeTextFileSync(
      join(directory, "pdf", "SKILL.md"),
      "---\nname: wrong\ndescription: test\n---\n",
    );
    assert.throws(() => loadSkills(directory, ["pdf"]), /requires name: pdf/);
    Deno.writeTextFileSync(
      join(directory, "pdf", "SKILL.md"),
      "---\nname: pdf\ndescription: [\n---\n",
    );
    assert.throws(() => loadSkills(directory, ["pdf"]), /invalid YAML/);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
