# Loom agents: sessions that supervise sessions

Status: design, agreed 2026-10-11; stage 1 implemented (see Stages).

## Goal

Let a session start and manage other sessions as its sub-agents, using
reusable agent profiles, so a user-facing coordinator can hand implementation
to a cheaper model and review to a sceptical one, while the user can still see,
steer and interrupt every agent. This replaces the providers' own sub-agents,
whose worktrees under `<repo>/.claude/worktrees` currently trip Loom's
writes-outside-the-workspace permission.

Typical shape (flat, not deep chains):

| Profile     | Example model    | Role                                                                   |
| ----------- | ---------------- | ---------------------------------------------------------------------- |
| coordinator | OpenAI Astra 6   | Talks to the user, plans, steers and reviews; does little work itself  |
| implementer | Anthropic Sonnet | Cheap; given a specific, verifiable task                               |
| verifier    | Anthropic Opus   | Sceptical review of a reported commit; reports pass/fail with findings |

## Model

- A Loom sub-agent is an ordinary session with a `supervisor_id`. This is
  separate from `parent_id`, which records fork lineage. It keeps its own
  transcript, status, queue, workspace and cost, and the user can message,
  steer, interrupt or archive it like any session.
- Providers' native sub-agents are disabled for every session, always: Claude
  without its `Agent` tool; Codex without its `spawn_agent` tools (the exact
  Codex switch is to be confirmed). Background shell tasks are unaffected.
- Every session gets the Loom agents MCP server (`loom-agents`) unless its
  profile leaves it out, or it is already at `agents.max_depth` (default 2: a
  supervisor and its children; configurable). A supervision cycle is refused.
- Children follow their supervisor's isolation (local or VM) and workspace
  kind; profiles have no isolation settings.

## Profiles

Defined in the Loom user config, globally and per repository (`repos[]`),
validated by the config schema and against the configured providers, skills
and MCP servers:

```jsonc
"agents": {
  "max_depth": 2,
  "profiles": {
    "implementer": {
      "description": "Cheap; give it a specific, verifiable task",
      "provider": "claude:personal",
      "model": "claude-sonnet-5-5",
      "effort": "medium",
      "mode": "auto",
      "mcp_servers": [],  // without "loom-agents" it cannot spawn
      "skills": [],
      "prompt": "You implement exactly the task you are given…"
    }
  }
}
```

Fields: `description` (what other agents read when choosing), provider/profile,
model, effort, mode, enabled MCP servers (`mcp_servers`, formerly `mcp`) and
skills, tool allow/deny lists, and
an inline `prompt` appended to the agent's own. A separate prompt file may come
later. The new-session prompt lists the profiles under the providers (`⌥p`);
no profile means today's settings.

A built-in `self` profile is always offered: the spawning session's own
provider, model, effort and mode, with no extra prompt. It is what a session
uses when no profiles are configured, or when none fits.

A profile is available in a repository only when `session.provider_access`
there allows its provider — its own, or the spawner's when it names none. A
global profile on a provider a repository does not allow is simply absent
there: `agents_profiles` does not list it, `agent_start` refuses it, the
new-session `⌥p` list does not offer it, and it is not checked against that
provider. A profile in a repository's own `repos[]` entry that names a
provider the same repository disables contradicts itself and is a config
error. `self` is always available.

## Agent tools (MCP server `loom-agents`)

| Tool                                          | Purpose                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `agents_profiles`                             | List profiles with descriptions, to choose a child                                                                          |
| `agent_start(profile, task, title, task_id?)` | Start a child; returns its id                                                                                               |
| `agent_message(id, text, delivery)`           | Steer a child through its queue (next boundary or end of turn)                                                              |
| `agent_status(id?)`                           | Status, last turn summary, diff stats, cost                                                                                 |
| `agent_read(id, since?)`                      | A bounded transcript excerpt or the final message                                                                           |
| `agent_interrupt(id)`, `agent_stop(id)`       | Stop a turn; archive the child                                                                                              |
| `agent_wait(ids, until, timeout)`             | Optional blocking wait                                                                                                      |
| `agent_merge(id)`                             | Bring a child's branch into the supervisor's branch (fast-forward/rebase); on conflict, report the files and change nothing |
| `report(status, summary, commit?, verdict?)`  | Given to children: explicit hand-back to the supervisor                                                                     |

`task_id` groups the runs of one task (e.g. implementer then verifier rounds)
for statistics.

## Workspaces

A child always gets its own Loom workspace, with its supervisor's isolation:

| Supervisor | Child                                              |
| ---------- | -------------------------------------------------- |
| in-place   | worktree from the repository's current HEAD        |
| worktree   | worktree from the supervisor's branch              |
| clone (VM) | worktree off the supervisor's clone, in its own VM |

A clone session's clone lives on the host under its session VM directory
(`~/.local/state/loom/session-vms/<repo>/<id>/`) and is mounted into its VM; the
host never runs Git against a clone, whose `.git` the guest controls. A clone
child's VM mounts the supervisor's clone at the same guest path (Git worktrees
record absolute paths) and creates its worktree with `git worktree add` inside
the guest. The child gets no access to host `.git`, like its supervisor; it can
reach the supervisor's clone, which shares its trust domain. Commits land in
the supervisor's clone, so `agent_merge` is a local merge there and nothing is
published to the host first. Two guests share that `.git` through Git's own
locks, with one index per worktree.

Children start from the supervisor's last commit; uncommitted supervisor
changes do not carry over, so `agent_start` warns about them. A verifier gets
its own read-only workspace at the commit the implementer reported, rather than
a live view of the implementer's worktree. Each child has its own VM; running
children inside the supervisor's VM is a later shared-VM feature.

## Communication

- Down: the supervisor's messages enter the child's queue (A9), labelled as
  coming from the supervisor. The user can message a child directly too. A
  child the user stopped stays stopped: the supervisor's message waits behind
  the user's hold, and only the user's send or release lifts it. Any other
  hold the supervisor's message lifts, going first as the user's send would:
  one its own stop (`agent_interrupt`) set, and Loom's own (a crash, a
  restart, a doubtful hand-over), reviving a cold child to recover it. The
  hold records whose it is ([message-queue.md](message-queue.md#holds));
  `agent_message`'s answer names the hold it found and whether the message
  waits behind it.
- Up: event-driven, never streamed output. The supervisor gets a short
  notification when a child calls `report`, finishes a turn, or fails or is
  interrupted — once per settled turn, identified by the turn rather than the
  state it settled in, with that turn's own final message; a turn the child
  has already moved on from is reported when the one it moved on to ends
  (the child's queue machine decides both: `turn_settled` and
  `report_ready` in [message-queue.md](message-queue.md#holds)). It reads:

  ```text
  [from your agent 7ea89088 "Title" (profile self)] It finished a turn.
  Its workspace: 1 commit ahead of its base, nothing uncommitted.
  Summary: <first line of the child's final message>
  For full details: run `agent_read` with id `<full child id>`
  ```

  The first line names the event (`It failed: <message>.`,
  `It was interrupted (user).`). The summary is the first non-empty line of the final
  message, cut at 2 KB and labelled `Summary (truncated):` when longer, and
  left out when there is no final message; Loom writes no summary of its own.
  A child's instructions ask it to make that line a one-sentence summary of
  the outcome, with the details after it. In the TUI, the `chat` log filter
  hides these notifications (they are queued with the author
  `agent:<child id>`, and the fleet already shows each child's state); the
  more detailed filters show them.

  It is queued as an end-of-turn entry labelled as coming from the child: a busy supervisor is not interrupted, an idle one is
  woken (a cold one revived), and one the user stopped stays stopped. A user's
  stop — an interrupt, an archive, a VM stop — always holds the supervisor's
  queue, empty or not, before the close awaits anything
  ([message-queue.md](message-queue.md#interrupt)), so the notification is
  just an entry behind the hold: it revives nothing, starts no turn and
  releases nothing. It waits behind any hold, a crashed supervisor's too.
  Whether the queue is held is decided as the entry is
  queued, so a stop that lands while a cold supervisor is coming back for it
  still holds it. The user's send or release (`r`) revives a cold supervisor
  and delivers. A child waiting for input (a permission or a question) is not
  notified: both go to the user, so the supervisor could not act on it, and
  the fleet already shows the child waiting, on its row and its supervisors'.
  Waits stay unnotified until supervisor question handling is designed.

- Nor is a stop the supervisor made itself (`agent_interrupt`, `agent_stop`)
  notified: the tool's answer already says so. Who asked for a stop travels
  with what it ends in: the child is `interrupted` by `supervisor` (not
  `user`), and a failure its turn ends in after the supervisor's stop — a late
  error from the adapter, a stream that breaks as `agent_stop` closes it — is
  attributed to the supervisor too, until the child's next turn starts. A
  user's stop is reported, including one that joins the supervisor's while
  it is under way; so are crashes and failures.
- A child gets no automatic commit reminder (`session.commit_reminder`) or
  auto-rebase nudge (`session.auto_rebase`): its turn end is simply its turn end, so
  a notification and `agent_wait` see it at once. A clean auto-rebase still
  moves its branch; a dirty or conflicted one leaves it alone, unannounced.
  Instead, the finished-turn notification says what the child's workspace
  holds — commits ahead of and behind its base, and whether it has
  uncommitted changes — and the supervisor decides whether to ask for a
  commit or a rebase. Top-level sessions keep both nudges.
- Recommended pattern: start children, end the turn, be woken by
  notifications; `agent_wait` exists for short waits.
- Questions and permissions: tool permissions always go to the user. Until a
  dedicated design exists, a child's questions also go to the user. How a
  supervisor receives and answers its children's questions, and which tools it
  uses for that, needs its own design rather than reusing `ask_user`.

## Lifecycle

- Interrupting a supervisor leaves its children running; they are independent
  sessions.
- Archiving or deleting a supervisor asks whether to stop its children or
  detach them.
- A supervisor archives its children with `agent_stop` once their work is
  merged or abandoned; `agent_start`, `agent_stop` and a nested supervisor's
  own note say so. Since supervisors tend not to, Loom reminds them
  (`[archive_reminder]`): when a supervisor's turn ends idle — top-level or
  nested, at the same point as the commit reminder, and only on a turn end
  that sent no rebase or commit nudge — it gets one Loom message (automated,
  like the commit reminder) naming its children that have finished (idle,
  failed or interrupted; not starting, running, working in the background,
  waiting for the user, or archived) and that it has not been reminded of,
  each with whether its branch is merged into the supervisor's, how many
  commits are not, and whether it has uncommitted changes:

  ```text
  [loom] You have 2 agents that have finished and are not archived: 7ea89088 "Widget" (idle, branch merged); 1c0ffee5 "Gadget" (failed, 2 commits not merged into yours, uncommitted changes). Archive each with agent_stop once its work is merged or no longer needed, or keep it if you will message it again. You won't be reminded about these again.
  ```

  Each child is named once (`archive_reminded` on its row, so a restart does
  not repeat it). A child whose report the supervisor has not taken up yet —
  still being made, or waiting in the supervisor's queue — waits for a later
  turn end, as does one with messages waiting in its own queue. The reminder
  goes straight to the session, not through its queue, so it never lifts or
  passes a hold: while the supervisor's queue is held, or has entries
  waiting (they start its next turn), nothing is sent and the next turn end
  decides again. The decision is a pure function over the children's states
  (`archiveReminder`, `backend/daemon/src/daemon/archive-reminder.ts`),
  taken as the turn ends and again once the children's Git facts are read;
  the message goes only if the supervisor is still idle in that turn's
  spell. A session with no children is unaffected.

- A daemon restart resumes supervisors and children like any session; queued
  notifications persist with the A9 queue.
- Notification hooks (`hooks` with `run`, e.g. a desktop toast) don't fire for
  an agent's turn ends or other events, which its supervisor handles, but do
  fire on `waiting`: a child's permission prompts and questions come to the
  user. Hooks get `LOOM_SESSION_SUPERVISOR` (empty for top-level sessions).

## Reparenting

- Supervise: on a running session A, choose a profile and write a prompt. Loom
  starts B, makes A its child, and seeds B with the prompt, a summary of A (the
  fork handoff's transcript-to-context path) and A's status. A keeps running;
  from then on its notifications go to B.
- Detach: the reverse.

## Fleet

Children are listed nested under their supervisor, sorted like the fleet's
own rows (status, then latest turn boundary), and reached like background
tasks: `↑`/`↓` walk the top-level rows, `→` enters a session's tasks and
then its children, `←`/`Esc` step back out. Selecting one gives the full
session with all controls. Archived children stay hidden until the supervisor
is entered, then follow the open ones, dimmed. The supervisor row's cost is
`Σ` its own plus its children's, as a display total only; the stored costs
stay per session.

A supervisor whose own turn has ended shows as background work while any
child is running or working in the background. A child at any depth waiting
on the user (a question or a permission prompt — these come to the user, not
the supervisor) raises every supervisor above it into needs input, over its
live turn or background work. A question, error or stop of the supervisor's
own still shows as itself, and an archived one stays archived; the table is
`SHOWN` in `frontend/tui/src/fleet-status.ts`. A child's failures show only
on the child's row.

The supervisor row marks children waiting on the user with `?N` (N counts
every waiting descendant), apart from its own glyph, which is its own
question:

    ◆ 7021fd6c      Coordinate the review              ?2 Σ$1.40

Its Detail names them, `? 2 agents waiting on you: <id> <title>, …  → opens`;
the question is answered on the child's own row.

All of this is the fleet's reading only: the supervisor's state stays idle,
which is what lets the queue hand it its children's reports while others
still run, and the desktop `waiting` hook still fires for the child alone.

## Data, not statistics UI

No statistics views or export: the facts live in `loom.db` for later ad hoc
queries. Each session records its `supervisor_id`, profile and `task_id`
alongside the model, usage and cost it already has; `report` calls, supervisor
messages, interrupts and outcomes are ordinary session events.

## Stages

1. Native sub-agents disabled for all sessions; profiles in config with the
   built-in `self`; profiles in the new-session prompt's `⌥p` list; `supervisor_id`,
   depth limit and nested fleet; `agents_profiles`, `agent_start`,
   `agent_message`, `agent_status`, `agent_read`, `agent_interrupt`,
   `agent_stop`; supervisor notifications; lifecycle defaults. Children of
   in-place and worktree supervisors (local or VM) get worktrees.
2. Clone children (worktree off the supervisor's clone), the read-only verifier
   workspace, `agent_merge`, reparenting.
3. `report` outcomes as events; supervisor question handling once designed;
   optional concurrency limits.

### Stage 1 as built

- Native sub-agents: Claude runs with `disallowedTools` `Agent` and `Task`;
  aisdk sessions lost their `task` tool; Codex app-servers start with
  `-c features.multi_agent=false` and
  `-c features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}`
  (start, resume and fork alike), and their developer instructions say to use
  the `loom-agents` tools for sub-agents, never Codex's own.
- The tools are mounted in each provider (Claude: an in-process `loom-agents`
  MCP server; aisdk: plain tools; Codex: dynamic tools, so only threads started
  with them have them). A call parks in the adapter as an `agent_call` event;
  the daemon runs it (`backend/daemon/src/daemon/agents.ts`) and answers with
  `respondToAgentCall` (worker protocol v5). A caller acts only on sessions
  whose `supervisor_id` is its own id. `agent_stop` takes `discard`, and
  `agent_wait` takes `until: any | all` and a timeout (default 60 s, at most
  600 s); `agent_read` returns at most 16 KB with a cursor.
- A profile's unset provider, model, effort and mode follow the spawner (a
  `plan` spawner's children run in `default`); `mcp` filters the session's MCP
  servers and names `loom-agents`; `skills` and the tool lists apply to Claude
  (`skills`, `tools`, `disallowedTools`) and aisdk (built-in tools), and are
  refused for providers that cannot honour them. A child's system prompt gets a
  note naming its supervisor before the profile's prompt.
- A Claude profile's `skills` are loaded from the provider's config dir
  (`<config_dir>/skills/<name>/SKILL.md`, default `~/.claude`) even when the
  provider's `setting_sources` leave out `user`: the adapter copies just those
  skills into a local plugin named `loom` for the session (`loom:<name>`; the
  Skill tool also takes the bare name). A VM session gets the copies in its
  profile directory first. A name with no `SKILL.md` fails the start, naming
  the path it looked for.
- A child's base is its supervisor's branch. When that branch is renamed
  (auto-titling), the child's stored base follows, and a running child is told
  the new name (`setBase`). A child in a private clone names it
  `origin/<name>`, which its clone has only once a fetch has brought it: it is
  told after its next sync, or once the checkout of its next start or resume
  (which fetches the stored base) has run, and keeps the old name, which still
  resolves, until then. Every base an agent is given comes through that one
  rule. A child whose row is being made reads its base once, before anything
  awaits, so a rename meanwhile is never undone.
- Closing a supervisor with open agents needs a choice (`children: stop |
detach` on `session.markDone` / `session.remove`, `--children` in the CLI,
  `c` in the TUI confirm, detach by default). Stopping a child with
  uncommitted changes keeps it, stopped.

## Known issues

- Live acceptance (2026-10-11, at `10e9622b`; `agents-claude`, `agents-codex`,
  `queue-claude`, `queue-codex` in `scripts/test-live-daemon-acceptance.ts`):
  all pass; nothing open from them.
- Codex models with `multi_agent_version` v2 still list Codex's built-in
  sub-agent tools (`spawn_agent`, `wait_agent`, …) with both feature flags
  off; only the developer instructions keep the model from using them
  (upstream openai/codex#50880; see Open).
- Supervisor question handling is not designed: a child's question does not
  reach its supervisor, which has no tool to answer or escalate it.
- Clone children (a worktree off the supervisor's clone) are stage 2, not
  built.

## Open

- Codex's switch for disabling its native sub-agents: `features.multi_agent`
  (on by default) and `features.multi_agent_v2` are set off; both flags exist
  in Codex 0.156.1. The bundled model catalogue also declares a per-model
  `multi_agent_version` (`v2` for the current models), and
  `codex debug prompt-input` still renders the v2 team instructions with both
  flags off, though it may not apply feature gating at all. Live (2026-10-11,
  Codex 0.153.2, `scripts/test-live-daemon-acceptance.ts codex-tools <model>`):
  for `gpt-5.6-luna` (`multi_agent_version` v1) the flags work, and no
  `spawn_agent`/`send_input`/`close_agent` is offered (its `wait` is code
  mode's, for an `exec` cell); for `gpt-5.6-terra` (v2) the thread still
  offers `spawn_agent`, `followup_task`, `send_message`, `wait_agent`,
  `interrupt_agent` and `list_agents`. The catalogue's `multi_agent_version`
  overrides both flags: upstream openai/codex#50880 (open, 0.160.0 too), whose
  reporter found only
  `features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}`
  refuses the spawn (the tools stay listed). Loom now passes that switch and
  tells the model not to use Codex's sub-agent tools. Live (2026-10-11, Codex
  0.153.2, terra): the v2 tools are still listed; asked to call `spawn_agent`
  once, the model declined, citing its configuration, so no call reached Codex
  and whether Codex itself refuses the spawn is unconfirmed. Untried: a
  `model_catalog_json` that pins `multi_agent_version` to v1.
- Shared VM for children (running inside the supervisor's VM).
- Clone children while the supervisor's VM is stopped: the clone directory
  persists on the host, so the child can still mount it; confirm nothing in the
  supervisor's resume path assumes exclusive use of its clone.
- Prompt files for long prompts.
- Supervisor question handling: how children's questions reach a supervisor,
  and its tools for answering or escalating.
