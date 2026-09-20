# Guest checkouts and the Git relay

Status: proposed design, not implemented. Working config name:
`session.isolation.checkout.mode = "clone"`.

## Goal

A VM session works in its own clone. The host repository is never mounted into
the guest. The clone's `origin` is the host repository, reached through a
per-session relay that serves exactly two Git services and enforces the ref
policy on the host side:

- read: the branch the session was created from and the session's own branch;
- write: the session's own branch, and nothing else.

Nothing the agent writes is ever read as Git configuration, hooks, or refs by
the host. Commits reach the host as pushed objects, which is the trust model
every Git forge already runs against untrusted pushers.

The host-side product is the branch itself. Pushes are automatic, so
`loom/<id8>` in your repository always holds the session's commits, and you
merge or cherry-pick from it with your own Git. Loom adds no landing command.

## Non-goals

- Changing local (non-VM) sessions. They keep the host worktree layout.
- Hiding provider credentials from the guest. That boundary is unchanged.
- Restricting what the agent does inside its own clone. Hooks, config, rewrites
  and force-pushes to its own branch are all allowed. Its blast radius is its
  branch.
- Git LFS and submodules that point at other remotes. Both need egress the
  guest does not have. They fail with Git's own errors.
- A second VM backend. The design uses smolvm mounts and socket relays as they
  exist today.

## Today

[repository-mounts.md](repository-mounts.md) describes the current layout: the
worktree, the repository root and the Git common directory are mounted
read-write at their host paths (`workspaceMounts` in
`runtime/src/packaged/workspace.ts`, applied by `vmArguments`). Real Git runs in
the guest against the host's `.git`. The doc states the consequence: shared
hooks and config and sibling worktrees are accessible, and changes to them can
execute code when Git later runs on the host.

An earlier design (commit 9fc3e72) routed Git through a host-side executor with
a command allowlist and per-invocation hardening. Commit 2a3c4ff removed it in
favour of mounts because the allowlist could not be finished: Git has no closed
set of config-driven execution paths. This design does not reintroduce a shim.
The host runs only `upload-pack` and `receive-pack`, which read pack data and the
host's own config.

## Topology

```text
host
  daemon ── session row: branch loom/<id8>, checkout=clone, cwd=<checkout>
  │
  ├─ <repo>/.git ─────────────── host refs: refs/heads/loom/<id8> (host creates,
  │                               guest pushes, host never rewrites)
  │
  ├─ supervisor (trusted, per session)
  │    ├─ egress relay   <state>/egress.sock → CONNECT proxy       (unchanged)
  │    ├─ MCP relays     <state>/mcp-N.sock  → 127.0.0.1:port      (unchanged)
  │    └─ git relay      <state>/git.sock    → spawn git upload-pack /
  │                                            receive-pack on <repo>/.git
  │                                            with policy from
  │                                            <sessionDirectory>/git-policy.json
  │
  └─ <sessionDirectory>/checkout ── the clone, a plain host directory that
                                    host Git never opens

guest (smolvm)
  /run/loom/git.sock  ←──── --mount-socket
  127.0.0.1:3129      ←──── startGuestRelay (same as MCP ports)
  <checkout>          ←──── -v host:guest at the same absolute path, rw
     .git/config: remote.origin.url = git://127.0.0.1:3129/repo
```

The guest sees one Git remote and cannot name another host, port or path. The
relay sees one repository and one session branch. Everything else is Git.

## Host side

### Session refs

Session creation for a clone session does not run `git worktree add`. It runs
`git branch loom/<id8> <base>` in the host repository, so the branch always
exists on the host from the first snapshot onward, exactly as today. The
session row stores `checkout = "clone"`, `worktree = <sessionDirectory>/checkout`
(the cwd, see below) and the branch.

The host creates the ref once and then only reads it. Every later movement of
`refs/heads/loom/<id8>` is a push from the guest. This single rule removes
every host-side write path that would otherwise have to be reconciled with the
guest's copy: auto-rebase, undo and fork all become guest operations that end in
a push (see "Guest Git operations").

The one exception is deletion: `session.remove --delete-branch` deletes the
ref on the host after the VM is stopped, as today.

### Git relay

`runtime/src/session-vm/git-relay.ts`, `startGitRelay(socket, options)`. Same
shape as `startMcpRelay`: listen on a host Unix socket in `<state>`, mounted
into the guest with `--mount-socket <state>/git.sock:/run/loom/git.sock`. The
guest side is `startGuestRelay` on a fixed loopback port, `3129`, between the
egress proxy on `3128` and the MCP ports from `3130`.

Per connection the relay:

1. Reads one pkt-line, capped at 4 KiB, with a 10 s deadline. Format is the
   git-daemon request: `<service> <path>\0host=<h>\0[\0version=2\0]`.
2. Requires `service` to be exactly `git-upload-pack` or `git-receive-pack`,
   and `path` to be exactly `/repo`. Any other request closes the connection
   with an `ERR` pkt-line. No path is ever resolved from the request.
3. Reads `<sessionDirectory>/git-policy.json`. This is the only mutable input;
   it is host-owned and written atomically by the daemon (`writeRecoveryFile`).
4. Spawns `git` on the host with cwd `<gitCommonDir>` and the argv below. The
   child's environment is built from scratch and never contains `GIT_PROTOCOL`,
   so both services speak protocol v0 whatever the request line asked for. This
   is a security requirement, not a simplification; see "Ref policy".
5. Pipes the socket to the child's stdio in both directions until either side
   closes. Idle timeout 120 s, at most 4 concurrent children per session.

`options` carries `gitDir` (the host repository's common directory, from the
binding) and `policyFile`. The supervisor gets these through the existing
bootstrap frame; `VmBinding` gains `git?: { dir: string; policy: string }`.

The relay never interprets pack data, never parses refs and never runs any Git
command other than the two services. It is the "purpose-built raw relay": one
request line, then bytes.

### Ref policy

`git-policy.json`:

```json
{ "branch": "loom/<id8>", "base": "main", "visible": [] }
```

`upload-pack` argv:

```
git -c transfer.hideRefs=HEAD
    -c transfer.hideRefs=refs/
    -c transfer.hideRefs=!refs/heads/<base>
    -c transfer.hideRefs=!refs/heads/<branch>
    -c transfer.hideRefs=!<entry>           (one per `visible` entry; none by default)
    -c uploadpack.allowFilter=false
    -c uploadpack.allowAnySHA1InWant=false
    -c uploadpack.allowTipSHA1InWant=false
    -c uploadpack.allowReachableSHA1InWant=false
    upload-pack --strict --timeout=120 .
```

Later `hideRefs` entries win, so `refs/` hides everything and the negated
entries expose the parent branch and the session branch, and nothing else.
Sibling sessions' branches, the user's other branches, tags and anything under
`refs/loom` are neither advertised nor fetchable by hash.

Three details carry that guarantee. Each was checked against real Git with a
throwaway repository before being written down:

- `HEAD` is hidden separately. `refs/` does not cover it, and an advertised
  `HEAD` discloses whatever commit the host checkout is on, which may be a
  hidden branch.
- Protocol v0 only. Under protocol v2 `upload-pack` serves any object named in
  a `want`, hidden or not, and ignores the `allow*SHA1InWant` settings. The
  same request under v0 fails with "Server does not allow request for
  unadvertised object".
- No partial clone. Lazy blob fetches are by-hash wants, so a
  `--filter=blob:none` clone only works with `allowReachableSHA1InWant`, and
  Git computes that reachability from all refs including hidden ones: with it
  enabled a hidden commit was fetchable. The clone is therefore a full clone of
  the visible refs, and `allowFilter` is off so a guest cannot create a clone
  that later needs by-hash wants.

`base` is always a branch name. For a new session it is the configured base
branch. A fork inherits its parent's `base`: today a fork's row records the
parent's HEAD SHA as `baseBranch`, which `hideRefs` cannot name, and the
parent's session branch stays hidden from the child like any other sibling. The
child loses nothing, because its own branch starts at the parent's tip.

Tags are hidden by default, so `git describe` in the guest finds none. A
repository whose build needs them lists `refs/tags/` in `visible_refs`.

`receive-pack` argv:

```
git -c receive.hideRefs=HEAD
    -c receive.hideRefs=refs/
    -c receive.hideRefs=!refs/heads/<branch>
    -c core.hooksPath=/dev/null
    -c receive.denyDeletes=true
    -c receive.denyNonFastForwards=false
    -c receive.denyCurrentBranch=refuse
    -c receive.fsckObjects=true
    -c receive.maxInputSize=<configurable, default 512 MiB>
    -c receive.advertisePushOptions=false
    -c receive.autogc=false
    receive-pack .
```

The write policy is the receive-side hide list: `receive-pack` refuses to
update or create a hidden ref ("deny updating a hidden ref"), and the only ref
left visible to it is the session branch. The base branch is readable through
`upload-pack` but hidden from `receive-pack`, so it cannot be pushed. The push
advertisement therefore names one ref and no `.have` lines for hidden history.

An earlier draft enforced this with a Loom-owned `update` hook under
`<repo>/.loom/hooks`. That directory is inside the repository, which mount-mode
sessions can write, and an executable policy file is one more thing to protect.
The hide list needs no file at all. `core.hooksPath=/dev/null` means the
repository's own `pre-receive`, `update` and `post-receive` hooks never run for
session pushes, regardless of the host repository's config. Command-line config
is read after the repository's, and later `hideRefs` entries win, so nothing in
the host config can re-expose a ref.

Non-fast-forward updates to the session branch are allowed; deletes are refused
by config. `denyCurrentBranch=refuse` covers the case where you have checked
the session branch out on the host to look at it: the push is refused with
Git's message, and the guest sees it as a push error. `autogc=false` keeps a
session push from starting maintenance in your repository.

Both services run with an environment built from scratch and with global and
system Git config disabled, so only the repository's own config and the argv
above apply. Branch names in the policy file are validated against a
conservative subset of `check-ref-format` before they reach a `-c` value.

Everything here is host-owned: the policy file and the argv. The guest supplies
only pack data and ref names.

## Guest side

### Checkout directory

The clone lives at `<sessionDirectory>/checkout`, beside the existing
`profile` directory under `sessionVmDirectory(repo, id)`. It is mounted into the
guest read-write at the same absolute path, added by the supervisor next to the
profile mount (it lives under `sessionDirectory`, which `vmArguments` refuses
in `mounts`).

Why a host directory rather than a guest disk: session disks are disposable
per launch, and the clone has to survive stop, resume and daemon restart. Why
the same absolute path: the worker, `commit`/`status`, `loom shell`, hook
environment variables and the TUI all pass the cwd through unchanged, and
nothing needs to translate between host and guest paths.

Why this is not the vector the current mounts have: the directory is outside
the repository and outside any path host Git resolves. The daemon never runs
Git with this directory as cwd or `--git-dir`. The only host-side operations on
it are `Deno.stat`, byte copies (fork) and recursive removal (archive, delete).
Nobody should run `git` inside it on the host; the path under
`~/.local/state/loom/session-vms/<hash>/<id>/` makes that unlikely, and the
TUI never shows it as a place to go.

`workspaceMounts` must not be called for a clone session: it runs
`git rev-parse` in the workspace on the host. `session-vm-worker.ts` and
`runtime-mcp.ts` pass `[checkout]` directly. The same applies to packaged MCP
VMs (Tilth): they mount the checkout only, never the host repository.

The shared package cache at `<repoRoot>/.loom/package-cache` lives inside the
repository mount, so clone sessions do not get it: the launcher leaves
`VmBinding.packageCache` unset, no `cache-path` is written, and `guest.ts`
already falls back to `/storage/loom-cache` on the session disk. That disk is
seeded from the prepared base, so `loom vm prepare` is what makes package
installs warm. No replacement host-side cache is designed here.

### Setup

`runtime/src/session-vm/checkout.ts`, run by `guest.ts` before the worker
starts serving, driven by `/run/loom/private/checkout.json`:

```json
{
  "path": "<checkout>",
  "branch": "loom/<id8>",
  "base": "main",
  "identity": { "name": "Loom (claude-sonnet-5)", "email": "loom+claude-sonnet-5@localhost" }
}
```

1. If `<path>/.git` does not exist:
   `git clone --no-checkout --branch <base> git://127.0.0.1:3129/repo <path>`.
   This is a full clone of the two visible branches over a local socket. Then
   `git checkout -B <branch> origin/<branch>`; the host created that ref, so it
   always exists.
2. If it exists: `git remote set-url origin git://127.0.0.1:3129/repo`, then
   if the checked-out branch differs from `branch` and the old name is the
   session's previous name, `git branch -m`. Then `git fetch --prune origin`.
3. Always: set `branch.<branch>.remote/merge`, `remote.origin.push =
+refs/heads/<branch>:refs/heads/<branch>`, `user.name`/`user.email` from
   `identity`, and `core.hooksPath` to a guest-private directory holding a
   `pre-push` that refuses any remote except `origin`. That hook is an accident
   guard for the agent, not a security control; the agent can remove it and
   gains nothing, because no other remote is reachable.

Setup failures are reported through the existing `startupStages` /
`reportStartup` path as a new `checkout` stage and put the session in `error`.

### Push

The session branch on the host is only ever moved by the guest. Three things
push, all of them Loom code running in the guest:

- the `commit` tool, after a successful commit;
- the worker at `turn_end`, if HEAD differs from `origin/<branch>`;
- the daemon on request (`git.push` below), used before fork and before
  archive to make sure the host has the tip.

Pushes use the configured `+` refspec, so a rewritten branch (undo, rebase in
the guest, an agent `commit --amend`) just replaces the host ref. Because the
host never writes the ref, a force from the guest can never clobber host work.

A push that fails because the relay is down or the policy rejected it is
reported as an operator notice with Git's stderr and retried at the next turn
end. Commits are never lost: they are in the clone on the host filesystem.

### Guest Git operations

The daemon already drives the guest through the worker protocol
(`runtime/src/worker/serve.ts`, `RemoteWorkerSession`). Clone sessions add a
`git` request family, handled in the guest, each running Git in the checkout and
returning a structured result. They run only when the session's op gate allows
it, the same gate that serialises compaction today.

| request      | does                                                                       | replaces                                   |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------ |
| `git.facts`  | branch, HEAD, dirty, last subject, commit count, pending op                | `WorktreeManager.facts` on the host        |
| `git.push`   | push the session branch                                                    | n/a                                        |
| `git.sync`   | `fetch origin <base>` then `rebase`/`merge origin/<base>`; push on success | `syncOntoBase` (auto-rebase, `r`, RPC)     |
| `git.reset`  | `reset --hard <sha>` if clean; push                                        | `restoreTo` (undo with `restoreWorktree`)  |
| `git.rename` | `branch -m <old> <new>`, fix upstream                                      | `renameBranch`'s host half stays host-side |
| `git.hook`   | run a `check` hook command in the checkout, bounded output                 | `executeShellHook` on the host             |

Outcomes for `git.sync` are the existing `no-base | current | dirty | busy |
conflict | error | updated` set, so the daemon's nudge messages and notices are
unchanged. Ahead/behind counts for the snapshot are computed on the host from
its own refs (`rev-list --left-right --count <base>...loom/<id8>`), which is
already how `facts` does it; only `dirty`, `pendingOp` and unpushed HEAD come
from the guest.

## Daemon integration

Introduce a `SessionCheckout` seam in `backend/daemon/src/daemon/` with two
implementations, `HostWorktree` (current `WorktreeManager` behaviour) and
`GuestClone`, chosen per session from the row's `checkout` column. The daemon
stops passing paths to `#worktrees.*` and asks the checkout object instead.
The explorer's three grep targets are the full call-site list:

- `snap.worktree ?? (snap.inPlace ? this.repoRoot : null)` (facts, sweep,
  enrich) → `checkout.facts()`.
- `session.worktree ?? this.#opts.repoRoot` in `hooks.ts` → see hooks below.
- `row.worktree ?? this.repoRoot` for adapter cwd, shell and reattach → the
  clone path; unchanged in shape.

| touchpoint                           | HostWorktree (today)                          | GuestClone                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create                               | `worktree add -b`                             | `git branch loom/<id8> <base>` on host; write `checkout.json` + `git-policy.json`                                                                                                                                                                                                           |
| adapter cwd / `LOOM_WORKTREE`        | worktree path                                 | checkout path                                                                                                                                                                                                                                                                               |
| git facts, 15 s sweep                | host `git -C <wt>`                            | host refs for ahead/behind + `git.facts` from the guest; sweep sends the request when clients are connected                                                                                                                                                                                 |
| commit identity                      | `git config --worktree`                       | `identity` in `checkout.json`; `setIdentity` after a model switch rewrites it and, if running, sends `git.rename`-style config update                                                                                                                                                       |
| branch rename from title             | `git branch -m` on host                       | host `branch -m` + policy file update + `git.rename` to the guest; a stopped VM reconciles at next setup                                                                                                                                                                                    |
| auto-rebase, `r`, `session.rebase`   | host `syncOntoBase`                           | daemon compares host refs; if behind, sends `git.sync`; same outcomes and nudges                                                                                                                                                                                                            |
| commit reminder                      | host `isDirty`                                | `dirty` from the last `git.facts`                                                                                                                                                                                                                                                           |
| checkpoints (`headSha`, `headDirty`) | host                                          | from `git.facts` at turn end                                                                                                                                                                                                                                                                |
| undo `restoreWorktree`               | host `reset --hard`                           | `git.reset`                                                                                                                                                                                                                                                                                 |
| fork                                 | `worktree add` at parent HEAD + `copyChanges` | parent must not be mid-turn (the existing `session.fork` gate), `git.push` if its VM is running, byte-copy `<parent>/checkout` → `<child>/checkout` (reflink where possible), host creates `loom/<child>` at parent's host tip, child setup renames the branch and prunes stale remote refs |
| archive (`done`)                     | `worktree remove`, keep branch                | stop VM, `git.push` first if running, refuse if dirty unless `force`, remove checkout dir, keep branch and profile                                                                                                                                                                          |
| reopen after archive                 | `reattach`                                    | setup step clones again                                                                                                                                                                                                                                                                     |
| `session.remove`                     | remove worktree, optional branch delete       | remove checkout dir + profile, optional branch delete                                                                                                                                                                                                                                       |
| `gc`                                 | reclaim failed worktree removal               | reclaim a checkout dir whose removal failed                                                                                                                                                                                                                                                 |
| hygiene at startup                   | clear stale `index.lock`, `worktree prune`    | nothing; the clone's locks are the guest's business                                                                                                                                                                                                                                         |
| `loom shell`, TUI `s`                | VM exec at the worktree                       | VM exec at the checkout, unchanged; `session-shell.ts` already refuses a host fallback for VM sessions                                                                                                                                                                                      |
| `commit`/`status` tools              | guest git at the mounted worktree             | guest git at the checkout; `commit` also pushes                                                                                                                                                                                                                                             |
| `copybranch`, `gitLineText`          | branch                                        | unchanged; add an `unpushed` marker when guest HEAD ≠ host ref                                                                                                                                                                                                                              |
| `workspaceMounts`                    | worktree + repo + common dir                  | `[checkout]` only                                                                                                                                                                                                                                                                           |

Hooks (`hooks.ts`): for clone sessions, `check` hooks run in the guest through
`git.hook`, because their commands (`deno task lint`, `oxfmt`) execute
project-defined tasks and must not run on the host over agent-written files.
`notify` hooks keep running on the host with cwd `repoRoot`; their environment
still carries `LOOM_FILE`/`LOOM_FILES` as checkout paths. Written-path detection
is unchanged (`tool-paths.ts`), but paths are resolved against the checkout and
must be rejected if they escape it after `realPath`, because the agent can
create symlinks in the checkout and a notify hook may read `$LOOM_FILE`.

Store: migration adds `sessions.checkout TEXT CHECK (checkout IN
('worktree','clone'))`; null reads as `worktree`. Snapshot gains
`checkout` and `git.unpushed: boolean`. `gitFactsSchema` is otherwise unchanged.

Wire: no new RPCs for the sandbox itself. `session.rebase`, `session.rewind`,
`session.fork`, `session.markDone`, `session.remove`, `session.gc` keep their
parameters and route through the seam.

## Taking commits on the host

There is no Loom command for this. The session branch is an ordinary host ref
that auto-push keeps current, the TUI's `copybranch` puts its name on the
clipboard, and the `unpushed` marker says when the guest is ahead of it:

```sh
git log --oneline main..loom/<branch>          # what the session did
git cherry -v main loom/<branch>               # `-` marks patches already on main
git cherry-pick -x <sha>...                    # take some
git merge loom/<branch>                        # or take all
```

This runs in your own checkout under your own identity, on refs the host
trusts. After you take commits, `r` (`session.rebase`) makes the session rebase
onto the base, which drops the patches now present there.

### Later: a per-session status view

A `git status`-style view per session (branch, ahead/behind, unpushed commits,
staged, unstaged and untracked files, optionally a diff) is wanted later and is
not part of these phases. The design leaves room for it:

- It is one more guest request, `git.status`, in the same family as `git.facts`.
  The guest handler can call `statusInWorktree` (`core/src/status.ts`), which
  already backs the agent's `status` tool and already bounds the patch. Worktree
  sessions call the same function on the host, so the view has one data shape.
- Commit-level data (ahead/behind, `<base>..<branch>` log, `git cherry` marks)
  comes from host refs and works whether or not the VM is running.
- Working-tree data exists only in the guest. The daemon must not run Git in
  the checkout to get it. For a stopped VM the view shows the result cached at
  the last turn end, marked stale, rather than starting a VM to refresh.
- The result is untrusted text. File names and diff content come from the
  agent, so the daemon bounds the size and the renderer neutralises terminal
  control sequences, the way `clean` in `frontend/tui/src/markdown.ts` and `safe`
  in `cli/src/vm.ts` already do.

## Configuration

```jsonc
{
  "session": {
    "isolation": {
      "checkout": {
        "mode": "clone", // "clone" | "mount"; mount is today's layout
        "visible_refs": [], // extra host refs readable by the guest, e.g. "refs/tags/"
        "max_push_bytes": 536870912,
      },
    },
  },
}
```

`mode` applies to VM sessions only; local sessions ignore it. It is captured
at session creation and stored on the row, so changing it affects new sessions
and reopened archived sessions, never a running one.

`visible_refs` entries are exact ref prefixes under `refs/`, validated like
`extra_allowed_hosts`. They are appended as negated `hideRefs` entries. Wildcards
are not accepted. The default is empty: the guest reads the parent branch and
its own branch only.

There is no object-sharing, partial-clone or clone-cache option. First start
pays for a full clone of the visible branches through the relay; dependency and
toolchain warmth comes from the prepared base.

## Storage and lifecycle

```
~/.local/state/loom/session-vms/<repo-hash>/<id>/
  profile/            provider profile (unchanged)
  checkout/           the clone
  git-policy.json     current branch + visible refs, host-written
  active.json, owner.lock ... (unchanged)
/tmp/loom-session-vm-*/
  git.sock            relay socket (removed with the state dir)
  private/checkout.json
```

`recoverSessionVm`, `cleanupSessionVm` and the inventory need no new fields
beyond listing `checkout` under `paths`. `pruneRepositorySessionDisks` and
`loom vm` inventory commands report checkout size. `removeSessionVmProfile`
grows to remove `checkout` and the policy file.

Daemon restart: nothing to reconcile. The clone is on disk; the host ref is
wherever the last push left it; the next turn end pushes whatever is ahead.

## Security analysis

| vector                                              | today (mount)                     | with guest checkouts                                                                  |
| --------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| hooks / config written by the agent run on the host | yes, on next host Git command     | no: host Git never opens the clone; receive-pack hooks are forced to a Loom directory |
| `.git` file redirect in the worktree                | yes, if a human runs Git there    | the clone is outside the repo and outside any path the TUI or daemon offers           |
| moving or deleting other refs                       | yes, shared `.git`                | receive-side `hideRefs`: own branch only; `denyDeletes`                               |
| reading sibling sessions' branches or user branches | yes                               | hidden by `hideRefs` including `HEAD`; protocol v0 only, so not fetchable by hash     |
| malformed objects                                   | written directly into host `.git` | `receive.fsckObjects`; `upload-pack --strict`                                         |
| filling the host object store                       | unbounded                         | `receive.maxInputSize`; connection and process caps                                   |
| reaching another Git remote                         | blocked by network policy         | unchanged; the guest `pre-push` guard is only a courtesy                              |
| relay request forgery (other path, other service)   | n/a                               | fixed path, two services, one pkt-line, no shell                                      |
| symlinks in the checkout read by host tools         | same for the worktree             | `check` hooks run in the guest; notify-hook paths are `realPath`-checked              |
| provider credential in the guest                    | access-only token                 | unchanged                                                                             |

`receive-pack` and `upload-pack` run on the host as the user, but so do they
whenever the user fetches from anyone. The attack surface is Git's pack
parsing with fsck on, which is the surface every hosted forge exposes to
anonymous pushers.

What this does not do: it does not make the pushed _content_ safe to execute.
A session commit can change `deno.json`, `.githooks/` or a build script, exactly
as a pull request can. Merging or cherry-picking it puts it in your checkout;
running it is still your review.

## Compatibility and migration

- Existing rows have `checkout = null`, read as `worktree`. They keep their
  worktrees until archived. Reopening an archived session under `mode: "clone"`
  clones its branch; the branch is all that survives archive today anyway.
- The relay needs nothing installed in the repository, so a daemon upgrade
  requires no per-repository preparation.
- Runtime artifacts change (new guest stage, new relay); bump
  `session-environment-version`. Prepared bases are disk state only and remain
  valid; `loom vm prepare` still mounts a disposable host worktree because the
  preparation VM is not a session and never receives a relay. That mount is
  read-write today; make it read-only in the same change, since preparation
  only needs to read the tree.
- The `isolate` proposal in [isolation-fork-spec.md](isolation-fork-spec.md)
  deliberately mounts the real checkout. That is a different product with a
  different trust statement and is not affected.
- `docs/repository-mounts.md` becomes the description of `mode: "mount"`.

## Testing

Deterministic, no VM:

- `test/git-relay.test.ts`: pkt-line parsing and rejection (bad service, bad
  path, oversize, slow client), `upload-pack` over the relay against a fixture
  repo shows only the parent branch and own branch (no `HEAD`, no tags, no
  sibling session) with the host checked out on a hidden branch, a hidden commit
  and a hidden blob are refused by hash when the client requests protocol v2, a
  `--filter` clone is refused, a fork's policy names the inherited base branch,
  a `visible_refs` entry exposes exactly that prefix, `receive-pack` accepts a
  push to the own branch including
  non-fast-forward, rejects another branch, a delete, and a push while the
  branch is checked out on the host, the repository's own `pre-receive` never
  runs, and a policy-file change takes effect on the next connection.
- `test/guest-checkout.test.ts`: `checkout.ts` against a relay on a Unix socket
  (it only needs a listener, not a VM): fresh clone, resume, rename reconcile,
  identity, `pre-push` guard, and the fork-copy prune.
- `test/worktree-session.test.ts` gains a `GuestClone` variant of each lifecycle
  case using the mock connector with the guest-side `git.*` handlers run
  in-process against the checkout dir.
- `test/session-hooks.test.ts`: check hooks route to the guest; notify hook path
  escape is rejected.

Live, with an artifact and smolvm (`scripts/test-guest-checkout-vm.ts`):
clone in a real guest, commit, tool push, host ref moved, `git ls-remote` from
the guest lists exactly the allowed refs, a pushed hook file does nothing on the
host, `loom shell` lands in the checkout, archive and reopen.

## Phases

1. **Relay and checkout.** `git-relay.ts`, `checkout.ts`,
   guest port `3129`, `VmBinding.git`, config and store columns, `SessionCheckout`
   seam with `GuestClone` covering create, cwd, facts, push, commit tool, shell,
   archive, remove, gc. Behind `mode: "clone"`.
2. **Lifecycle parity.** `git.sync`, `git.reset`, `git.rename`, `git.hook`,
   fork by directory copy, check hooks in the guest, `unpushed` marker.
3. **Default.** Flip `mode` to `clone` for VM sessions, move
   `repository-mounts.md` under the mount option, update `isolation-plan.md`'s
   boundary list.

Later, outside these phases: the per-session status view (`git.status`).

## Decisions

- Visibility is the parent branch plus the session's own branch. Everything
  else, tags included, is opt-in through `visible_refs`.
- Fork requires a parent that is not mid-turn. `session.fork` already enforces
  this for transcript reasons; the directory copy relies on the same gate and
  adds no snapshot-commit machinery.
- No cache work. No shared object store, no host package cache for clone
  sessions. `loom vm prepare` covers warm starts.
- No landing command. Auto-push keeps the host branch current and ordinary Git
  does the rest. A picker over `git cherry` can be added later without touching
  the sandbox design, since it would read only host refs.

## Open questions

- Codex sessions create `.agents`/`.codex` inside the workspace for Bubblewrap;
  with the checkout on a host directory that continues to work, but verify.

## Alternatives considered

- **Host-side Git executor with a command allowlist.** Tried (9fc3e72), removed
  (2a3c4ff). Open-ended surface.
- **Mount the worktree, private guest `.git` with alternates.** Keeps live file
  visibility on the host at the cost of an agent-writable `.git` file in a
  directory humans do visit. Rejected.
- **Bundle relay per turn** (Bulkhead's ADR-0004). Same inert-exchange property,
  but batchy, unconditional and not what Git's own tooling expects. A live pack
  protocol over a fixed relay is the same idea with `git fetch` semantics.
- **`GIT_NAMESPACE` per session on the host.** Would let the guest push any
  name into a namespace the host then promotes. Two hops and a promotion step
  for no gain over the receive-side hide list.
- **Approval gate on push.** Bulkhead needs one because its remote is public.
  Here the remote is a private branch on your own machine and the gate is the
  merge or cherry-pick you do anyway.
