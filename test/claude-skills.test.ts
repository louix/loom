// A skill is copied into a session VM's profile or a plugin directory. A symlink
// in it must not carry a host file from outside the skill along, nor loop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { copyClaudeSkills } from "@loom/core/claude-skills";

interface SkillFixture {
  root: string;
  /** The skill's real directory, which `<profile>/skills/pdf` links to. */
  skill: string;
  /** A host directory outside every skill. */
  secrets: string;
  profile: string;
  dest: string;
}

const mkSkillFixture = (): SkillFixture => {
  const root = Deno.makeTempDirSync();
  const fixture = {
    root,
    skill: join(root, "dotfiles", "pdf"),
    secrets: join(root, "home", ".ssh"),
    profile: join(root, "profile"),
    dest: join(root, "dest"),
  };
  Deno.mkdirSync(fixture.secrets, { recursive: true });
  Deno.writeTextFileSync(join(fixture.secrets, "id_ed25519"), "private key");
  Deno.mkdirSync(join(fixture.skill, "ref"), { recursive: true });
  Deno.writeTextFileSync(join(fixture.skill, "ref", "forms.md"), "forms");
  Deno.mkdirSync(join(fixture.profile, "skills"), { recursive: true });
  Deno.symlinkSync(fixture.skill, join(fixture.profile, "skills", "pdf"));
  return fixture;
};

test("copyClaudeSkills follows links within the skill only and never loops", () => {
  // given
  const f = mkSkillFixture();
  try {
    Deno.writeTextFileSync(join(f.skill, "SKILL.md"), "pdf");
    Deno.symlinkSync("..", join(f.skill, "ref", "up"));
    Deno.symlinkSync("ref/forms.md", join(f.skill, "forms.md"));
    Deno.symlinkSync("ref", join(f.skill, "reference"));

    // when
    const copy = copyClaudeSkills(f.profile, ["pdf"], f.dest);

    // then
    assert.equal(copy.kind, "copied");
    const out = join(f.dest, "pdf");
    assert.equal(Deno.readTextFileSync(join(out, "SKILL.md")), "pdf");
    assert.equal(Deno.readTextFileSync(join(out, "forms.md")), "forms");
    assert.equal(Deno.readTextFileSync(join(out, "reference", "forms.md")), "forms");
    assert.equal(existsSync(join(out, "ref", "up")), false);
    // `up`, reached through `ref` and through `reference`.
    assert.equal(copy.kind === "copied" && copy.skipped.length, 2);
  } finally {
    Deno.removeSync(f.root, { recursive: true });
  }
});

test("copyClaudeSkills refuses a skill with a link out of it, and copies nothing", () => {
  // given
  const f = mkSkillFixture();
  try {
    Deno.writeTextFileSync(join(f.skill, "SKILL.md"), "pdf");
    Deno.symlinkSync(f.secrets, join(f.skill, "ref", "keys"));
    Deno.mkdirSync(join(f.dest, "pdf"), { recursive: true });
    Deno.writeTextFileSync(join(f.dest, "pdf", "SKILL.md"), "previous");

    // when
    const copy = copyClaudeSkills(f.profile, ["pdf"], f.dest);

    // then
    assert.equal(copy.kind, "invalid");
    assert.match(
      copy.kind === "invalid" ? copy.message : "",
      new RegExp(`${join(f.skill, "ref", "keys")} links outside .*, to ${f.secrets}`),
    );
    assert.equal(Deno.readTextFileSync(join(f.dest, "pdf", "SKILL.md")), "previous");
  } finally {
    Deno.removeSync(f.root, { recursive: true });
  }
});

test("copyClaudeSkills refuses a SKILL.md that links out of the skill", () => {
  // given
  const f = mkSkillFixture();
  try {
    Deno.writeTextFileSync(join(f.secrets, "SKILL.md"), "elsewhere");
    Deno.symlinkSync(join(f.secrets, "SKILL.md"), join(f.skill, "SKILL.md"));

    // when
    const copy = copyClaudeSkills(f.profile, ["pdf"], f.dest);

    // then
    assert.equal(copy.kind, "invalid");
    assert.match(copy.kind === "invalid" ? copy.message : "", /SKILL\.md links outside/);
    assert.equal(existsSync(join(f.dest, "pdf")), false);
  } finally {
    Deno.removeSync(f.root, { recursive: true });
  }
});
