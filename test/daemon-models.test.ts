/**
 * Model catalogues through the daemon's RPC surface: per-provider discovery at
 * start-up, Refresh models (success, failure and retry, cancellation), pinned
 * providers, and sessions keeping a model the catalogue dropped.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { LoomClient } from "@loom/client";
import type { ProviderInfo, SessionSnapshot } from "@loom/core/wire";
import { makeHarness } from "@loom/harness";

/** A `/v1/models` endpoint the test can rewrite, break or slow down. */
const endpoint = async () => {
  const state = {
    rows: [] as Array<Record<string, unknown>>,
    fail: false,
    delayMs: 0,
    hits: 0,
  };
  const server: Server = createServer((req, res) => {
    if (!(req.url ?? "").endsWith("/models")) return void res.writeHead(404).end();
    state.hits++;
    const reply = () => {
      if (state.fail) return void res.writeHead(500).end();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: state.rows }));
    };
    if (state.delayMs > 0) setTimeout(reply, state.delayMs);
    else reply();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    state,
    base: `http://127.0.0.1:${port}/v1`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start >= ms) throw new Error("condition not met in time");
    await delay(10);
  }
};

const setup = async () => {
  const alpha = await endpoint();
  const beta = await endpoint();
  alpha.state.rows = [
    { id: "a-1", display_name: "Alpha One", description: "first" },
    { id: "a-2", supported_reasoning_efforts: ["low", "high"], default_reasoning_effort: "low" },
  ];
  beta.state.rows = [{ id: "b-1", display_name: "Beta One" }];
  const h = await makeHarness({
    config: JSON.stringify({
      providers: {
        openai_compatible: {
          profiles: {
            alpha: { base_url: alpha.base },
            beta: { base_url: beta.base },
            pinned: { base_url: "http://127.0.0.1:9/v1", model: "p-1", models: ["p-1"] },
          },
        },
      },
    }),
  });
  const c = await LoomClient.connect({
    repoRoot: h.repoRoot,
    sockPath: h.sockPath,
    autospawn: false,
  });
  const list = () => c.request<ProviderInfo[]>("providers.list");
  const info = async (id: string) => (await list()).find((p) => p.id === id);
  await waitFor(async () => (await info("alpha"))?.models.length === 2);
  await waitFor(async () => (await info("beta"))?.models.length === 1);
  return {
    alpha,
    beta,
    c,
    info,
    close: async () => {
      await c.close();
      await h.cleanup();
      alpha.close();
      beta.close();
    },
  };
};

test("each provider carries its own catalogue — ids, labels, descriptions, efforts", async () => {
  const t = await setup();
  try {
    const alpha = await t.info("alpha");
    const beta = await t.info("beta");
    assert.deepEqual(alpha?.models, ["a-1", "a-2"]);
    assert.deepEqual(alpha?.modelChoices, [
      { id: "a-1", label: "Alpha One", description: "first" },
      {
        id: "a-2",
        label: "a-2",
        supportsEffort: true,
        effortLevels: ["low", "high"],
        defaultEffort: "low",
      },
    ]);
    assert.deepEqual(beta?.models, ["b-1"]);
    assert.deepEqual(
      beta?.modelChoices?.map((m) => m.label),
      ["Beta One"],
    );
    assert.equal(alpha?.modelsRefreshUnavailable, undefined);
    const pinned = await t.info("pinned");
    assert.deepEqual(pinned?.models, ["p-1"]);
    assert.match(pinned?.modelsRefreshUnavailable ?? "", /pinned/);
    await assert.rejects(
      t.c.request("providers.refreshModels", { id: "pinned" }),
      (e: unknown) => (e as { code?: string }).code === "unsupported",
    );
  } finally {
    await t.close();
  }
});

test("Refresh models rediscovers one provider; a failure keeps its list and a retry recovers", async () => {
  const t = await setup();
  try {
    t.alpha.state.rows = [{ id: "a-3", display_name: "Alpha Three" }];
    const refreshed = await t.c.request<{ models: string[] }>("providers.refreshModels", {
      id: "alpha",
    });
    assert.deepEqual(refreshed.models, ["a-3"]);
    assert.deepEqual((await t.info("alpha"))?.models, ["a-3"]);
    // The other provider is untouched.
    assert.deepEqual((await t.info("beta"))?.models, ["b-1"]);

    t.alpha.state.fail = true;
    await assert.rejects(
      t.c.request("providers.refreshModels", { id: "alpha" }),
      (e: unknown) => (e as { code?: string }).code === "provider_error",
    );
    let alpha = await t.info("alpha");
    assert.deepEqual(alpha?.models, ["a-3"], "the previous catalogue stays");
    assert.ok(alpha?.modelsError, "the failure is reported on the provider");
    assert.equal(alpha?.modelsLoading, undefined);

    t.alpha.state.fail = false;
    await t.c.request("providers.refreshModels", { id: "alpha" });
    alpha = await t.info("alpha");
    assert.deepEqual(alpha?.models, ["a-3"]);
    assert.equal(alpha?.modelsError, undefined);
  } finally {
    await t.close();
  }
});

test("a cancelled refresh settles at once, keeps the list and reports progress while it runs", async () => {
  const t = await setup();
  try {
    t.alpha.state.delayMs = 3_000;
    t.alpha.state.rows = [{ id: "late" }];
    const started = Date.now();
    const pending = t.c.request("providers.refreshModels", { id: "alpha" });
    await waitFor(async () => (await t.info("alpha"))?.modelsLoading === true);
    const cancel = await t.c.request<{ cancelled: boolean }>("providers.cancelModelRefresh", {
      id: "alpha",
    });
    assert.equal(cancel.cancelled, true);
    await assert.rejects(pending, (e: unknown) => (e as { code?: string }).code === "cancelled");
    assert.ok(Date.now() - started < 2_500, "the cancel did not wait out the slow endpoint");
    const alpha = await t.info("alpha");
    assert.deepEqual(alpha?.models, ["a-1", "a-2"]);
    assert.equal(alpha?.modelsLoading, undefined);
    // The slow reply, when it lands, changes nothing.
    await delay(3_200);
    assert.deepEqual((await t.info("alpha"))?.models, ["a-1", "a-2"]);
  } finally {
    await t.close();
  }
});

test("a session whose model left the catalogue keeps it", async () => {
  const t = await setup();
  try {
    const s = await t.c.request<SessionSnapshot>("session.createStub", {
      prompt: "keep",
      status: "idle",
      provider: "alpha",
      model: "a-1",
    });
    t.alpha.state.rows = [{ id: "a-9" }];
    await t.c.request("providers.refreshModels", { id: "alpha" });
    const after = await t.c.request<SessionSnapshot>("session.get", { id: s.id });
    assert.equal(after.model, "a-1");
    // New sessions default into the new catalogue.
    assert.equal((await t.info("alpha"))?.defaultModel, "a-9");
  } finally {
    await t.close();
  }
});
