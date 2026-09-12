import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { makeLogger } from "../core/src/logger.ts";

test(
  "ChatGPT worker initializes with auth_path and host isolation policy",
  { timeout: 15_000 },
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "loom-chatgpt-init-" });
    try {
      const { CONNECTORS } = await import("../cli/src/connectors.ts");
      const module = await CONNECTORS["@loom/connector-chatgpt"]!();
      // Capabilities need no credentials or vendor process. These paths need not exist.
      const provider = await module.createProvider({
        id: "chatgpt-init",
        config: {
          sdk: "chatgpt",
          authPath: `${dir}/auth.json`,
          codexCliPath: `${dir}/codex`,
          sessionVm: { artifact: `${dir}/artifact`, smolvm: "smolvm", repoRoot: dir },
          workerAllowedHosts: ["chatgpt.com"],
        },
        logger: makeLogger("test"),
      });
      try {
        assert.equal(provider.capabilities.liveModeSwitch, true);
      } finally {
        await provider.close?.();
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

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
