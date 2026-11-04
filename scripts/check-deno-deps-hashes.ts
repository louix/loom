/**
 * Pre-commit guard: a staged deno.lock change must re-pin flake.nix's denoDeps
 * hash for every system. Each system fetches its own platform packages, so one
 * stale hash breaks `nix profile upgrade loom` there and nowhere else.
 */
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const systems = ["x86_64-linux", "aarch64-linux", "aarch64-darwin"];
const git = async (args: string[]) => {
  const result = await Deno.spawnAndWait("git", args, {
    cwd: root,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  });
  return { success: result.success, text: new TextDecoder().decode(result.stdout) };
};

// `--quiet` exits 1 when deno.lock has staged changes.
if ((await git(["diff", "--cached", "--quiet", "--", "deno.lock"])).success) Deno.exit(0);
const head = await git(["show", "HEAD:flake.nix"]);
if (!head.success) Deno.exit(0);
const staged = await git(["show", ":flake.nix"]);

const denoDepsHashes = (flake: string) => {
  const block = flake.match(/outputHash = \{([^}]*)\}\.\$\{hostSystem\};/)?.[1];
  if (!block) throw new Error("Could not find denoDeps' outputHash block in flake.nix");
  return Object.fromEntries(
    systems.map((system) => [system, block.match(new RegExp(`${system} = "([^"]+)"`))?.[1]]),
  );
};
const before = denoDepsHashes(head.text);
const after = denoDepsHashes(staged.text);
const stale = systems.filter((system) => before[system] === after[system]);
if (stale.length > 0) {
  console.error(
    `deno.lock changed but flake.nix's denoDeps outputHash was not updated for: ${stale.join(", ")}\n` +
      "Run `nix build .#denoDeps` on each listed system and pin the hash its mismatch reports\n" +
      "(skip with `git commit --no-verify` if this lockfile change cannot affect what is fetched).",
  );
  Deno.exit(1);
}
