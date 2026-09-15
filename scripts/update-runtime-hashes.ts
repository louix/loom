/** Maintainer operation: build and pin Apple Silicon guest runtime artifacts. */
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (Deno.build.os !== "darwin" || Deno.build.arch !== "aarch64")
  throw new Error("Run runtime:hashes on an Apple Silicon Mac with Nix installed");
const root = fileURLToPath(new URL("../", import.meta.url));
const flake = "git+" + new URL("../", import.meta.url).href.replace(/\/$/, "");
const prefix = ["--extra-experimental-features", "nix-command flakes"];
const run = (args: string[]) =>
  Deno.spawnAndWait("nix", [...prefix, ...args], {
    cwd: root,
    env: { LOOM_HASH_SOURCE: flake },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const checked = async (args: string[]) => {
  const result = await run(args);
  if (!result.success) throw new Error(decode(result.stderr));
  return decode(result.stdout).trim();
};
const currentSource = () => checked(["eval", "--raw", ".#lib.guestRuntimeSource"]);
const source = await currentSource();
const currentRecipe = () => checked(["eval", "--raw", ".#lib.guestRuntimeRecipe"]);
const recipe = await currentRecipe();
const destination = join(root, "packaging/macos/runtime-hashes.json");
const previous = JSON.parse(await Deno.readTextFile(destination));
const runtimes: Record<string, string> =
  previous.source === source && previous.recipe === recipe ? previous.runtimes : {};
const publish = async () => {
  if ((await currentSource()) !== source || (await currentRecipe()) !== recipe)
    throw new Error("Guest source changed during the builds; hashes were not updated");
  const temporary = await Deno.makeTempFile({
    dir: join(root, "packaging/macos"),
    prefix: ".hashes-",
  });
  try {
    await Deno.writeTextFile(
      temporary,
      JSON.stringify({ source, recipe, runtimes }, null, 2) + "\n",
    );
    await Deno.rename(temporary, destination);
  } finally {
    await Deno.remove(temporary).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
};
for (const runtime of ["tilth-runtime", "session-runtime"]) {
  const hash = runtimes[runtime];
  if (hash && /^sha256-[A-Za-z0-9+/]{43}=$/.test(hash)) {
    const path = await Deno.spawnAndWait(
      "nix-store",
      ["--print-fixed-path", "--recursive", "sha256", hash, "lvm"],
      { stdout: "piped", stderr: "piped" },
    );
    if (path.success && (await run(["path-info", decode(path.stdout).trim()])).success) {
      console.error(`${runtime}: reusing the verified local artifact`);
      continue;
    }
  }
  console.error(`Building ${runtime}; a fresh builder may take several minutes...`);
  const builder = await checked([
    "build",
    "--impure",
    "--no-link",
    "--print-out-paths",
    "--expr",
    `
    let f = builtins.getFlake (builtins.getEnv "LOOM_HASH_SOURCE");
    in (import (f.outPath + "/packaging/macos/runtime.nix") {
      pkgs = f.inputs.nixpkgs.legacyPackages.aarch64-darwin;
      smolvm = f.packages.aarch64-darwin.smolvm;
      source = f.lib.guestRuntimeSource;
      runtime = "${runtime}";
      hash = f.inputs.nixpkgs.lib.fakeHash;
    }).prepare
  `,
  ]);
  const scratch = await Deno.makeTempDir({ dir: "/tmp", prefix: "loom-runtime-" });
  try {
    const artifact = join(scratch, "artifact");
    const built = await Deno.spawnAndWait(join(builder, "bin/loom-build-runtime"), [artifact], {
      clearEnv: true,
      env: { TMPDIR: "/tmp" },
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!built.success) throw new Error(`Could not build ${runtime}`);
    // This is the same content address/name as the fixed-output package.
    const stored = await checked(["store", "add-path", "--name", "lvm", artifact]);
    runtimes[runtime] = await checked(["hash", "path", stored]);
    await publish();
    console.error(`${runtime}: ${runtimes[runtime]}`);
  } finally {
    await Deno.spawnAndWait("/bin/chmod", ["-R", "u+w", scratch]);
    await Deno.remove(scratch, { recursive: true });
  }
}
console.error("Runtime hashes updated. Review and commit packaging/macos/runtime-hashes.json.");
