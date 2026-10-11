# Loom agents: sessions that supervise sessions

Status: design, agreed 2026-10-11; not implemented.

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
      "mcp": [],          // without "loom-agents" it cannot spawn
      "skills": [],
      "prompt": "You implement exactly the task you are given…"
    }
  }
}
```

Fields: `description` (what other agents read when choosing), provider/profile,
model, effort, mode, enabled MCP servers and skills, tool allow/deny lists, and
an inline `prompt` appended to the agent's own. A separate prompt file may come
later. The new-session prompt gets a profile toggle; no profile means today's
settings.

A built-in `self` profile is always offered: the spawning session's own
provider, model, effort and mode, with no extra prompt. It is what a session
uses when no profiles are configured, or when none fits.

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
  coming from the supervisor. The user can message a child directly too.
- Up: event-driven, never streamed output. The supervisor gets a short
  notification when a child calls `report`, finishes a turn (its final message,
  cut to about 2 KB with a pointer to `agent_read`; no model-written summary),
  is waiting for input, or fails or is interrupted. It is queued as an
  end-of-turn entry labelled as coming from the child: a busy supervisor is not
  interrupted, an idle one is woken.
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
- A daemon restart resumes supervisors and children like any session; queued
  notifications persist with the A9 queue.

## Reparenting

- Supervise: on a running session A, choose a profile and write a prompt. Loom
  starts B, makes A its child, and seeds B with the prompt, a summary of A (the
  fork handoff's transcript-to-context path) and A's status. A keeps running;
  from then on its notifications go to B.
- Detach: the reverse.

## Fleet

Children are listed nested under their supervisor, like background tasks
today, but selecting one gives the full session with all controls. The
supervisor row shows a summary such as "2 working · 1 needs input" and the
combined cost of itself and its children.

## Data, not statistics UI

No statistics views or export: the facts live in `loom.db` for later ad hoc
queries. Each session records its `supervisor_id`, profile and `task_id`
alongside the model, usage and cost it already has; `report` calls, supervisor
messages, interrupts and outcomes are ordinary session events.

## Stages

1. Native sub-agents disabled for all sessions; profiles in config with the
   built-in `self`; profile toggle in the new-session prompt; `supervisor_id`,
   depth limit and nested fleet; `agents_profiles`, `agent_start`,
   `agent_message`, `agent_status`, `agent_read`, `agent_interrupt`,
   `agent_stop`; supervisor notifications; lifecycle defaults. Children of
   in-place and worktree supervisors (local or VM) get worktrees.
2. Clone children (worktree off the supervisor's clone), the read-only verifier
   workspace, `agent_merge`, reparenting.
3. `report` outcomes as events; supervisor question handling once designed;
   optional concurrency limits.

## Open

- Codex's switch for disabling its native sub-agents.
- Shared VM for children (running inside the supervisor's VM).
- Clone children while the supervisor's VM is stopped: the clone directory
  persists on the host, so the child can still mount it; confirm nothing in the
  supervisor's resume path assumes exclusive use of its clone.
- Prompt files for long prompts.
- Supervisor question handling: how children's questions reach a supervisor,
  and its tools for answering or escalating.
