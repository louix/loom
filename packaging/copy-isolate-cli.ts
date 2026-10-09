import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy loom-isolate and exactly its module graph into a standalone package root,
 * with a deno.json/deno.lock limited to what that graph imports. The copy fails if
 * the graph reaches Loom's client, daemon, TUI, connectors, harness, agent workers
 * or conversation/session wire contracts.
 */
// Spawned rather than imported: the VM supervisor and the environment probe.
export const isolateCliEntries = [
  "cli/src/loom-isolate.ts",
  "runtime/src/session-vm/supervisor.ts",
  "runtime/src/session-vm/capture-environment.ts",
];
const allowed =
  /^(cli\/src\/loom-isolate\.ts|cli\/src\/isolate\/[^/]+\.ts|(core|runtime|isolation)\/src\/)/;
const forbidden = [
  /^runtime\/src\/(worker|mcp)\//,
  // Conversation, session protocol and event contracts.
  /^core\/src\/(types|events|wire|wire-decode|rpc-params|interaction|connector|worker|transcript|session-state|session-init|session-inspection|session-order|status|tokens|commit|channel)\.ts$/,
];

export const isolateCliGraph = async (source: string) => {
  const files = new Set<string>();
  const imported = new Set<string>();
  for (const entry of isolateCliEntries) {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", entry],
      cwd: source,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    const graph = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      modules: { specifier: string; error?: string; dependencies?: { specifier: string }[] }[];
    };
    for (const module of graph.modules) {
      if (module.error) throw new Error(module.error);
      for (const dependency of module.dependencies ?? []) imported.add(dependency.specifier);
      if (!module.specifier.startsWith("file:")) continue;
      const path = relative(source, fileURLToPath(module.specifier));
      if (!allowed.test(path) || forbidden.some((pattern) => pattern.test(path)))
        throw new Error("Application dependency in loom-isolate: " + path);
      files.add(path);
    }
  }
  return { files: [...files].sort(), imported };
};

export const copyIsolateCli = async (source: string, output: string): Promise<string[]> => {
  source = resolve(source);
  output = resolve(output);
  const { files, imported } = await isolateCliGraph(source);
  for (const path of files) {
    await Deno.mkdir(dirname(join(output, path)), { recursive: true });
    await Deno.copyFile(join(source, path), join(output, path));
  }
  const config = JSON.parse(await Deno.readTextFile(join(source, "deno.json")));
  const imports: Record<string, string> = {};
  for (const [name, target] of Object.entries(config.imports) as [string, string][])
    if (imported.has(name)) imports[name] = target;
  const npm = Object.values(imports);
  // Workspace package names become plain mappings to the copied sources.
  for (const pkg of config.workspace as string[]) {
    const manifest = JSON.parse(await Deno.readTextFile(join(source, pkg, "deno.json")));
    for (const [key, target] of Object.entries(manifest.exports ?? {}) as [string, string][]) {
      const path = join(pkg, target);
      if (files.includes(path))
        imports[manifest.name + (key === "." ? "" : key.slice(1))] = "./" + path;
    }
  }
  const write = (path: string, text: string) => Deno.writeTextFile(join(output, path), text);
  await write(
    "deno.json",
    JSON.stringify(
      { nodeModulesDir: "auto", imports, compilerOptions: config.compilerOptions },
      null,
      2,
    ) + "\n",
  );
  const lock = JSON.parse(await Deno.readTextFile(join(source, "deno.lock")));
  lock.specifiers = Object.fromEntries(npm.map((spec) => [spec, lock.specifiers[spec]]));
  lock.workspace = { dependencies: npm };
  await write("deno.lock", JSON.stringify(lock, null, 2) + "\n");
  return files;
};

if (import.meta.main) {
  const [output] = Deno.args;
  if (!output) throw new Error("Pass the loom-isolate package output directory");
  await copyIsolateCli(fileURLToPath(new URL("../", import.meta.url)), output);
}
