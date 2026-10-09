import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_PALETTE, providerColor } from "@loom/daemon/daemon/provider-color";

const ids = ["openai", "deepseek", "claude:work", "claude:personal", "local-llama", "gemini"];

test("a provider's default colour depends on its id alone, not list order", () => {
  const forward = new Map(ids.map((id) => [id, providerColor(id)]));
  const backward = new Map([...ids].reverse().map((id) => [id, providerColor(id)]));
  const subset = new Map(ids.slice(2).map((id) => [id, providerColor(id)]));
  for (const id of ids) {
    assert.equal(backward.get(id), forward.get(id), `${id} keeps its colour when reordered`);
    if (subset.has(id)) assert.equal(subset.get(id), forward.get(id), `${id} survives removals`);
    assert.ok((PROVIDER_PALETTE as readonly string[]).includes(forward.get(id)!));
  }
  // Named Claude profiles hash their own `claude:<slug>` ids, so profiles of
  // one provider kind can differ (these two happen not to collide).
  assert.notEqual(providerColor("claude:work"), providerColor("claude:personal"));
});

test("default colours are the same after a restart", async () => {
  // Pinned: an unseeded hash, so these are what any process computes.
  assert.deepEqual(
    ids.map((id) => providerColor(id)),
    ["green", "magenta", "yellow", "green", "yellow", "cyan"],
  );
  // And a fresh process agrees, rather than this one merely agreeing with itself.
  const module = new URL("../backend/daemon/src/daemon/provider-color.ts", import.meta.url).href;
  const script = `const { providerColor } = await import(${JSON.stringify(module)});
console.log(JSON.stringify(${JSON.stringify(ids)}.map((id) => providerColor(id))));`;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", script],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  assert.ok(out.success);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(out.stdout)),
    ids.map((id) => providerColor(id)),
  );
});

test("an explicit colour overrides the default and an empty one does not", () => {
  assert.equal(providerColor("openai", "red"), "red");
  assert.equal(providerColor("openai", "#ff8800"), "#ff8800");
  assert.equal(providerColor("openai", ""), providerColor("openai"));
});
