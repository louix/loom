import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { makeLogger } from "../core/src/logger.ts";

test("CLI mock manifest executes the connector only in a child", { timeout: 15_000 }, async () => {
  const resolved: string[] = [];
  const hook = registerHooks({
    resolve(specifier, context, next) {
      resolved.push(specifier);
      return next(specifier, context);
    },
  });
  try {
    const { CONNECTORS } = await import("../cli/src/connectors.ts");
    const module = await CONNECTORS["@loom/connector-mock"]!();
    const provider = await module.createProvider({
      id: "fake",
      config: {},
      logger: makeLogger("test"),
    });
    const session = await provider.createSession({
      sessionId: "manifest",
      cwd: Deno.cwd(),
      prompt: "title",
      mode: "default",
      mcpServers: [],
      oneShot: true,
    });
    try {
      assert.deepEqual(
        (await Array.fromAsync(session.events())).map((e) => e.type),
        ["assistant_text", "result"],
      );
      assert.equal(
        resolved.some(
          (s) =>
            s === "@loom/connector-mock" ||
            s.includes("connectors/mock/") ||
            s === "ai" ||
            s.startsWith("@ai-sdk/"),
        ),
        false,
      );
    } finally {
      await session.close();
    }
    // Positive control proves the hook observes connector loads in this process.
    await import("../connectors/mock/src/index.ts");
    assert.equal(
      resolved.some((s) => s.includes("connectors/mock/")),
      true,
    );
  } finally {
    hook.deregister();
  }
});

test(
  "CLI Claude factory loads its adapter and SDK only in the worker",
  { timeout: 15_000 },
  async () => {
    const profile = await Deno.makeTempDir({ prefix: "loom-claude-manifest-" });
    const resolved: string[] = [];
    const hook = registerHooks({
      resolve(specifier, context, next) {
        resolved.push(specifier);
        return next(specifier, context);
      },
    });
    try {
      const { CONNECTORS } = await import("../cli/src/connectors.ts");
      const module = await CONNECTORS["@loom/connector-claude"]!();
      const provider = await module.createProvider({
        id: "claude:test",
        config: { configDir: profile },
        logger: makeLogger("test"),
      });
      assert.equal(provider.capabilities.rewind, true);
      assert.equal(
        resolved.some((s) => s.includes("connectors/claude/") || s.startsWith("@anthropic-ai/")),
        false,
      );
      await import("../connectors/claude/src/index.ts");
      assert.equal(
        resolved.some((s) => s.startsWith("@anthropic-ai/")),
        true,
      );
    } finally {
      hook.deregister();
      await Deno.remove(profile, { recursive: true });
    }
  },
);
