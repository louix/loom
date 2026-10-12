// One slow test file spread over several, so `deno test --parallel` runs its
// tests at once. Deno runs a file's tests one after another (a node:test
// `describe`'s `concurrency` included), so a file of many slow integration
// tests alone sets the suite's wall time.
//
// `<name>.test.ts` is shard 1; each `<name>.<n>.test.ts` beside it only
// imports it and is shard n. Each shard declares every count-th of the file's
// tests, in declaration order, count being the number of shard files.
// scripts/lib/test-run.ts always runs a sharded file with all its shards.

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHARD = /^(.+)\.(\d+)\.test\.(tsx?)$/;

/** The file a shard file imports, or null for any other file. */
export const shardBase = (path: string): string | null => {
  const match = basename(path).match(SHARD);
  return match ? join(dirname(path), `${match[1]}.test.${match[3]}`) : null;
};

/** The shard files beside `path`, by shard number. */
export const shardsOf = (path: string): string[] =>
  [...Deno.readDirSync(dirname(path))]
    .map((entry) => join(dirname(path), entry.name))
    .filter((file) => shardBase(file) === path)
    .sort((a, b) => shardNumber(a) - shardNumber(b));

const shardNumber = (path: string) => Number(basename(path).match(SHARD)?.[2] ?? 1);

/**
 * For the sharded file at `baseUrl` (its `import.meta.url`): whether the next
 * test it declares belongs to the shard that is running.
 */
export const mkShardFilter = (baseUrl: string): (() => boolean) => {
  const base = fileURLToPath(baseUrl);
  const shards = shardsOf(base);
  const count = shards.length + 1;
  if (shards.some((shard, i) => shardNumber(shard) !== i + 2))
    throw new Error(`${base}: shards must be numbered 2 to ${count}: ${shards.join(", ")}`);
  const running = fileURLToPath(Deno.mainModule);
  const index = shardBase(running) === base ? shardNumber(running) - 1 : 0;
  // Every shard evaluates the file the same way, so declaration order is shared.
  let mutDeclared = 0;
  return () => mutDeclared++ % count === index;
};
