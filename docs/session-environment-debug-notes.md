# Session environment debugging — 2026-09-12

## Confirmed fixes

1. **Fail before VM startup when preparation is missing.** The launcher now checks
   prepared-disk compatibility before credentials, session state, or VM startup.
   Explicit preparation and sessions without an environment requirement may still
   boot the generic runtime. Committed in `672ba8e`.
2. **Keep Nix's Git cache guest-owned.** Host-mounted `XDG_CACHE_HOME` caused
   libgit2's “repository path is not owned by current user” error during
   `nix develop`. It now uses `/storage/loom-cache`. Deno, npm, pip and uv retain
   their explicit shared host cache paths. Also committed in `672ba8e`.
3. **Select a compatible provider runtime's base.** Preparation previously built
   Claude's image by default, but the user launched ChatGPT/Codex. Those artifacts
   differed and only one base was selected per repo. The current uncommitted fix
   uses artifact-specific selection files and prepares each distinct enabled
   runtime. Existing `current.json` selections remain readable for their matching
   artifact. Idle-session refresh also selects the session's runtime.
4. **Restore saved disks' logical capacity.** A saved storage file was 128 MiB
   shorter than its ext4 filesystem: 8,355,840 physical blocks versus 8,388,608
   filesystem blocks. A qcow2 clone inherited the shorter size, and guest startup
   tried filesystem repair/reformatting before failing. Copies now extend
   sparsely to at least the configured 32 GiB storage / 8 GiB overlay capacity.
   Older short immutable bases get a private, extended backing copy before cloning;
   the immutable original is not modified. Newly saved bases are normalized too.
5. **Preserve prepared PATH in login shells.** Debian's login profile reset PATH,
   leaving the provider able to start but its tools unable to find Deno or Node.
   Guest initialization writes `/etc/profile.d/zz-loom-path.sh` using a safely
   shell-quoted runtime PATH after environment restoration.
6. **Create Codex sandbox mount points before VM entry.** In fresh nested
   worktrees, Bubblewrap failed with `Can't mkdir .../.agents: Permission denied`.
   Creating `.agents` and `.codex` before boot resolved it. The host launcher now
   creates those directories for Codex-authenticated sessions. This does not
   disable the sandbox or copy any credentials into the directories.

Fixes 3–6 are uncommitted, alongside their tests and documentation. Preserve these
changes while implementing the shared image.

## Verification completed

- Full packaged `environment prepare` succeeded for Claude, Codex and AISDK in
  `/home/user/dev/loom`, at committed HEAD `672ba8e`.
- 23 targeted tests passed across session startup, repo bases, disk copies,
  environment lifecycle and environment setup. Full typecheck and changed-file
  lint passed. The final mount-point edit additionally passed startup tests/lint.
- Credential-free workers booted the prepared Claude and AISDK images and ran
  login-shell checks: Deno 2.9.6, Node 24.19.0, and
  `XDG_CACHE_HOME=/storage/loom-cache`.
- Real ChatGPT session `482969b8-01d8-49b8-a339-bd200d47654d` started in a fresh
  nested worktree, ran those checks without manual setup and returned
  `LOOM_ENVIRONMENT_OK`. After daemon restart it reran Deno/Node successfully and
  returned `LOOM_RESUME_OK`. Last observed status: idle, three turns, clean worktree.
- Earlier temporary smoke sessions were archived. The final successful session
  remains available for inspection.
- Claude's real account reported “needs login”; credential-free VM verification
  passed. Do not claim its account authentication was fixed.

## Installed build and artifacts

Before the shared-image follow-up, the Nix profile pointed at this tested host build:

`/nix/store/3cfk4nv3dsxsgpagnf34ndwp43yjmaqq-loom-0.0.0-g672ba8e-dirty`

It was built with `/tmp/loom-host-envfix.nix`, retaining the verified guest registry
`/nix/store/pfiqxjf0wwvmkczf455ziigs6mpvr5m3-loom-bundled-runtimes.json`.
The registry belongs to the full guest build
`/nix/store/c3b7qacry18nqsnnw72qbzw9pmxfark9-loom-0.0.0-g672ba8e-dirty`.
Only the last mount-point fix was added in the host-only rebuild, avoiding another
unnecessary guest rebuild/preparation cycle. The profile was installed from its
exact store path and no longer records the local flake as an upgrade source; the
user has been told this. Normal future flake installation can restore that link.

Useful temporary evidence:

- `/tmp/loom-final-prepare.log`: successful three-runtime packaged preparation.
- `/tmp/loom-verify-prepared-runtime.ts`: credential-free live VM/tool check.
- `/tmp/loom-supervisor-debug-error` and `...-console`: captured earlier failures.
- Temporary instrumentation in `supervisor.ts` was removed. It has no pending diff.

## Other observed quirks, not fixed

- Preparing separate images took about 13 minutes and repeated Nix downloads.
- “Starting VM…” can remain unchanged for minutes during cold startup.
- Host/backend failures are hidden behind “worker connection ended”; diagnosis
  required temporary host-only error/log capture.
- `loom stop` returns before shutdown finishes. An immediately following command
  can reach the dying daemon and report a dropped connection. Inspect state before
  retrying because the operation may have been partly accepted.
- CLI `send` and `done` print `-> [object Object]`.
- The titler sometimes used fragments of the prompt/response as an odd title.
- An external temporary-worktree VM check exceeded the backend's device limit
  (`no more IRQs are available`, four mounts). The repo's normal nested-worktree
  layout passed. This separate backend/layout limitation was not fixed.

## Current authorized work: shared session image

The user agreed to one common image containing all provider tools, provided
credentials remain isolated. Implement this and verify it; do not stop at a plan.

Original packaging duplicated the wrapper in `packaging/runtimes/claude.nix`,
`codex.nix`, and `aisdk.nix`, and `flake.nix` built three artifacts. They can share
one wrapper/image containing Claude, Codex, and the generic connector dependencies.
Keep the existing runtime names as aliases so configuration remains compatible.
`environmentProviders` already deduplicates by artifact, so identical bundled
artifact paths should reduce default preparation to one run. Custom distinct
artifacts can retain the existing per-artifact selection support.

Credential boundaries to preserve and test:

- `sessionAuth` accepts at most one authentication source; it rejects mixed
  provider credentials. Credentials are injected per launch, not baked into images.
- Explicit preparation rejects provider credentials and MCP relays and passes
  `auth: {}` with no provider hosts.
- Each session gets private writable disks, a private credential directory, and
  its own native provider profile. Sharing installed executables must not share
  those directories, auth files, refresh tokens, or another provider's config.
- Verify two sessions using the same prepared base with distinct synthetic
  credentials, asserting that each sees only its own credentials and that the
  prepared base contains neither. Also rerun a real ChatGPT tool check.

Shared-image implementation is now in progress:

- Added `packaging/runtimes/session.nix` with both Claude and Codex executables and
  the common guest worker. The three existing recipes now alias it; `flake.nix`
  also exports `session-runtime`. Only the new recipe is staged, to make it visible
  to Nix's Git source loader; nothing from this follow-up has been committed.
- Nix evaluation confirmed all four runtime package names resolve to exactly the
  same derivation: `/nix/store/rkp51ryc5scl8k472gkhz4vmhakryvhv-loom-loom-session-runtime`.
- Extended startup tests to check that identical artifacts prepare only once and
  added a synthetic-auth unit test for separate provider credential files.
- Updated the macOS hash-generation script to reuse the verified shared session
  image hash. Actual macOS hashes still require running it on Apple Silicon.
- Updated `docs/session-environments.md` to explain the shared image and private
  session credentials.
- Formatting, changed-file lint, full typecheck and all 25 targeted environment /
  auth tests passed. The shared Nix build succeeded at
  `/nix/store/ln8pwdjq5930l9856bxcnd3xfl6hpw2k-loom-0.0.0-g672ba8e-dirty`
  (`/tmp/loom-shared-package`). Its registry is
  `/nix/store/ap7zpqgwq6mcggh6gmsnxfzqa79g500x-loom-bundled-runtimes.json`;
  all three providers select
  `/nix/store/6228nv3nnwdgx8dj92zayj081wc03cwa-loom-loom-session-runtime`.
  The earlier evaluation path above predates test formatting.
- Shared preparation succeeded in exactly one run (386.9 seconds); output is in
  `/tmp/loom-shared-prepare.log`.
- `/tmp/loom-verify-shared-runtime.ts` passed the live synthetic-auth test:
  Claude and Codex clones ran together, then a fresh unauthenticated AISDK clone.
  Each saw only its selected auth files; Codex received no refresh token. Private
  profile and disk markers did not cross clones or persist into the shared base.
  Login shells in all three could run both provider executables, Deno 2.9.6 and
  Node 24.19.0. Evidence: `/tmp/loom-shared-isolation.log`. Disposable VMs and
  worktrees were cleaned up.
- Installed the exact tested shared package above via
  `nix profile install git+file:///home/user/dev/loom#loom`. The profile now tracks
  the local flake again (the earlier exact-store-path upgrade quirk is resolved).
- Archived the earlier successful `482969b8` smoke test. New real ChatGPT session
  `9fe21ff6-cd48-4eda-a62b-83e63d5e3cd6` in fresh worktree `.loom/trees/9fe21ff6`
  ran the same tool/cache checks and returned `LOOM_SHARED_ENVIRONMENT_OK`.
  After a daemon restart, it reran all checks and returned `LOOM_SHARED_RESUME_OK`.
  Final observed state: idle, two turns, clean worktree. The successful session
  remains available for inspection. Shared-image implementation and Linux live
  validation are complete; changes remain uncommitted.
- Build and typecheck logs: `/tmp/loom-shared-build.log` and
  `/tmp/loom-shared-typecheck.log`.

Do not spawn subagents: current instructions prohibit delegation unless requested.
The unrelated untracked review documents and `out` predate this work; leave them alone.
