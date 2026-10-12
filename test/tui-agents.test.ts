/**
 * Loom agents in the TUI (docs/loom-agents.md): the agent profiles in the
 * new-session prompt's ⌥p list, agents nested under their supervisor in the
 * fleet with full session controls, the supervisor's summary and combined cost, and the
 * archive / delete choice for its agents.
 */
import { fleet, snap } from "./tui-fixtures.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import { loadableLoaded } from "@loom/core/loadable";
import type { AgentProfileInfo } from "@loom/core/agents";
import type { ProviderInfo, SessionSnapshot } from "@loom/core/wire";
import { describeCommands, footerHints } from "@loom/tui/commands";
import {
  fleetEntries,
  fleetLayout,
  fleetSessions,
  groupsOf,
  initialState,
  newSettings,
  reduce,
  treeCost,
  type Action,
  type TuiState,
} from "@loom/tui/model";
import { newPrompt, openPrompt } from "@loom/tui/overlay";
import { applyProfile, profileBlocked } from "@loom/tui/new-workspace";
import { fleetPaneView } from "@loom/tui/views";
import { Fleet } from "@loom/tui/components";
import { entryAuthor } from "@loom/tui/queue-view";
import { shownStatusIn } from "@loom/tui/fleet-status";

const provider = (id: string, over: Partial<ProviderInfo> = {}): ProviderInfo =>
  ({
    id,
    models: [`${id}-m1`, `${id}-m2`],
    defaultModel: `${id}-m1`,
    defaultMode: "default",
    ...over,
  }) as ProviderInfo;

const PROFILES: AgentProfileInfo[] = [
  { name: "implementer", description: "Cheap", provider: "codex", model: "codex-m2", mode: "auto" },
  { name: "reviewer", description: "Sceptical", effort: "high" },
  { name: "elsewhere", description: "Not here", provider: "gemini" },
];

const withFleet = (
  sessions: SessionSnapshot[],
  agentProfiles: AgentProfileInfo[] = PROFILES,
): TuiState => {
  const base = reduce(initialState(), fleet(sessions, [provider("claude"), provider("codex")]));
  if (base.fleet.tag !== "data") throw new Error("no fleet");
  return reduce(base, {
    t: "state",
    state: loadableLoaded({ ...base.fleet.value, agentProfiles }),
  } as Action);
};

test("a profile from ⌥p sets what it names, follows the provider otherwise, and replaces another", () => {
  const state = withFleet([]);
  const providers = [provider("claude"), provider("codex")];
  const defaults = newSettings(state, null, null, null);
  const s0 = { ...defaults, isolation: "vm" as const, workspace: "worktree" as const };
  const [implementer, reviewer, elsewhere] = PROFILES as [
    AgentProfileInfo,
    AgentProfileInfo,
    AgentProfileInfo,
  ];
  const first = applyProfile(implementer, providers, s0, defaults);
  assert.ok("settings" in first);
  assert.equal(first.settings.profile, "implementer");
  assert.equal(first.settings.provider, "codex");
  assert.equal(first.settings.model, "codex-m2");
  assert.equal(first.settings.mode, "auto");
  assert.equal(first.settings.isolation, "vm", "where it runs stays");

  // A profile without a provider follows the prompt's — today's, not the
  // replaced profile's, whose model and mode go with it.
  const second = applyProfile(reviewer, providers, first.settings, defaults);
  assert.ok("settings" in second);
  assert.equal(second.settings.profile, "reviewer");
  assert.equal(second.settings.provider, defaults.provider);
  assert.equal(second.settings.model, defaults.model);
  assert.equal(second.settings.mode, defaults.mode);
  assert.equal(second.settings.effort, "high");
  // On a provider the user picked first, it keeps that provider.
  const picked = applyProfile(
    reviewer,
    providers,
    { ...s0, provider: "codex", model: null },
    defaults,
  );
  assert.ok("settings" in picked);
  assert.equal(picked.settings.provider, "codex");

  // One on a provider this daemon lacks is listed but cannot be chosen.
  assert.equal(profileBlocked(elsewhere, providers), "runs on gemini, which is not available");
  assert.deepEqual(applyProfile(elsewhere, providers, s0, defaults), {
    disabled: "elsewhere runs on gemini, which is not available.",
  });
  // ⌥a is gone from the new prompt: profiles are picked with the providers.
  const prompted = reduce(state, {
    t: "overlay",
    overlay: { t: "prompt", prompt: newPrompt(defaults, "") },
  });
  assert.deepEqual(
    describeCommands(prompted, { target: null, surface: "newSession" }).map((a) => a.keys),
    ["⌥w", "⌥b"],
  );
  assert.equal(openPrompt(prompted.overlay)?.t, "new");
});

const tree = () => {
  const lead = snap({
    id: "lead",
    title: "Coordinate",
    status: "idle",
    costUsd: 1,
    costSource: "provider",
    createdAt: 10,
  });
  const kids = [
    snap({
      id: "kid1",
      title: "Implement",
      status: "running",
      supervisorId: "lead",
      costUsd: 0.5,
      costSource: "provider",
      createdAt: 20,
    }),
    snap({
      id: "kid2",
      title: "Verify",
      status: "awaiting_input",
      supervisorId: "lead",
      costUsd: 0.25,
      costSource: "provider",
      createdAt: 30,
    }),
    snap({
      id: "kid3",
      title: "Old",
      status: "done",
      supervisorId: "lead",
      costUsd: 0.25,
      costSource: "provider",
      createdAt: 5,
    }),
  ];
  const other = snap({ id: "other", title: "Unrelated", status: "running", createdAt: 40 });
  return { lead, kids, other };
};

test("agents sit under their supervisor, sorted like the fleet, the archived hidden", () => {
  const { lead, kids, other } = tree();
  const state = withFleet([kids[1]!, other, kids[0]!, lead, kids[2]!]);
  assert.deepEqual(
    fleetSessions(state).map((s) => s.id),
    ["other", "lead", "kid2", "kid1", "kid3"],
    "status group first among agents too; the archived last",
  );
  assert.deepEqual(
    groupsOf(fleetSessions(state), shownStatusIn(fleetSessions(state))).map((g) => [
      g.status,
      g.sessions.map((s) => s.id),
    ]),
    [
      ["running", ["other"]],
      ["working_background", ["lead"]],
    ],
    "an idle supervisor with a running agent is grouped as background work",
  );
  const rows = fleetEntries(state).flatMap((e) =>
    e.kind === "session"
      ? [[e.s.id, e.status, e.nest?.isLast ?? null, e.agents !== undefined]]
      : [],
  );
  assert.deepEqual(rows, [
    ["other", "running", null, false],
    ["lead", "working_background", null, true],
    ["kid2", "awaiting_input", false, false],
    ["kid1", "running", true, false],
  ]);
  assert.deepEqual(treeCost(lead, fleetSessions(state)), { costUsd: 2, costSource: "provider" });
  // ↑ from the supervisor reaches the row above it, not an agent.
  let s = reduce(state, { t: "select", id: "lead" });
  s = reduce(s, { t: "move", delta: 1 });
  assert.equal(s.selectedId, "lead", "nothing below it at the top level");
  s = reduce(s, { t: "move", delta: -1 });
  assert.equal(s.selectedId, "other");
});

test("a nested agent is a full session: every session verb, none withheld as a child row", () => {
  const { lead, kids, other } = tree();
  const state = reduce(withFleet([lead, ...kids, other]), { t: "select", id: "kid1" });
  assert.equal(state.selectedChild, null);
  const enabled = new Set(describeCommands(state).flatMap((a) => (a.disabled ? [] : [a.id])));
  for (const id of ["send", "interrupt", "mode", "title", "comment", "delete"] as const)
    assert.ok(enabled.has(id), `${id} is available on an agent`);
  for (const a of describeCommands(state))
    assert.doesNotMatch(a.disabled ?? "", /Select the session row/, a.id);
});

test("the fleet draws agents on tree branches, and a supervisor's combined cost without a summary", () => {
  const { lead, kids, other } = tree();
  const state = withFleet([lead, ...kids, other]);
  const view = fleetPaneView(state.fleet, fleetLayout(state, 40), "kid1", null, null);
  const out = stripVTControlCharacters(
    renderToString(createElement(Fleet, { view, find: null, tick: 0, width: 100, now: 0 }), {
      columns: 100,
    }),
  );
  const line = (id: string) => out.split("\n").find((l) => l.includes(id.slice(0, 8)))!;
  assert.match(line("lead"), /◐ .*Coordinate\s+Σ\$2\.00/);
  assert.doesNotMatch(line("lead"), /needs input|working|done/);
  assert.match(line("kid2"), /├ .*kid2.*Verify/);
  assert.match(line("kid1"), /└ .*kid1.*Implement/);
  assert.equal(out.includes("Old"), false, "the archived agent waits for the supervisor's →");
  assert.doesNotMatch(line("other"), /[├└]/);
});

test("archiving or deleting a supervisor asks about its agents, c toggles stop and detach", () => {
  const { lead, kids } = tree();
  let state = withFleet([lead, ...kids]);
  state = reduce(state, {
    t: "overlay",
    overlay: {
      t: "confirm",
      confirm: {
        title: "Archive?",
        danger: false,
        action: "archiveSession",
        sessionId: "lead",
        children: { count: 2, choice: "detach" },
      },
    },
  });
  assert.ok(footerHints(state).some((h) => h.keys === "c" && h.label === "stop agents"));
  state = reduce(state, { t: "toggleConfirmChildren" });
  assert.equal(
    state.overlay.t === "confirm" && state.overlay.confirm.action === "archiveSession"
      ? state.overlay.confirm.children?.choice
      : null,
    "stop",
  );
  assert.ok(footerHints(state).some((h) => h.keys === "c" && h.label === "detach agents"));
});

test("queued messages from agents say who sent them", () => {
  const entry = (author: string) => ({ author }) as Parameters<typeof entryAuthor>[0];
  assert.equal(entryAuthor(entry("me"), "me"), "you");
  assert.equal(entryAuthor(entry("supervisor:0123456789abcdef"), "me"), "supervisor 01234567");
  assert.equal(entryAuthor(entry("agent:fedcba9876543210"), "me"), "agent fedcba98");
  assert.equal(entryAuthor(entry("someone"), "me"), "other client");
});
