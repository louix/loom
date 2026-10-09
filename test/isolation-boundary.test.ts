import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../", import.meta.url));
// The supervisor is spawned, not imported: graph it explicitly.
const entries = [
  "isolation/src/coordinator.ts",
  "isolation/src/environment.ts",
  "isolation/src/errors.ts",
  "isolation/src/execution-leases.ts",
  "isolation/src/storage.ts",
  "runtime/src/session-vm/plain-exec.ts",
  "runtime/src/session-vm/supervisor.ts",
];
// Conversation, session protocol and event contracts; none may enter VM isolation.
const sessionContracts =
  /^core\/src\/(types|events|wire|wire-decode|rpc-params|interaction|connector|worker|transcript|session-state|session-init|session-inspection|session-order|status|tokens|commit|channel)\.ts$/;

const run = async (args: string[], cwd: string) => {
  const result = await new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
};
const graph = async (entry: string) => {
  const info = JSON.parse(await run(["info", "--json", entry], source)) as {
    modules: { specifier: string; error?: string }[];
  };
  const files: string[] = [];
  const external: string[] = [];
  for (const module of info.modules) {
    assert.equal(module.error, undefined, module.error);
    if (module.specifier.startsWith("file:"))
      files.push(relative(source, fileURLToPath(module.specifier)));
    else external.push(module.specifier);
  }
  return { files, external };
};

Deno.test("isolation imports only itself and node built-ins", async () => {
  for (const entry of entries.filter((path) => path.startsWith("isolation/"))) {
    const { files, external } = await graph(entry);
    for (const path of files) assert.match(path, /^isolation\/src\//, entry + " imports " + path);
    for (const specifier of external)
      assert.match(specifier, /^node:/, entry + " imports " + specifier);
  }
});

Deno.test("plain VM execution and its supervisor check without Loom application sources", async () => {
  const files = new Set<string>();
  for (const entry of entries) {
    for (const path of (await graph(entry)).files) {
      assert.match(path, /^(core|runtime|isolation)\//, "Application dependency: " + path);
      assert.doesNotMatch(path, sessionContracts, "Session contract in VM isolation: " + path);
      assert.doesNotMatch(path, /^runtime\/src\/(worker|mcp)\//, "Worker dependency: " + path);
      files.add(path);
    }
  }
  // Copy every source in the transitive graph, including type-only dependencies,
  // so a reference back into the application fails to resolve.
  const root = await Deno.makeTempDir({ prefix: "loom-isolation-boundary-" });
  try {
    for (const path of files) {
      await Deno.mkdir(dirname(join(root, path)), { recursive: true });
      await Deno.copyFile(join(source, path), join(root, path));
    }
    await Deno.copyFile(join(source, "isolation/deno.json"), join(root, "isolation/deno.json"));
    const config = JSON.parse(await Deno.readTextFile(join(source, "deno.json")));
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({
        workspace: ["isolation"],
        nodeModulesDir: "auto",
        imports: { zod: config.imports.zod },
        compilerOptions: config.compilerOptions,
      }),
    );
    await run(["check", "--config", "deno.json", ...files], root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
