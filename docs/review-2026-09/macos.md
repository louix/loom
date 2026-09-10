# Apple Silicon validation — September 2026

Test machine: Apple Silicon Mac, macOS 26.6.2, Nix 2.28.1, Deno 2.9.5, smolvm
1.8.1. Implementation is on `macos-isolation`.

## Verified

- Native host Loom, smolvm and Claude CLI builds.
- Default package installation with `nix profile install ./loom` on Nix 2.28
  (`nix profile add ./loom` on newer Nix). All four bundled runtime manifests
  resolve to immutable ARM Linux EROFS artifacts.
- Installed CLI, daemon and TUI startup; the personal Claude profile discovers
  three models. The copied user config reports Tilth ready.
- ARM Linux Tilth, Claude, Codex and AISDK runtime builds in a private builder.
- A Linux Nix package realised inside a native macOS fixed-output derivation.
- Guest-to-host Unix socket forwarding without guest network access.
- Tilth read, write, hash edits and search; read-only closure, unmounted host
  files and default network denial with a positive control.
- Tilth Git operations, including host-visible commits and rebases.
- All seven Tilth worktree lifecycle cases, including actual parent SIGKILL
  during startup and after readiness.
- Claude guest worker startup; host metadata, direct IP access and unapproved
  proxy destinations denied.
- Provider VM lifecycle: normal close, startup EOF, supervisor/Git/guest-exec
  SIGKILL, and parent SIGKILL during startup and after readiness.
- Recovery after both owners die: history retained and a new owner starts.
- AISDK synthetic local provider: two guest requests, host transcript
  persistence and a successful resume in a fresh VM.
- Native Codex synthetic OAuth fixture: rotation during a stream, rejection of
  the old token, refresh-token exclusion, and shutdown after failed
  renewal/expiry.
- Image-backed AISDK request/resume and provider lifecycle fixtures pass. The
  Codex fixture also passes when its bounded propagation check tolerates a
  temporarily missing file while the guest sees host credential publication.
- Final installed AISDK request/resume and Claude-style provider lifecycle tests.
- All image-backed Tilth isolation and linked-worktree lifecycle cases, including
  forced worker and parent termination.
- Full Linux regression suite and full Linux Nix package build.
- Full native Mac regression suite (including the hook delivery rerun).
- Credential source selection and profile-specific Keychain names, including
  fallback and isolation tests. The native CLI recognises the personal file
  profile.

## Outstanding acceptance checks

- Live Claude response, MCP invocation and resume. The copied personal access
  token expired; native refresh returns HTTP 400 with the current source copy
  too. A fresh personal login is needed to complete those checks.
- Live Codex account calls remain separate checks. The external AISDK catalog
  request was rejected by automatic approval review over credential-destination
  authorization; local synthetic-provider validation is used instead.

## Findings fixed

- Canonicalise only macOS system aliases (`/tmp`, `/var`, `/etc`), preserving
  validation of user-controlled symlinks.
- Keep session VM paths short enough for Darwin's Unix socket limit. smolvm uses
  `HOME/Library/Caches` on macOS rather than `XDG_CACHE_HOME`.
- Validate the Git shim against the staged Linux store instead of dereferencing
  the guest absolute link through the host store.
- Export guest artifacts as archives; direct shared-directory copies lost
  executable permission bits.
- Package the Linux closure as a read-only EROFS image on macOS. Unpacking it on
  default APFS collides on paths such as Perl's `Pod` and `pod` and ncurses'
  case-sensitive terminfo directories. A guest mount prototype preserves both
  filename variants and rejects writes to the image filesystem.
- Use host Bash and ripgrep in the package/dev shell and select Deno dependency
  hashes per host platform.
- Make acceptance checks distinguish bridge directories from `.stopped` markers
  and check Mac process existence without `/proc`.
- Handle Darwin's process-group termination race: after `EPERM`, ignore the error
  only when the group has disappeared or has no live members. Genuine permission
  errors still propagate. The forced-kill acceptance cases pass.
- Fetch pinned Tilth crate archives from their canonical static URLs; the API
  redirect endpoint returned 403 for some locked crates. Checksums are unchanged.

Build-time VMs may fetch dependencies; session VM network and credential policy
is unchanged. No Mac Nix daemon trust settings were relaxed.

## Follow-up

The optional disk-template cache currently discovers templates through Linux's
XDG cache layout. Mac session startup works without it (about 10–11 seconds in
the lifecycle runs); teaching it the macOS cache path is a separate performance
improvement, not a requirement for isolation.

The standalone Tilth preparation flake remains Linux-only. Apple Silicon users
should use the maintained runtimes bundled by the root Loom package.
