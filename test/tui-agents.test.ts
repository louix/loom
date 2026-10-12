/**
 * Loom agents in the TUI (docs/loom-agents.md): the new-session prompt's
 * profile toggle, agents nested under their supervisor in the fleet with full
 * session controls, the supervisor's summary and combined cost, and the
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
import { describeCommand, describeCommands, footerHints } from "@loom/tui/commands";
import {
  agentSummary,
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
import { cycleProfile } from "@loom/tui/new-workspace";
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

test("⌥a cycles the new session's profile, setting what it names, and back to none", () => {
  const state = withFleet([]);
  const defaults = newSettings(state, null, null, null);
  const s0 = { ...defaults, isolation: "vm" as const, workspace: "worktree" as const };
  const first = cycleProfile(PROFILES, [provider("claude"), provider("codex")], s0, defaults);
  assert.ok("settings" in first);
  assert.equal(first.settings.profile, "implementer");
  assert.equal(first.settings.provider, "codex");
  assert.equal(first.settings.model, "codex-m2");
  assert.equal(first.settings.mode, "auto");
  assert.equal(first.settings.isolation, "vm", "where it runs stays");
  assert.equal(first.note, "implementer: Cheap");
  const second = cycleProfile(
    PROFILES,
    [provider("claude"), provider("codex")],
    first.settings,
    defaults,
  );
  assert.ok("settings" in second);
  assert.equal(second.settings.profile, "reviewer");
  assert.equal(
    second.settings.provider,
    "codex",
    "a profile without a provider keeps the prompt's",
  );
  assert.equal(second.settings.effort, "high");
  // The third runs on a provider this daemon lacks: passed over, back to none.
  const none = cycleProfile(
    PROFILES,
    [provider("claude"), provider("codex")],
    second.settings,
    defaults,
  );
  assert.ok("settings" in none);
  assert.equal(none.settings.profile, undefined);
  assert.equal(none.settings.provider, defaults.provider);
  assert.equal(none.settings.mode, defaults.mode);
  assert.match(none.note!, /elsewhere runs on gemini, which is not available\. No profile/);
  assert.deepEqual(cycleProfile([], [], s0, defaults), {
    disabled: "No agent profiles are available in this repository (agents.profiles).",
  });

  // The prompt's own command, under ⌥a, says where the next press goes.
  const prompted = reduce(state, {
    t: "overlay",
    overlay: { t: "prompt", prompt: newPrompt(defaults, "") },
  });
  const action = describeCommand(prompted, "newProfile", null, "newSession");
  assert.equal(action?.keys, "⌥a");
  assert.equal(action?.label, "profile → implementer");
  const bare = reduce(withFleet([], []), {
    t: "overlay",
    overlay: { t: "prompt", prompt: newPrompt(defaults, "") },
  });
  assert.match(
    describeCommand(bare, "newProfile", null, "newSession")?.disabled ?? "",
    /No agent profiles/,
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
      ? [[e.s.id, e.status, e.nest?.isLast ?? null, e.agents?.summary ?? null]]
      : [],
  );
  assert.deepEqual(rows, [
    ["other", "running", null, null],
    ["lead", "working_background", null, "1 needs input · 1 working · +1 done"],
    ["kid2", "awaiting_input", false, null],
    ["kid1", "running", true, null],
  ]);
  assert.equal(
    agentSummary(kids, (s) => s.status.kind),
    "1 needs input · 1 working",
  );
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

test("the fleet draws agents on tree branches, and a supervisor's summary and combined cost", () => {
  const { lead, kids, other } = tree();
  const state = withFleet([lead, ...kids, other]);
  const view = fleetPaneView(state.fleet, fleetLayout(state, 40), "kid1", null, null);
  const out = stripVTControlCharacters(
    renderToString(createElement(Fleet, { view, find: null, tick: 0, width: 100, now: 0 }), {
      columns: 100,
    }),
  );
  const line = (id: string) => out.split("\n").find((l) => l.includes(id.slice(0, 8)))!;
  assert.match(line("lead"), /◐ .*Coordinate\s+1 needs input · 1 working · \+1 done\s+Σ\$2\.00/);
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
