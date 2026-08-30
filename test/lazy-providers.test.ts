/**
 * Proves the vendor SDKs are loaded lazily: a daemon that only ever runs a
 * `fake` (or Claude) session must never evaluate `ai` / `@ai-sdk/*`, and vice
 * versa. A module-resolve hook records every specifier the process resolves
 * from the moment it is registered.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const resolved = new Set<string>();
registerHooks({
  resolve(specifier, context, nextResolve) {
    resolved.add(specifier);
    return nextResolve(specifier, context);
  },
});

const isVendor = (s: string): boolean =>
  s === "ai" ||
  s.startsWith("@ai-sdk/") ||
  s.startsWith("@anthropic-ai/") ||
  s.startsWith("@modelcontextprotocol/");

function vendorHits(): string[] {
  return [...resolved].filter(isVendor);
}

test("a fake-only daemon session never evaluates a vendor SDK", async () => {
  // Imported *after* the hook — harness → Daemon → registry, none of which
  // statically import a vendor SDK any more.
  const { makeHarness } = await import("@loom/harness");
  const { LoomClient } = await import("../src/client/client.ts");

  const h = await makeHarness();
  try {
    const c = await LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });
    // This drives daemon → ProviderRegistry.get("fake") → dynamic import of fake.ts.
    await c.request("session.create", { prompt: "hello", provider: "fake" });
    await c.close();

    assert.deepEqual(
      vendorHits(),
      [],
      `a fake session pulled in vendor modules: ${vendorHits().join(", ")}`,
    );
  } finally {
    await h.cleanup();
  }

  // Positive control: loading the aisdk adapter *does* resolve the vendor SDK,
  // so the assertion above is not vacuous.
  await import("../src/provider/aisdk/adapter.ts");
  assert.ok(
    resolved.has("ai") && [...resolved].some((s) => s.startsWith("@ai-sdk/")),
    "expected the aisdk adapter to resolve `ai` and `@ai-sdk/*`",
  );
});
