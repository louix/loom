// A skill is copied into a session VM's profile or a plugin directory. A symlink
// in it must not carry a host file from outside the skill along, nor loop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { copyClaudeSkills } from "@loom/core/claude-skills";

test("copyClaudeSkills follows links within the skill only and never loops", () => {
  // given
  const root = Deno.makeTempDirSync();
  const secrets = join(root, "home", ".ssh");
  const dotfiles = join(root, "dotfiles", "pdf");
  const profile = join(root, "profile");
  const dest = join(root, "dest");
  try {
    Deno.mkdirSync(secrets, { recursive: true });
    Deno.writeTextFileSync(join(secrets, "id_ed25519"), "private key");
    Deno.mkdirSync(join(dotfiles, "ref"), { recursive: true });
    Deno.writeTextFileSync(join(dotfiles, "SKILL.md"), "pdf");
    Deno.writeTextFileSync(join(dotfiles, "ref", "forms.md"), "forms");
    Deno.symlinkSync(secrets, join(dotfiles, "keys"));
    Deno.symlinkSync(join(secrets, "id_ed25519"), join(dotfiles, "key"));
    Deno.symlinkSync("..", join(dotfiles, "ref", "up"));
    Deno.symlinkSync("ref/forms.md", join(dotfiles, "forms.md"));
    Deno.symlinkSync("ref", join(dotfiles, "reference"));
    Deno.mkdirSync(join(profile, "skills"), { recursive: true });
    Deno.symlinkSync(dotfiles, join(profile, "skills", "pdf"));

    // when
    const copy = copyClaudeSkills(profile, ["pdf"], dest);

    // then
    assert.equal(copy.kind, "copied");
    const out = join(dest, "pdf");
    assert.equal(Deno.readTextFileSync(join(out, "SKILL.md")), "pdf");
    assert.equal(Deno.readTextFileSync(join(out, "forms.md")), "forms");
    assert.equal(Deno.readTextFileSync(join(out, "reference", "forms.md")), "forms");
    assert.equal(existsSync(join(out, "keys")), false);
    assert.equal(existsSync(join(out, "key")), false);
    assert.equal(existsSync(join(out, "ref", "up")), false);
    assert.equal(copy.kind === "copied" && copy.skipped.length, 4);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
