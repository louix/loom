/**
 * Live daemon acceptance against real provider logins, through the daemon's own
 * RPC surface (what the TUI drives). Each check runs an embedded daemon in a
 * throwaway repository with private XDG state/data/cache/config and its own socket;
 * it never touches the user's daemon or ~/.config/loom.
 *
 * Credentials are used in place, read-only, through the normal provider paths:
 * nothing here copies a credential file or forces a renewal. Supply them
 * explicitly; ambient provider variables are removed.
 *
 *   LOOM_LIVE_CLAUDE_PROFILE  Claude config dir (exposed as provider claude:personal)
 *   LOOM_LIVE_CODEX_PROFILE   CODEX_HOME            (exposed as provider codex)
 *   LOOM_LIVE_CODEX_CLI       host codex executable
 *   LOOM_LIVE_ARTIFACT        session runtime built from this tree (isolation check)
 *   LOOM_LIVE_SMOLVM          smolvm executable                  (isolation check)
 *
 * Usage: deno run -A scripts/test-live-daemon-acceptance.ts <check>
 *   isolation-claude | isolation-codex  create, tool write, idle suspension, resume, stop
 *   codex-plan                          native Plan → Loom plan review → implement
 *   models                              discovery + Refresh models, per provider
 *   cost                                Claude cost across a daemon restart
 *   forks                               native Claude/Codex forks, Claude→Codex handoff
 *   queue-claude | queue-codex          a message folded in at a Bash boundary; three
 *                                       held by an interrupt, released in order
 *   agents-claude | agents-codex        Loom agents (docs/loom-agents.md): no native
 *                                       sub-agent tools, loom-agents present; a `self`
 *                                       child started, notified up, read; (Claude) a
 *                                       supervisor message steered down
 *   codex-tools [model]                 a Codex thread's own tools: no native sub-agents,
 *                                       or (a v2 model, openai/codex#50880) listed but no
 *                                       spawn starts a thread
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { Daemon } from "../backend/daemon/src/daemon/daemon.ts";
import { CONNECTORS } from "../cli/src/connectors.ts";
import { LoomClient } from "@loom/client";
import type { SessionSnapshot } from "@loom/core/wire";
import { setLogLevel } from "@loom/core/logger";
import { gitFixture } from "./lib/git-fixture.ts";
import { listVms } from "../runtime/src/session-vm/inventory.ts";

const check = Deno.args[0] ?? "";
const env = (name: string) => Deno.env.get(name) || undefined;
const claudeProfile = env("LOOM_LIVE_CLAUDE_PROFILE");
const codexProfile = env("LOOM_LIVE_CODEX_PROFILE");
const codexCli = env("LOOM_LIVE_CODEX_CLI");
const artifact = env("LOOM_LIVE_ARTIFACT");
const smolvm = env("LOOM_LIVE_SMOLVM");
for (const name of [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENAI_API_KEY",
])
  Deno.env.delete(name);
assert(claudeProfile && codexProfile && codexCli, "Set the LOOM_LIVE_* provider variables");
setLogLevel("warn");

const CLAUDE = "claude:personal";
const CODEX = "codex";
const f = await gitFixture();
for (const [variable, dir] of [
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_STATE_HOME", "state"],
  ["XDG_DATA_HOME", "data"],
  ["XDG_CACHE_HOME", "cache"],
] as const) {
  await Deno.mkdir(join(f.root, dir), { recursive: true });
  Deno.env.set(variable, join(f.root, dir));
}
const configFile = join(f.root, "config/loom/config.jsonc");
const log = (what: string, data: unknown = "") =>
  console.log(`[${check}] ${what}` + (data === "" ? "" : " " + JSON.stringify(data)));

const writeConfig = async (opts: {
  vm?: boolean;
  idleMinutes?: number;
  codexCli?: string;
  claudeCli?: string;
}) => {
  const runtime = artifact && smolvm ? { artifact, smolvm } : undefined;
  await Deno.mkdir(join(f.root, "config/loom"), { recursive: true });
  await Deno.writeTextFile(
    configFile,
    JSON.stringify(
      {
        default_provider: CLAUDE,
        providers: {
          claude: {
            setting_sources: [],
            ...(opts.claudeCli ? { cli_path: opts.claudeCli } : {}),
            profiles: { personal: { config_dir: claudeProfile } },
          },
          codex: { config_dir: codexProfile, cli_path: opts.codexCli ?? codexCli },
        },
        session: {
          titles: { enabled: false },
          commit_reminder: { enabled: false },
          isolation: {
            enabled: opts.vm ?? false,
            idle_timeout_minutes: opts.idleMinutes ?? 0,
            ...(runtime ? { claude: runtime, codex: runtime } : {}),
          },
        },
      },
      null,
      2,
    ),
  );
};

let daemon: Daemon | undefined;
let client: LoomClient | undefined;
const texts = new Map<string, string>();
const events: Array<{ id: string; type: string; detail?: unknown }> = [];
const start = async () => {
  daemon = await Daemon.start({ repoRoot: f.repo, configFile, connectors: CONNECTORS });
  client = await LoomClient.connect({
    repoRoot: f.repo,
    sockPath: daemon.sockPath,
    autospawn: false,
  });
  client.onPush((frame) => {
    if (frame.type !== "event") return;
    const event = frame.event as { type: string; sessionId: string; [k: string]: unknown };
    if (event.type === "assistant_text")
      texts.set(event.sessionId, (texts.get(event.sessionId) ?? "") + String(event.text));
    // Stand in for the user: allow, and keep a record so checks can count prompts.
    if (event.type === "permission_request" && event["tool"] !== "AskUserQuestion") {
      log("permission prompt allowed", {
        tool: event["tool"],
        request: JSON.stringify(event).slice(0, 400),
      });
      void client!
        .request("session.respondPermission", {
          id: event.sessionId,
          requestId: event["id"],
          decision: "allow",
        })
        .catch(() => {});
    }
    const detail: Record<string, () => unknown> = {
      usage: () => ({ costDeltaUsd: event["costDeltaUsd"], providerTotal: event["providerTotal"] }),
      plan_review: () => ({ implementMode: event["implementMode"] }),
      permission_request: () => ({ tool: event["tool"] }),
      error: () => ({ message: String(event["message"]).slice(0, 200) }),
      result: () => ({ kind: event["kind"] }),
      // The queue check orders these: a root tool, and the message folded in.
      tool_call: () => ({ id: event["id"], name: event["name"], agentId: event["agentId"] }),
      tool_result: () => ({ id: event["id"], agentId: event["agentId"] }),
      user_message: () => ({
        text: String(event["text"]).slice(0, 80),
        injected: event["injected"],
        entry: event["queueEntryId"],
        author: event["author"],
      }),
    };
    const describe = detail[event.type];
    if (describe) events.push({ id: event.sessionId, type: event.type, detail: describe() });
  });
};
const stop = async (reason: string) => {
  await client?.close();
  await daemon?.stop(reason);
  client = undefined;
  daemon = undefined;
};
const rpc = <T = SessionSnapshot>(method: string, params: unknown = {}, ms = 300_000) =>
  client!.request<T>(method, params, ms);
const get = (id: string) => rpc("session.get", { id });
const settle = async (
  id: string,
  until: (s: SessionSnapshot) => boolean = (s) => s.status.kind === "idle",
  ms = 300_000,
) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await get(id);
    if (until(s)) return s;
    assert(s.status.kind !== "error", `Session failed: ${JSON.stringify(s.status)}`);
    assert(Date.now() < deadline, `Timed out; last status ${JSON.stringify(s.status)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};
const send = async (id: string, text: string) => {
  texts.set(id, "");
  const before = (await get(id)).turns;
  await rpc("session.send", { id, text });
  // A send to a suspended session first revives it: wait for the turn itself.
  return await settle(id, (s) => s.status.kind === "idle" && s.turns > before);
};
const create = async (provider: string, prompt: string, extra: Record<string, unknown> = {}) => {
  const s = await rpc("session.create", { provider, prompt, ...extra });
  texts.set(s.id, texts.get(s.id) ?? "");
  return await settle(s.id, (s) => s.status.kind === "idle" && s.turns > 0);
};
const cheapModel = async (provider: string) => {
  const list = await rpc<Array<{ id: string; models: string[] }>>("providers.list");
  const models = list.find((p) => p.id === provider)?.models ?? [];
  return provider === CODEX
    ? (models.find((m) => /mini|luna/.test(m)) ?? models.at(-1))
    : (models.find((m) => /haiku/.test(m)) ?? models[0]);
};
const waitCatalogue = async (provider: string) => {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const list =
      await rpc<Array<{ id: string; models: string[]; modelsLoading?: boolean }>>("providers.list");
    const p = list.find((x) => x.id === provider);
    if (p && !p.modelsLoading && p.models.length) return;
    assert(Date.now() < deadline, "catalogue for " + provider + " did not load");
    await new Promise((r) => setTimeout(r, 500));
  }
};
const exists = (path: string) =>
  Deno.stat(path).then(
    () => true,
    () => false,
  );

const isolation = async (provider: string) => {
  assert(artifact && smolvm, "Set LOOM_LIVE_ARTIFACT and LOOM_LIVE_SMOLVM");
  await writeConfig({ vm: true, idleMinutes: 1 });
  await start();
  await waitCatalogue(provider);
  const model = await cheapModel(provider);
  let s = await create(
    provider,
    "Remember the word cobalt. Use your shell or file tool to create a.txt containing hi in the working directory. Do not commit. Then reply ok.",
    { model, mode: "auto", isolation: "vm", ...(provider === CODEX ? { effort: "low" } : {}) },
  );
  assert.equal(s.isolation, "vm");
  const worktree = s.worktree!;
  assert.match(await Deno.readTextFile(join(worktree, "a.txt")), /hi/);
  log("created, tool write in VM", { model, worktree: !!worktree, turns: s.turns });
  // Idle suspension: the configured 1-minute grace, swept by the daemon itself.
  const vmStates = async () =>
    (await listVms(await Deno.realPath(f.repo))).vms
      .filter((vm) => vm.sessionId === s.id)
      .map((vm) => vm.state);
  log("VMs before suspension", await vmStates());
  const idleFrom = Date.now();
  const deadline = Date.now() + 240_000;
  while (daemon!.sessions.has(s.id)) {
    assert(Date.now() < deadline, "idle suspension did not happen");
    await new Promise((r) => setTimeout(r, 2000));
  }
  const suspended = await get(s.id);
  log("idle suspended", {
    afterSeconds: Math.round((Date.now() - idleFrom) / 1000),
    status: suspended.status.kind,
    vms: await vmStates(),
  });
  s = await send(
    s.id,
    "What word did I ask you to remember? Also create b.txt containing bye. Do not commit. Reply with the word.",
  );
  assert.match(texts.get(s.id)!.toLowerCase(), /cobalt/);
  assert.match(await Deno.readTextFile(join(worktree, "b.txt")), /bye/);
  log("resumed in a fresh VM, recalled and wrote", { turns: s.turns });
  await rpc("session.markDone", { id: s.id, force: true });
  const done = await get(s.id);
  log("stopped", { status: done.status.kind, worktreeRemoved: !(await exists(worktree)) });
  await stop("acceptance-done");
};

/**
 * A pass-through `codex` that also records Codex's own `thread/settings/updated`
 * notifications (and nothing else) from its app-server stdout.
 */
const codexTap = async () => {
  const tapLog = join(f.root, "thread-settings.jsonl");
  const tap = join(f.root, "codex-tap");
  await Deno.writeTextFile(
    tap,
    `#!/usr/bin/env bash
if [ "$1" != "app-server" ]; then exec ${JSON.stringify(codexCli)} "$@"; fi
${JSON.stringify(codexCli)} "$@" <&0 > >(tee >(grep --line-buffered -F 'thread/settings/updated' >> ${JSON.stringify(tapLog)})) &
child=$!
trap 'kill $child 2>/dev/null' TERM INT HUP
wait $child
`,
  );
  await Deno.chmod(tap, 0o755);
  const settings = async () =>
    (await Deno.readTextFile(tapLog).catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).params?.threadSettings ?? {});
  return { tap, settings };
};

const codexPlan = async () => {
  const { tap, settings } = await codexTap();
  await writeConfig({ codexCli: tap });
  await start();
  await waitCatalogue(CODEX);
  const model = await cheapModel(CODEX);
  let s = await create(CODEX, "Reply with exactly ok. Do not use tools.", {
    model,
    effort: "low",
    mode: "auto",
    isolation: "local",
  });
  log("created in auto", { model, mode: s.mode, modes: s.modes });
  await rpc("session.setMode", { id: s.id, mode: "plan" });
  s = await get(s.id);
  log("selected plan", { mode: s.mode, pendingMode: s.pendingMode });
  texts.set(s.id, "");
  const before = s.turns;
  await rpc("session.send", {
    id: s.id,
    text: "Plan how to create plan.txt containing hi in the working directory. Propose a two-step plan only; do not implement it.",
  });
  s = await settle(
    s.id,
    (x) => x.status.kind === "awaiting_input" || (x.status.kind === "idle" && x.turns > before),
  );
  const review = s.requests.find((r) => r.kind === "plan_review");
  const planSettings = (await settings()).at(-1);
  log("plan turn ended", {
    status: s.status.kind,
    mode: s.mode,
    review: review && { implementMode: review.implementMode, planChars: review.plan.length },
    codexSettings: planSettings && {
      collaboration: planSettings.collaborationMode?.mode,
      reviewer: planSettings.approvalsReviewer,
    },
  });
  assert(review && review.kind === "plan_review", "a Loom plan review is raised");
  assert.equal(review.implementMode, "auto", "the review remembers the execution mode");
  assert.equal(s.mode, "plan");
  await rpc("session.respondPlan", { id: s.id, requestId: review.id, action: "implement" });
  s = await settle(s.id, (x) => x.status.kind === "idle" && x.requests.length === 0, 300_000);
  // The implementation turn may still be completing when the review settles.
  s = await settle(s.id, (x) => x.status.kind === "idle", 300_000);
  const all = await settings();
  const last = all.at(-1);
  const prompts = events.filter((e) => e.id === s.id && e.type === "permission_request");
  log("implemented", {
    mode: s.mode,
    pendingMode: s.pendingMode,
    file: await Deno.readTextFile(join(s.worktree!, "plan.txt")).catch(() => null),
    permissionPrompts: prompts.length,
    codexSettingsSeen: all.map((x) => [x.collaborationMode?.mode, x.approvalsReviewer]),
  });
  assert.equal(s.mode, "auto");
  assert.equal(last?.collaborationMode?.mode, "default");
  assert.equal(last?.approvalsReviewer, "auto_review");
  assert.match(await Deno.readTextFile(join(s.worktree!, "plan.txt")), /hi/);
  assert.equal(prompts.length, 0, "auto implementation raises no approval prompts");
};

type ProviderRow = {
  id: string;
  models: string[];
  modelChoices?: Array<{
    id: string;
    label?: string;
    effortLevels?: string[];
    defaultEffort?: string;
  }>;
  modelsLoading?: boolean;
  modelsError?: string;
  modelsRefreshUnavailable?: string;
  defaultModel?: string;
  defaultEffort?: string;
  account?: { loginMethod?: string };
};
const models = async () => {
  await writeConfig({});
  await start();
  await waitCatalogue(CLAUDE);
  await waitCatalogue(CODEX);
  const summary = (p: ProviderRow) => ({
    id: p.id,
    default: [p.defaultModel, p.defaultEffort],
    error: p.modelsError,
    refreshUnavailable: p.modelsRefreshUnavailable,
    choices: (p.modelChoices ?? p.models.map((id) => ({ id }))).map((m) =>
      [
        m.id,
        (m as { label?: string }).label,
        (m as { effortLevels?: string[] }).effortLevels?.join("/"),
      ].join(" | "),
    ),
  });
  const list = await rpc<ProviderRow[]>("providers.list");
  log(
    "providers",
    list.map((p) => p.id),
  );
  for (const p of list) log("catalogue", summary(p));
  const claude = list.find((p) => p.id === CLAUDE)!;
  const codex = list.find((p) => p.id === CODEX)!;
  assert(claude.models.length && codex.models.length);
  assert(!claude.models.some((m) => codex.models.includes(m)), "no shared ids between providers");
  assert(!claude.models.some((m) => /gpt|codex/i.test(m)), "no Codex model in Claude's list");
  assert(
    !codex.models.some((m) => /claude|opus|sonnet|haiku/i.test(m)),
    "no Claude model in Codex's",
  );
  for (const p of [claude, codex]) {
    const labels = (p.modelChoices ?? []).map((m) => m.label ?? m.id);
    assert.equal(new Set(labels).size, labels.length, p.id + " labels are distinct");
    assert(p.defaultModel && p.models.includes(p.defaultModel), p.id + " default is in its list");
  }
  for (const id of [CLAUDE, CODEX]) {
    const t = Date.now();
    const refreshed = await rpc<{ id: string; models: string[] }>(
      "providers.refreshModels",
      { id },
      180_000,
    );
    const after = await rpc<ProviderRow[]>("providers.list");
    const other = id === CLAUDE ? CODEX : CLAUDE;
    const before = list.find((p) => p.id === other)!.models;
    log("refreshed", {
      id,
      ms: Date.now() - t,
      models: refreshed.models,
      sameAsBefore:
        JSON.stringify(refreshed.models) === JSON.stringify(list.find((p) => p.id === id)!.models),
      otherUnchanged:
        JSON.stringify(after.find((p) => p.id === other)!.models) === JSON.stringify(before),
    });
    assert.equal(refreshed.id, id);
    assert(refreshed.models.length);
    assert.deepEqual(after.find((p) => p.id === other)!.models, before);
  }
  await assert.rejects(rpc("providers.refreshModels", { id: "claude:work" }), /no provider/);
  log("unconfigured profile refused", "claude:work");
};

const cost = async () => {
  await writeConfig({});
  await start();
  await waitCatalogue(CLAUDE);
  const model = await cheapModel(CLAUDE);
  let s = await create(CLAUDE, "Reply with exactly ok. Do not use tools.", {
    model,
    isolation: "local",
  });
  s = await send(s.id, "Reply with exactly ok again. Do not use tools.");
  const beforeRestart = s.costUsd;
  log("two turns", { model, costUsd: s.costUsd, source: s.costSource, turns: s.turns });
  await stop("acceptance-restart");
  await start();
  s = await get(s.id);
  log("after restart", { costUsd: s.costUsd, status: s.status.kind });
  assert.equal(s.costUsd, beforeRestart, "a restart charges nothing");
  s = await send(s.id, "Reply with exactly ok a third time. Do not use tools.");
  const usages = events.filter((e) => e.id === s.id && e.type === "usage");
  const deltas = usages.map((e) => (e.detail as { costDeltaUsd?: number }).costDeltaUsd ?? 0);
  const sum = deltas.reduce((a, b) => a + b, 0);
  const totals = usages.map(
    (e) => (e.detail as { providerTotal?: { ref: string; costUsd: number } }).providerTotal,
  );
  const cli = totals.at(-1);
  log("third turn after restart", {
    stored: s.costUsd,
    deltas,
    sum,
    cliRunningTotals: totals.map((t) => t?.costUsd),
    cliRef: cli?.ref === daemon!.registry.store.providerRef(s.id),
    turns: s.turns,
  });
  assert(Math.abs(s.costUsd - sum) < 1e-9, "stored total equals the sum of per-turn deltas");
  assert(deltas.at(-1)! < beforeRestart, "the revived turn is not charged the earlier spend");
  assert(cli && Math.abs(cli.costUsd - s.costUsd) < 1e-6, "Loom's total matches the CLI's");
};

const forks = async () => {
  await writeConfig({});
  await start();
  await waitCatalogue(CLAUDE);
  await waitCatalogue(CODEX);
  const claudeModel = await cheapModel(CLAUDE);
  const codexModel = await cheapModel(CODEX);
  const recall = async (id: string, word: RegExp) => {
    const s = await settle(id, (x) => x.status.kind === "idle" && /\w/.test(texts.get(id) ?? ""));
    return { s, ok: word.test((texts.get(id) ?? "").toLowerCase()), text: texts.get(id) };
  };
  // Native Claude fork into a new worktree.
  const c = await create(
    CLAUDE,
    "Remember the word amber. Reply with exactly ok. Do not use tools.",
    {
      model: claudeModel,
      isolation: "local",
    },
  );
  const cf = await rpc("session.fork", {
    id: c.id,
    history: "native",
    workspace: "copy",
    prompt: "What word did I ask you to remember? Reply with only that word. Do not use tools.",
  });
  texts.set(cf.id, texts.get(cf.id) ?? "");
  const cr = await recall(cf.id, /amber/);
  log("claude native fork", {
    forkKind: cr.s.forkKind,
    newWorktree: cr.s.worktree !== c.worktree,
    recalled: cr.ok,
    text: cr.text?.slice(0, 60),
    sourceRef:
      daemon!.registry.store.providerRef(c.id) !== daemon!.registry.store.providerRef(cf.id),
  });
  assert.equal(cr.s.forkKind, "native");
  assert.notEqual(cr.s.worktree, c.worktree);
  assert(cr.ok, "the native Claude fork resumed the source's history in its own worktree");
  // The source is untouched and still continues.
  const after = await send(c.id, "Reply with only the word you remembered. Do not use tools.");
  assert.match(texts.get(c.id)!.toLowerCase(), /amber/);
  log("claude source still continues", { turns: after.turns });

  // Native Codex fork (thread/fork).
  const x = await create(
    CODEX,
    "Remember the word teal. Reply with exactly ok. Do not use tools.",
    {
      model: codexModel,
      effort: "low",
      isolation: "local",
    },
  );
  const xf = await rpc("session.fork", {
    id: x.id,
    history: "native",
    workspace: "copy",
    prompt: "What word did I ask you to remember? Reply with only that word. Do not use tools.",
  });
  texts.set(xf.id, texts.get(xf.id) ?? "");
  const xr = await recall(xf.id, /teal/);
  log("codex native fork", {
    forkKind: xr.s.forkKind,
    newWorktree: xr.s.worktree !== x.worktree,
    recalled: xr.ok,
    text: xr.text?.slice(0, 60),
    distinctThread:
      daemon!.registry.store.providerRef(x.id) !== daemon!.registry.store.providerRef(xf.id),
  });
  assert.equal(xr.s.forkKind, "native");
  assert(xr.ok, "the native Codex fork carried the thread");
  assert.notEqual(
    daemon!.registry.store.providerRef(x.id),
    daemon!.registry.store.providerRef(xf.id),
  );

  // Cross-provider handoff, Claude → Codex.
  const hf = await rpc("session.fork", {
    id: c.id,
    provider: CODEX,
    history: "handoff",
    workspace: "copy",
    model: codexModel,
    effort: "low",
    prompt: "What word did I ask you to remember? Reply with only that word. Do not use tools.",
  });
  texts.set(hf.id, texts.get(hf.id) ?? "");
  const hr = await recall(hf.id, /amber/);
  log("claude→codex handoff", {
    forkKind: hr.s.forkKind,
    provider: hr.s.provider,
    recalled: hr.ok,
    text: hr.text?.slice(0, 60),
    costUsd: hr.s.costUsd,
    costSource: hr.s.costSource,
    sourceCost: (await get(c.id)).costUsd,
  });
  assert.equal(hr.s.forkKind, "handoff");
  assert.equal(hr.s.provider, CODEX);
  assert(hr.ok, "the handoff carried the remembered word");
};

/**
 * The message queue (docs/message-queue.md): a message queued during a long
 * root Bash reaches the log only after that tool finishes and the agent takes
 * it; an interrupt with three end-of-turn entries leaves three held; release
 * delivers them in order, one per finish.
 */
const queue = async (provider: string) => {
  await writeConfig({});
  await start();
  await waitCatalogue(provider);
  const model = await cheapModel(provider);
  const s = await create(provider, "Reply with exactly ok. Do not use tools.", {
    model,
    isolation: "local",
  });
  const mine = () => events.filter((e) => e.id === s.id);
  const rootBash = () =>
    mine().find(
      (e) =>
        e.type === "tool_call" &&
        (e.detail as { agentId?: string; name: string }).agentId === undefined &&
        (e.detail as { name: string }).name === "Bash",
    );
  const settleFor = async (cond: () => boolean, what: string, ms = 180_000) => {
    const deadline = Date.now() + ms;
    while (!cond()) {
      assert(Date.now() < deadline, `timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  // 1. Folded in at the boundary of a running Bash, and not logged before it.
  const from = mine().length;
  await rpc("session.send", {
    id: s.id,
    text: "Run the Bash command `sleep 12; echo slept`, then say what it printed in one sentence.",
  });
  await settleFor(() => rootBash() !== undefined, "the root Bash");
  const bash = (rootBash()!.detail as { id: string }).id;
  const folded = await rpc<SessionSnapshot & { state: string; entryId: string }>("session.send", {
    id: s.id,
    text: "Also end your reply with the word BANANA.",
  });
  log("queued during Bash", { state: folded.state, dequeue: folded.queue?.entries[0]?.dequeue });
  const after = await settle(s.id, (x) => x.status.kind === "idle" && x.queue === undefined);
  const timeline = mine().slice(from);
  const resultAt = timeline.findIndex(
    (e) => e.type === "tool_result" && (e.detail as { id: string }).id === bash,
  );
  const loggedAt = timeline.findIndex(
    (e) => e.type === "user_message" && (e.detail as { entry?: string }).entry === folded.entryId,
  );
  log("fold", { resultAt, loggedAt, text: texts.get(s.id)?.slice(-80), turns: after.turns });
  assert(resultAt >= 0 && loggedAt > resultAt, "logged only after the tool it waited for");
  assert(/BANANA/.test(texts.get(s.id) ?? ""), "the agent took it in");

  // 2. Interrupt with three end-of-turn entries: three held; release, in order.
  const second = mine().length;
  await rpc("session.send", {
    id: s.id,
    text: "Run the Bash command `sleep 60`, then reply with exactly done.",
  });
  await settleFor(
    () =>
      mine()
        .slice(second)
        .some((e) => e.type === "tool_call"),
    "a tool",
  );
  const held: string[] = [];
  for (const word of ["ONE", "TWO", "THREE"]) {
    const r = await rpc<SessionSnapshot & { entryId: string }>("session.send", {
      id: s.id,
      text: `Reply with exactly ${word}. Do not use tools.`,
      delivery: "end_of_turn",
    });
    held.push(r.entryId);
  }
  await rpc("session.interrupt", { id: s.id });
  const stopped = await get(s.id);
  log("after interrupt", { hold: stopped.queue?.hold, n: stopped.queue?.entries.length });
  assert.equal(stopped.queue?.hold, "interrupt");
  assert.deepEqual(
    stopped.queue?.entries.map((e) => [e.id, e.state]),
    held.map((id) => [id, "queued"]),
  );
  const third = mine().length;
  await rpc("session.queueRelease", { id: s.id });
  await settle(s.id, (x) => x.status.kind === "idle" && x.queue === undefined, 300_000);
  const order = mine()
    .slice(third)
    .flatMap((e) =>
      e.type === "user_message" ? [(e.detail as { entry?: string }).entry ?? ""] : [],
    );
  log("released", { order });
  assert.deepEqual(order, held, "delivered in order");
};

/**
 * A pass-through CLI that records, without secrets, what proves which tools a
 * session has: its argv, the stdin lines matching `stdin` (Codex `thread/start`
 * params) and the stdout lines matching `stdout` (Claude's system init).
 */
const cliTap = async (
  name: string,
  real: string,
  filters: { stdin?: string; stdout?: string; only?: string },
) => {
  const dir = join(f.root, `tap-${name}`);
  await Deno.mkdir(dir, { recursive: true });
  const [argv, input, output, tap] = ["argv", "stdin", "stdout", "cli"].map((n) => join(dir, n));
  const q = JSON.stringify;
  const grep = (pattern: string, file: string) =>
    `tee >(grep --line-buffered -F ${q(pattern)} >> ${q(file)})`;
  await Deno.writeTextFile(
    tap!,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${q(argv)}
${filters.only ? `if [ "$1" != ${q(filters.only)} ]; then exec ${q(real)} "$@"; fi` : ""}
${filters.stdin ? `${grep(filters.stdin, input!)} <&0 |` : ""} ${q(real)} "$@" ${filters.stdin ? "" : "<&0"} ${filters.stdout ? `> >(${grep(filters.stdout, output!)})` : ""} &
child=$!
trap 'kill $child 2>/dev/null' TERM INT HUP
wait $child
`,
  );
  await Deno.chmod(tap!, 0o755);
  const lines = async (file: string) =>
    (await Deno.readTextFile(file).catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  return {
    tap: tap!,
    argv: async () => (await Deno.readTextFile(argv!).catch(() => "")).split("\n").filter(Boolean),
    stdin: () => lines(input!),
    stdout: () => lines(output!),
  };
};

/** Native sub-agent tools each provider must not offer (docs/loom-agents.md). */
const NATIVE_CLAUDE = ["Agent", "Task"];
const NATIVE_CODEX = [
  "spawn_agent",
  "send_input",
  "resume_agent",
  "close_agent",
  "interrupt_agent",
  "list_agents",
  "followup_task",
  "send_message",
  "wait_agent",
  "spawn_agents_on_csv",
];
const AGENT_TOOLS = [
  "agents_profiles",
  "agent_start",
  "agent_message",
  "agent_status",
  "agent_read",
  "agent_interrupt",
  "agent_stop",
  "agent_wait",
];

/** Asks a Codex model for its tools: the only view of Codex's own tool list. */
const LIST_TOOLS =
  "First write one line starting TOOLS: listing the exact names of every tool (function) you can call, comma separated, verbatim. " +
  "If any tool's description lists further tools callable from inside it, write a line starting NESTED: with those names, comma separated. " +
  "If you have a tool named wait, write a line starting WAIT: quoting the first sentence of its description.";

/**
 * A Codex session that answered {@link LIST_TOOLS} runs with the native
 * sub-agent switches off, was given the loom-agents dynamic tools, and lists
 * no native sub-agent tool — unless `allowListed` (a v2 model, whose tools
 * stay listed: openai/codex#50880). Returns the native tools listed.
 */
const assertCodexTools = async (
  s: SessionSnapshot,
  tap: Awaited<ReturnType<typeof cliTap>>,
  allowListed = false,
) => {
  // The session's own thread/start (a child at max depth has no agent tools).
  const starts = (await tap.stdin()).map(
    (m) => (m["params"] ?? {}) as { cwd?: string; dynamicTools?: Array<{ name: string }> },
  );
  const params = starts.find((p) => p.cwd === s.worktree) ?? starts[0] ?? {};
  const dynamic = (params.dynamicTools ?? []).map((t) => t.name);
  const argv = (await tap.argv()).filter((a) => a.startsWith("app-server"));
  const said = texts.get(s.id) ?? "";
  const listed = said.match(/TOOLS:(.*)/)?.[1] ?? "";
  const nested = said.match(/NESTED:(.*)/)?.[1] ?? "";
  // Names come namespaced (`functions.exec`, `collaboration.spawn_agent`).
  const names = `${listed},${nested}`.split(/[,\s]+/).map((n) =>
    n
      .replace(/[`*]/g, "")
      .trim()
      .replace(/^[\w-]+\./, ""),
  );
  log("codex tools", {
    model: s.model,
    argv: argv.at(-1),
    dynamicTools: dynamic,
    modelListed: listed.trim(),
    nestedListed: nested.trim(),
    waitDescribed: said.match(/WAIT:(.*)/)?.[1]?.trim(),
    nativeListed: NATIVE_CODEX.filter((n) => names.includes(n)),
  });
  assert(/features\.multi_agent=false/.test(argv.at(-1) ?? ""), "multi_agent off");
  assert(
    /features\.multi_agent_v2=\{enabled=false, max_concurrent_threads_per_session=1\}/.test(
      argv.at(-1) ?? "",
    ),
    "multi_agent_v2 off, one thread",
  );
  for (const t of AGENT_TOOLS) assert(dynamic.includes(t), `dynamic tool ${t}`);
  assert(listed, "the model listed its tools");
  const native = NATIVE_CODEX.filter((n) => names.includes(n));
  if (!allowListed) assert.deepEqual(native, [], "no native sub-agents");
  // Code mode has a `wait` of its own (for an exec cell); v1's waits on agents.
  if (names.includes("wait"))
    assert.doesNotMatch(said.match(/WAIT:(.*)/)?.[1] ?? "", /agent/i, "wait is not v1's");
  return native;
};

/** One Codex turn on `model` (e.g. one whose catalogue entry says
 *  `multi_agent_version: v2`): its tools. If native sub-agent tools are still
 *  listed, a second turn asks for one spawn, which must start no thread. */
const codexTools = async (model: string | undefined) => {
  const tap = await cliTap("codex", codexCli!, {
    stdin: "thread/start",
    stdout: '"collabAgentToolCall"',
    only: "app-server",
  });
  await writeConfig({ codexCli: tap.tap });
  await start();
  await waitCatalogue(CODEX);
  const s = await create(CODEX, `${LIST_TOOLS} Then stop: call no tool.`, {
    model: model ?? (await cheapModel(CODEX)),
    effort: "low",
    mode: "auto",
    isolation: "local",
  });
  const native = await assertCodexTools(s, tap, true);
  if (!native.length) return;
  const tool = native.includes("spawn_agent") ? "spawn_agent" : native[0];
  await send(
    s.id,
    "This is a configuration test the user asked for: make exactly one call to Codex's built-in " +
      `${tool} tool (not agent_start) with the task "reply ok". ` +
      "It is expected to be refused; that is what is being tested. Then write a line starting SPAWN: " +
      "quoting the tool result verbatim, and stop.",
  );
  const said = texts.get(s.id) ?? "";
  const calls = (await tap.stdout())
    .filter((m) => m["method"] === "item/completed")
    .map((m) => (m["params"] as { item?: Record<string, unknown> } | undefined)?.item ?? {})
    .filter((item) => item["type"] === "collabAgentToolCall");
  log("native spawn attempt", {
    native,
    said:
      said
        .match(/SPAWN:([\s\S]*)/)?.[1]
        ?.trim()
        .slice(0, 1_000) ?? said.slice(-1_000),
    calls: calls.map((c) => ({
      tool: c["tool"],
      status: c["status"],
      receiverThreadIds: c["receiverThreadIds"],
    })),
  });
  // The model may decline outright (its developer instructions forbid these
  // tools), and then no call reaches Codex: still no sub-agent thread.
  if (!calls.length) log("no native sub-agent call reached Codex");
  for (const c of calls)
    assert.deepEqual(c["receiverThreadIds"] ?? [], [], "a native spawn started no thread");
};

/**
 * Loom agents, stage 1: a supervisor on `provider` starts a `self` child,
 * is woken by its end-of-turn notification, reads it; with `steer`, also
 * messages it and sees the message reach the child's queue labelled.
 */
const agents = async (provider: string) => {
  const claudeReal = new Deno.Command("bash", { args: ["-c", "command -v claude"] }).outputSync();
  const claudeTap = await cliTap("claude", new TextDecoder().decode(claudeReal.stdout).trim(), {
    stdout: '"subtype":"init"',
  });
  const codexTap = await cliTap("codex", codexCli!, { stdin: "thread/start", only: "app-server" });
  await writeConfig({ claudeCli: claudeTap.tap, codexCli: codexTap.tap });
  await start();
  await waitCatalogue(provider);
  const model = await cheapModel(provider);
  const codex = provider === CODEX;
  const extra = { model, isolation: "local", ...(codex ? { effort: "low", mode: "auto" } : {}) };
  const childTask =
    "Create a file child.txt containing exactly hi, commit it with the message 'add child', then reply with the commit's short hash.";
  const sup = await create(
    provider,
    `${codex ? `${LIST_TOOLS} Then ` : ""}Call agents_profiles. Then call agent_start with profile "self", title "child", and task: "${childTask}". ` +
      "Do not call agent_wait. Then end your turn, replying with the agent's id. Later, when you are notified about the agent, reply with one short sentence and use no tools unless I ask.",
    extra,
  );
  log("supervisor turn 1", {
    model,
    branch: sup.branch,
    worktree: !!sup.worktree,
    text: texts.get(sup.id)?.slice(0, 600),
  });

  // 1. Native sub-agents absent; loom-agents present.
  if (codex) await assertCodexTools(sup, codexTap);
  else {
    const init = (await claudeTap.stdout()).find((m) => m["subtype"] === "init");
    const tools = (init?.["tools"] ?? []) as string[];
    const servers = (init?.["mcp_servers"] ?? []) as Array<{ name: string; status: string }>;
    log("claude init tools", {
      count: tools.length,
      native: tools.filter((t) => NATIVE_CLAUDE.includes(t)),
      loomAgents: tools.filter((t) => t.startsWith("mcp__loom-agents__")),
      servers: servers.map((s) => `${s.name}:${s.status}`),
    });
    assert(tools.length > 0, "the init message lists tools");
    assert.deepEqual(
      tools.filter((t) => NATIVE_CLAUDE.includes(t)),
      [],
      "no Agent/Task",
    );
    for (const t of AGENT_TOOLS)
      assert(tools.includes(`mcp__loom-agents__${t}`), `loom-agents tool ${t}`);
  }

  // 2. The child: supervised, its own worktree from the supervisor's branch, done.
  const listChildren = async () =>
    (await rpc<SessionSnapshot[]>("session.list")).filter((s) => s.supervisorId === sup.id);
  const kids = await listChildren();
  assert.equal(kids.length, 1, "exactly one child");
  let child = await settle(kids[0]!.id, (s) => s.status.kind === "idle" && s.turns > 0);
  const hasFile = async (ref: string) =>
    new TextDecoder()
      .decode(
        (
          await new Deno.Command("git", {
            args: ["-C", child.worktree!, "show", `${ref}:child.txt`],
          }).output()
        ).stdout,
      )
      .trim();
  const ancestor = await new Deno.Command("git", {
    args: ["-C", child.worktree!, "merge-base", "--is-ancestor", sup.branch!, child.branch!],
  }).output();
  log("child", {
    id: child.id,
    supervisorId: child.supervisorId === sup.id,
    profile: child.agentProfile,
    provider: child.provider,
    model: child.model,
    mode: child.mode,
    branch: child.branch,
    baseBranch: child.baseBranch,
    ownWorktree: child.worktree !== sup.worktree,
    fromSupervisorBranch: ancestor.success,
    committed: await hasFile("HEAD"),
    clean: !child.git?.dirty,
    aheadOfBase: child.git?.aheadOfBase,
    text: texts.get(child.id)?.slice(-300),
  });
  assert.equal(child.agentProfile, "self");
  assert.equal(child.provider, sup.provider);
  assert(child.worktree && child.worktree !== sup.worktree, "its own worktree");
  assert.equal(child.baseBranch, sup.branch, "branched from the supervisor's branch");
  assert(ancestor.success, "the supervisor's branch is an ancestor of the child's");
  assert.equal(await hasFile("HEAD"), "hi", "child.txt committed");

  // 3. The supervisor is woken by an end-of-turn notification from the child.
  const notified = await settleFor(
    () =>
      events.find(
        (e) =>
          e.id === sup.id &&
          e.type === "user_message" &&
          (e.detail as { author?: string }).author === `agent:${child.id}`,
      ),
    "the notification",
  );
  const woken = await settle(sup.id, (s) => s.status.kind === "idle" && s.turns > sup.turns);
  log("supervisor notified and woken", {
    notification: notified.detail,
    turns: [sup.turns, woken.turns],
    reply: texts.get(sup.id)?.slice(-300),
  });
  assert.match((notified.detail as { text: string }).text, /^\[from your agent /);

  // 4. agent_read (and, with Claude, one agent_message steer down).
  const steer = !codex;
  const childFrom = events.filter((e) => e.id === child.id).length;
  await send(
    sup.id,
    `Call agent_read on agent ${child.id} and tell me the name and content of the file it committed.` +
      (steer
        ? ` Then call agent_message on it with text "Reply with exactly ACK." and delivery next_boundary. Then end your turn.`
        : ""),
  );
  const readReply = texts.get(sup.id) ?? "";
  const supCalls = events
    .filter((e) => e.id === sup.id && e.type === "tool_call")
    .map((e) => (e.detail as { name: string }).name);
  log("supervisor read", { reply: readReply.slice(-400), calls: supCalls });
  assert(
    supCalls.some((n) => n.endsWith("agent_read")),
    "agent_read called",
  );
  assert.match(readReply, /child\.txt/);
  if (steer) {
    assert(
      supCalls.some((n) => n.endsWith("agent_message")),
      "agent_message called",
    );
    const delivered = await settleFor(
      () =>
        events
          .slice(0)
          .filter((e) => e.id === child.id)
          .slice(childFrom)
          .find(
            (e) =>
              e.type === "user_message" &&
              (e.detail as { author?: string }).author === `supervisor:${sup.id}`,
          ),
      "the steer",
    );
    child = await settle(child.id, (s) => s.status.kind === "idle" && s.turns > child.turns);
    log("steer delivered", {
      message: delivered.detail,
      childTurns: child.turns,
      reply: texts.get(child.id)?.slice(-120),
    });
    assert.match((delivered.detail as { text: string }).text, /^\[from your supervisor/);
  }
  // Let the last notification's wake-up finish before the daemon stops.
  await new Promise((r) => setTimeout(r, 3000));
  const final = await settle(sup.id, (s) => s.status.kind === "idle" && s.queue === undefined);
  log("done", {
    notifications: events
      .filter(
        (e) =>
          e.id === sup.id &&
          e.type === "user_message" &&
          (e.detail as { author?: string }).author === `agent:${child.id}`,
      )
      .map((e) => (e.detail as { text: string }).text),
    supervisorTurns: final.turns,
    childTurns: (await get(child.id)).turns,
    costs: [final.costUsd, (await get(child.id)).costUsd],
  });
};

const settleFor = async <T>(cond: () => T | undefined, what: string, ms = 300_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    assert(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

const run = async () => {
  let passed = false;
  try {
    if (check === "isolation-claude") await isolation(CLAUDE);
    else if (check === "isolation-codex") await isolation(CODEX);
    else if (check === "codex-plan") await codexPlan();
    else if (check === "models") await models();
    else if (check === "cost") await cost();
    else if (check === "forks") await forks();
    else if (check === "queue-claude") await queue(CLAUDE);
    else if (check === "queue-codex") await queue(CODEX);
    else if (check === "agents-claude") await agents(CLAUDE);
    else if (check === "agents-codex") await agents(CODEX);
    else if (check === "codex-tools") await codexTools(Deno.args[1]);
    else throw new Error("unknown check " + check);
    log("PASSED");
    passed = true;
  } catch (error) {
    log("FAILED", String(error instanceof Error ? (error.stack ?? error.message) : error));
    log("events", events.slice(-30));
    throw error;
  } finally {
    await stop("acceptance-cleanup").catch(() => {});
    if (passed) await f.close().catch(() => {});
    else console.log(`[${check}] retained fixture ${f.root}`);
  }
};
await run();
