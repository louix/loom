/**
 * The daemon's model catalogues: normalization, the on-disk cache and its
 * invalidation, per-provider discovery with refresh / failure / retry /
 * cancellation, stale-response protection, and subprocess cleanup.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  catalogueFromDiscovered,
  MODEL_CATALOGUE_LIMIT,
  modelEfforts,
  type ModelCatalogue,
} from "@loom/core/model-catalogue";
import type { DiscoveredModel } from "@loom/core/types";
import {
  catalogueKey,
  MODEL_CATALOGUE_TTL,
  ModelCatalogueCache,
} from "../backend/daemon/src/daemon/model-catalogue-cache.ts";
import {
  CatalogueCancelled,
  ModelCatalogues,
  type CatalogueSource,
} from "../backend/daemon/src/daemon/model-catalogues.ts";
import { probeOpenAiModels } from "@loom/daemon/daemon/model-catalog";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const catalogue = (...ids: string[]): ModelCatalogue => ({
  models: ids.map((id) => ({ id, label: id.toUpperCase() })),
});

test("a discovery result normalizes into a bounded, deduplicated catalogue", () => {
  const rows: DiscoveredModel[] = [
    { id: "a", label: "A\u0007model", description: "line\none", isDefault: true },
    { id: "a", label: "duplicate" },
    { id: "b", supportsEffort: true },
    { id: "c", effortLevels: ["minimal", "high"], defaultEffort: "minimal" },
    { id: "" },
  ];
  const c = catalogueFromDiscovered(rows);
  assert.deepEqual(c, {
    models: [
      { id: "a", label: "A model", description: "line one" },
      { id: "b", label: "b", supportsEffort: true },
      {
        id: "c",
        label: "c",
        supportsEffort: true,
        effortLevels: ["minimal", "high"],
        defaultEffort: "minimal",
      },
    ],
    defaultModel: "a",
  });
  assert.deepEqual(modelEfforts(c.models[1]), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(modelEfforts(c.models[2]), ["minimal", "high"]);
  assert.deepEqual(modelEfforts(c.models[0]), []);
  const many = catalogueFromDiscovered(
    Array.from({ length: MODEL_CATALOGUE_LIMIT + 10 }, (_, i) => ({ id: `m${i}` })),
  );
  assert.equal(many.models.length, MODEL_CATALOGUE_LIMIT);
});

test("the catalogue cache serves fresh entries and invalidates by TTL, identity and refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-catalogue-cache-"));
  let now = 1_000_000;
  const cache = new ModelCatalogueCache(dir, () => now);
  const signal = new AbortController().signal;
  let probes = 0;
  const probe = (c: ModelCatalogue) => () => {
    probes++;
    return Promise.resolve(c);
  };
  try {
    const id = { provider: "claude", identity: { dir: "/p", account: "x" } };
    assert.deepEqual(await cache.get(id, probe(catalogue("a")), signal), catalogue("a"));
    // Fresh: served without probing.
    assert.deepEqual(await cache.get(id, probe(catalogue("b")), signal), catalogue("a"));
    assert.equal(probes, 1);
    // Another account or provider is a different entry.
    await cache.get(
      { ...id, identity: { dir: "/p", account: "y" } },
      probe(catalogue("y")),
      signal,
    );
    await cache.get({ ...id, provider: "claude:work" }, probe(catalogue("w")), signal);
    assert.equal(probes, 3);
    assert.deepEqual(await cache.get(id, probe(catalogue("z")), signal), catalogue("a"));
    // Expired: probed again.
    now += MODEL_CATALOGUE_TTL;
    assert.deepEqual(await cache.get(id, probe(catalogue("b")), signal), catalogue("b"));
    assert.equal(probes, 4);
    // Refresh bypasses a fresh entry, and a failed refresh leaves no stale entry behind.
    await assert.rejects(
      cache.get(id, () => Promise.reject(new Error("down")), signal, true),
      /down/,
    );
    assert.deepEqual(await cache.get(id, probe(catalogue("c")), signal), catalogue("c"));
    // An empty catalogue is a failure, never cached.
    await assert.rejects(cache.get(id, probe({ models: [] }), signal, true), /no models/);
    // A corrupt entry is a miss.
    writeFileSync(join(dir, catalogueKey(id) + ".json"), "{not json");
    assert.deepEqual(await cache.get(id, probe(catalogue("d")), signal), catalogue("d"));
    // Only digests are stored — no identity material in names or contents.
    for (const name of readdirSync(dir)) assert.match(name, /^[a-f0-9]{64}\.json$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A source whose discoveries the test settles by hand, recording each abort. */
const manualSource = (identity: unknown = {}) => {
  const runs: Array<{
    result: ReturnType<typeof deferred<DiscoveredModel[]>>;
    signal: AbortSignal;
    cleaned: boolean;
  }> = [];
  const source: CatalogueSource = {
    identity: () => identity,
    discover: (signal) => {
      const run = { result: deferred<DiscoveredModel[]>(), signal, cleaned: false };
      runs.push(run);
      // Like a utility worker: an abort kills the probe, which then fails.
      signal.addEventListener("abort", () => {
        run.cleaned = true;
        run.result.reject(signal.reason);
      });
      return run.result.promise;
    },
  };
  return { source, runs };
};

const rows = (...ids: string[]): DiscoveredModel[] => ids.map((id) => ({ id, label: id }));

/** Discovery starts after the identity is read — a tick after `load`. */
const until = async (pred: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !pred(); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(pred(), "condition not met in time");
};

test("each provider discovers its own catalogue; nothing leaks between providers", async () => {
  const changes: string[] = [];
  const owner = new ModelCatalogues({ cache: null, onChange: (p) => changes.push(p) });
  const a = manualSource();
  const b = manualSource();
  owner.register("claude", a.source);
  owner.register("claude:work", b.source);
  owner.register("pinned", { unavailable: "pinned in config" });
  const pa = owner.load("claude");
  const pb = owner.load("claude:work");
  assert.equal(owner.state("claude").loading, true);
  await until(() => a.runs.length === 1 && b.runs.length === 1);
  a.runs[0]!.result.resolve(rows("opus", "sonnet"));
  b.runs[0]!.result.resolve(rows("sonnet"));
  await Promise.all([pa, pb]);
  assert.deepEqual(
    owner.state("claude").catalogue?.models.map((m) => m.id),
    ["opus", "sonnet"],
  );
  assert.deepEqual(
    owner.state("claude:work").catalogue?.models.map((m) => m.id),
    ["sonnet"],
  );
  assert.equal(owner.state("pinned").unavailable, "pinned in config");
  await assert.rejects(owner.load("pinned"), /pinned in config/);
  assert.ok(changes.includes("claude") && changes.includes("claude:work"));
  await owner.close();
});

test("refresh: success replaces, failure keeps the old list with the error, retry clears it", async () => {
  const owner = new ModelCatalogues({ cache: null, onChange: () => {} });
  const { source, runs } = manualSource();
  owner.register("codex", source);
  const first = owner.load("codex");
  await until(() => runs.length === 1);
  runs[0]!.result.resolve(rows("gpt-5"));
  await first;

  const failing = owner.load("codex", { refresh: true });
  await until(() => runs.length === 2);
  runs[1]!.result.reject(new Error("Codex is not signed in."));
  await assert.rejects(failing, /not signed in/);
  let st = owner.state("codex");
  assert.deepEqual(
    st.catalogue?.models.map((m) => m.id),
    ["gpt-5"],
  );
  assert.equal(st.error, "Codex is not signed in.");
  assert.equal(st.loading, false);

  const retry = owner.load("codex", { refresh: true });
  // A second request while one runs joins it rather than starting another.
  const joined = owner.load("codex", { refresh: true });
  await until(() => runs.length === 3);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs.length, 3);
  runs[2]!.result.resolve(rows("gpt-5", "gpt-6"));
  await Promise.all([retry, joined]);
  st = owner.state("codex");
  assert.deepEqual(
    st.catalogue?.models.map((m) => m.id),
    ["gpt-5", "gpt-6"],
  );
  assert.equal(st.error, undefined);
  await owner.close();
});

test("cancel aborts the probe, keeps the old list, and a late reply never lands", async () => {
  const owner = new ModelCatalogues({ cache: null, onChange: () => {} });
  const late = deferred<DiscoveredModel[]>();
  let calls = 0;
  owner.register("claude", {
    identity: () => ({}),
    discover: () => {
      calls++;
      // The first run ignores its signal and answers late; the second is quick.
      return calls === 2 ? late.promise : Promise.resolve(rows(calls === 1 ? "old" : "new"));
    },
  });
  await owner.load("claude");
  const stale = owner.load("claude", { refresh: true });
  assert.equal(owner.cancel("claude"), true);
  await assert.rejects(stale, CatalogueCancelled);
  assert.equal(owner.state("claude").loading, false);
  assert.deepEqual(
    owner.state("claude").catalogue?.models.map((m) => m.id),
    ["old"],
  );
  await owner.load("claude", { refresh: true });
  // The cancelled run's answer arrives after the newer one: discarded.
  late.resolve(rows("stale"));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    owner.state("claude").catalogue?.models.map((m) => m.id),
    ["new"],
  );
  assert.equal(owner.cancel("claude"), false, "nothing running to cancel");
  await owner.close();
});

test("cancelling with no catalogue yet explains how to retry; timeouts say so", async () => {
  const owner = new ModelCatalogues({ cache: null, onChange: () => {}, timeoutMs: 50 });
  const { source, runs } = manualSource();
  owner.register("claude", source);
  const p = owner.load("claude");
  await until(() => runs.length === 1);
  owner.cancel("claude");
  await assert.rejects(p, CatalogueCancelled);
  assert.equal(runs[0]!.cleaned, true, "the probe saw the abort");
  assert.match(owner.state("claude").error ?? "", /cancelled.*Refresh models/);

  const timed = owner.load("claude");
  await assert.rejects(timed, /timed out/);
  await until(() => runs[1]?.cleaned === true);
  assert.equal(runs[1]!.cleaned, true);
  assert.match(owner.state("claude").error ?? "", /timed out/);
  await owner.close();
});

test("shutdown aborts running probes and waits for them to clean up", async () => {
  const owner = new ModelCatalogues({ cache: null, onChange: () => {} });
  const { source, runs } = manualSource();
  owner.register("a", source);
  owner.register("b", source);
  const pa = owner.load("a").catch((e) => e);
  const pb = owner.load("b").catch((e) => e);
  await until(() => runs.length === 2);
  await owner.close();
  assert.ok(runs.every((r) => r.cleaned));
  assert.ok((await pa) instanceof CatalogueCancelled);
  assert.ok((await pb) instanceof CatalogueCancelled);
  await assert.rejects(owner.load("a"), CatalogueCancelled);
});

test("the owner uses the disk cache at start-up and bypasses it on refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-catalogue-owner-"));
  try {
    let calls = 0;
    const source: CatalogueSource = {
      identity: () => ({ account: "x" }),
      discover: () => Promise.resolve(rows(`gen-${++calls}`)),
    };
    const make = () => {
      const owner = new ModelCatalogues({
        cache: new ModelCatalogueCache(dir),
        onChange: () => {},
      });
      owner.register("claude", source);
      return owner;
    };
    const first = make();
    await first.load("claude");
    await first.close();
    // A restart within the TTL reuses the catalogue…
    const second = make();
    assert.equal((await second.load("claude")).models[0]?.id, "gen-1");
    // …and Refresh models really rediscovers.
    assert.equal((await second.load("claude", { refresh: true })).models[0]?.id, "gen-2");
    await second.close();
    assert.equal(calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aborted /models probe stops its worker at once", async () => {
  // An endpoint that accepts the request and never answers.
  const server = createServer(() => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const controller = new AbortController();
    const started = Date.now();
    const probe = probeOpenAiModels(`http://127.0.0.1:${port}/v1`, "", controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled by test")), 200);
    await assert.rejects(probe);
    // Well inside the worker's own 8s fetch timeout: the abort killed it.
    assert.ok(Date.now() - started < 5_000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
