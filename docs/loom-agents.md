# Loom agents

A sub-agent is an ordinary Loom session with its own workspace, transcript,
queue and cost. `supervisor_id` records supervision; `parent_id` records
fork lineage. The user can message, interrupt or archive either session.

## Profiles

Define profiles globally or under `repos[]` in the user config:

```jsonc
{
  "agents": {
    "max_depth": 2,
    "profiles": {
      "implementer": {
        "description": "Implement a specific task",
        "provider": "claude:personal",
        "model": "claude-sonnet-5-5",
        "effort": "medium",
        "mode": "auto",
        "mcp_servers": { "deny": ["loom-agents"] },
        "skills": [],
        "prompt": "Implement the task and report how you verified it.",
      },
    },
  },
}
```

The built-in `self` profile inherits the supervisor's settings. Unset profile
fields inherit where applicable; a child of a plan-mode supervisor defaults to
normal mode. A profile changing provider uses that provider's model defaults.

`mcp_servers` accepts `allow` and `deny` lists. Omitted means all session
servers plus `loom-agents`, subject to `max_depth` (default 2).
An allow list must name `loom-agents` to permit spawning; deny wins.
`tools` filters built-ins; `skills` selects skills. Providers that cannot honor
these restrictions reject the profile.

Skills are shared by every provider and live at
`$XDG_CONFIG_HOME/loom/skills/<name>/SKILL.md`, defaulting to
`~/.config/loom/skills/<name>/SKILL.md`. Provider-specific skill directories
are not used. Move existing skills and their supporting files into this directory.

Each `SKILL.md` starts with YAML metadata:

```yaml
---
name: coding-style
description: Conventions to follow when writing or reviewing code.
---
Your skill instructions go here.
```

The name must match its directory. Omit `skills` to discover all Loom skills,
use `skills: ["coding-style"]` to select named skills, or `skills: []` to
disable skills. Missing or invalid selected skills fail startup. Loom adds a
catalog of names, descriptions and paths to each provider's instructions; the
agent reads a skill's full instructions when needed. The catalog refreshes on
start, resume and fork. VM sessions receive copies of the selected skills and
supporting files in the guest's Loom skill directory, mounted read-only.
Native provider skill discovery is disabled without changing shared provider
configuration.

Profiles whose providers are excluded by repository `session.provider_access`
are unavailable, including on resume. A repository-local profile naming a
provider that repository denies is a configuration error.

Use `loom run --profile NAME "task"` or the new-session `⌥p` picker.
CLI model/mode/workspace/isolation flags override profile defaults; a profile's
explicit provider cannot be overridden. `self` requires a running supervisor.

## Agent tools (MCP server `loom-agents`)

| Tool                                          | Purpose                                                         |
| --------------------------------------------- | --------------------------------------------------------------- |
| `agents_profiles`                             | List available profiles                                         |
| `agent_start(profile, task, title, task_id?)` | Start a child and return its ID                                 |
| `agent_message(id, text, delivery)`           | Queue a message at the next boundary or end of turn             |
| `agent_status(id?)`                           | Inspect state, Git changes and cost                             |
| `agent_read(id, since?)`                      | Read the final message or a transcript page, bounded to 16 KB   |
| `agent_interrupt(id)`                         | Stop the child's turn                                           |
| `agent_stop(id, discard?)`                    | Archive; refuse uncommitted changes unless explicitly discarded |
| `agent_wait(ids, until?, timeout?)`           | Wait for any/all children; default 60 s, maximum 600 s          |

A supervisor may act only on its own children. `task_id` groups repeated runs
of a task. Prefer starting children and ending the turn: notifications wake the
supervisor without polling.

Claude mounts an in-process MCP server, AISDK mounts plain tools, and Codex
uses dynamic tools registered at thread creation. Calls park as `agent_call`
events for the daemon to execute and answer.

## Workspaces

Children inherit isolation and get independent worktrees: from repository HEAD
for an in-place supervisor, or from a worktree supervisor's branch.
Uncommitted changes do not carry over; commit before spawning.
Renaming the supervisor's branch updates child bases.

Private-clone supervisors cannot yet spawn children. Read-only verifier
workspaces, shared VMs and automatic branch merging are also not implemented.

## Communication

Supervisor messages enter the child's [queue](message-queue.md#holds).
They lift supervisor/Loom holds and can revive a cold child, but wait behind
a user's stop. Only the user's send or release lifts a user hold.

A settled child turn produces one notification containing its outcome, Git
status and the first non-empty line of its final message (at most 2 KB).
Use `agent_read` for the rest. Reports identify the settled turn, so a delayed
report cannot be mistaken for the outcome of a newer turn.

Notifications are end-of-turn queue entries: they wake an idle supervisor,
wait behind busy work, and never lift any hold. Failed supervisor revival keeps
the report queued for a later resume. A supervisor's own stop is not reported
back to it; a user's stop and failures are.

Questions and permissions go to the user, not the supervisor. Sub-agents get
no automatic commit reminder or conflicted-rebase nudge: the supervisor sees
their Git status and decides what to request. Clean auto-rebase still applies.

## Lifecycle

Interrupting a supervisor leaves its children running. Archiving/deleting it
requires choosing `children: stop | detach` (CLI `--children`, TUI confirm).
Detach is the default.

Archive children once their work is merged or abandoned. Loom reminds an idle
supervisor once per finished child, after pending reports have been consumed.
The reminder waits while either queue has pending work and never bypasses a
hold. Reminder state persists across daemon restarts.

Sub-agent hooks fire for `waiting`, because the user must answer, but not
for ordinary turn ends. Hooks receive `LOOM_SESSION_SUPERVISOR`.

## Fleet

`→` enters children, `↑↓` selects one, and `←` returns.
Each child retains full session controls. Archived children appear dimmed
after open children when the supervisor is expanded.

Supervisor cost shows `Σ` of its own and descendant costs; storage remains
per session. A settled supervisor displays background activity while children
work, and `?N` when descendants need user input. This is presentation only:
its actual idle state still allows queued reports to arrive.
Answer questions on the child's row.

## Waiting on upstream

Codex v2 models still advertise native sub-agent tools despite both multi-agent
feature flags being off:
[openai/codex#50880](https://github.com/openai/codex/issues/50880).
Loom also sets `max_concurrent_threads_per_session=1` and instructs models to
use only Loom tools. Native spawn refusal has not been independently confirmed
by Loom's live check; tool visibility is not evidence of enforcement.

On Codex upgrades, run
`scripts/test-live-daemon-acceptance.ts codex-tools <v2 model>`.
Separately, `agents-codex <model>` checks Loom child creation, notification,
archive and retained transcript access. Loom supervision through Code Mode
passed with Codex 0.160.0 and `gpt-6-luna`; nested tools are callable.

## Open

Clone children, read-only verifier workspaces, `agent_merge`, reparenting,
explicit `report` outcomes, supervisor question handling, concurrency limits,
shared VMs and prompt files remain proposals.
