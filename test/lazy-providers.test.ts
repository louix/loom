/**
 * Proves connectors load lazily: a daemon that only ever runs a `fake` session
 * must never `import()` a vendor-carrying connector package (`@loom/connector-generic`,
 * `-gemini`, `-claude`) and so never evaluate `ai` / `@ai-sdk/*` /
 * `@anthropic-ai/*`. A module-resolve hook records every specifier the process
 * resolves from the moment it is registered.
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
  s.startsWith("@modelcontextprotocol/") ||
  // the connector packages that carry a vendor SDK — a fake run must load none
  s === "@loom/connector-generic" ||
  s === "@loom/connector-gemini" ||
  s === "@loom/connector-claude" ||
  s === "@loom/aisdk" ||
  s.startsWith("@loom/aisdk/");

function vendorHits(): string[] {
  return [...resolved].filter(isVendor);
}

test("a fake-only daemon session never loads a vendor connector", async () => {
  // Imported *after* the hook — harness → Daemon → registry, none of which
  // statically import a connector or a vendor SDK.
  const { makeHarness } = await import("@loom/harness");
  const { LoomClient } = await import("@loom/client");

  const h = await makeHarness();
  try {
    const c = await LoomClient.connect({ repoRoot: h.repoRoot, sockPath: h.sockPath, autospawn: false });
    // Drives daemon → ProviderRegistry.get("fake") → the "@loom/connector-mock" thunk only.
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

  // Positive control: loading a vendor connector *does* resolve the SDK, so the
  // assertion above is not vacuous.
  await import("@loom/connector-generic");
  assert.ok(
    resolved.has("ai") && [...resolved].some((s) => s.startsWith("@ai-sdk/")),
    "expected @loom/connector-generic to resolve `ai` and `@ai-sdk/*`",
  );
});
