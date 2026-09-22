# Private prepared workspaces and disposable session VMs

## Decision

Implement option 1: durable host-backed, private workspaces; ordinary guest Git
through the host relay; one filesystem mount containing the checkout and
package-manager caches. Reuse prepared files with reflinks where supported and
ordinary copies otherwise, preserving hard links only inside each private copy.
Do not introduce VM branching, a file server, or shared writable package caches.

Preparation and project commands run in a credential-free preparation VM, never
on the host. Existing local sessions and legacy mounted sessions remain supported.
Clone mode remains opt-in during the migration.

## Commit-sized implementation sequence

1. **Workspace storage primitives.** Add a versioned workspace layout and atomic
   seeding/copying. Preserve internal links, avoid links into the base, reject
   unsafe roots, and retain existing work on resume. Test independence, partial
   copies, and migration paths.
2. **Generic preparation and session integration.** Prepare a clean independent
   repository plus a sibling cache directory; publish only after the VM stops.
   Seed new sessions before tools start. Give preparation and sessions consistent
   guest paths, expose generic workspace/cache environment variables, and add an
   explicit workspace startup hook. Configure package managers through project
   commands rather than a pnpm mode. Mount the same private workspace into
   filesystem tool VMs without combining execution, credentials, or egress.
3. **Publication and deletion safety.** Make publication failures observable.
   Do not claim hidden Git refs provide confidentiality. Require explicit force
   before deleting clone data whose dirty/unpublished state is unknown.
4. **Idle lifecycle and inventory.** Reap inactive runtime generations after a
   configurable grace period, coordinated with session operations; exclude open
   shells, outstanding work, and background tasks. Resume using durable workspace
   and provider history. Remove successful obsolete runtime inventory records
   without deleting recoverable work or treating private stores as disposable.
5. **Verification and documentation.** Update schemas and operational docs,
   exercise representative lifecycle tests and live KVM preparation/session
   probes, verify ordinary pnpm hard links and independent session writes, and
   record limitations.

## Storage policy

Idle shutdown removes running VM resources, not the checkout or private cache.
Old preparation generations can be reclaimed once seeding no longer needs them.
Never infer that arbitrary ignored files, node_modules, or VM-written data are
safe to delete. Explicit removal/force remains the boundary for uncertain work.
A size-budget eviction policy for rebuildable caches can be added separately;
this change must not silently evict session edits.

## Validation

Use focused tests for copy semantics, preparation publication, guest checkout
reconciliation, mount boundaries, generic init, idle/revival races, publication
errors, and deletion guards. Run repository type/lint/schema checks and existing
affected tests. Live VM validation runs outside the command sandbox with KVM,
using disposable fixtures and pinned runtime images. Record actual results
rather than relying on pnpm's import log message.

## Progress

- Implemented and committed workspace copying, generic workspace preparation/startup hooks, stable mounts,
  publication/removal safeguards, idle suspension and inventory pruning.
- Added real-KVM acceptance probes and configuration documentation.
- Live preparation plus two sessions and resume passed: current host branch,
  stable paths, preserved internal hard links and independent writes.
- Small-fixture prepared worker startup was 1.5–3.2 seconds; cold preparation
  took 162 seconds on this host. These are not monorepo performance estimates.
- The production copier passed the offline pnpm storage probe: single-mount
  hard links, split-mount EXDEV, independent sessions; ext4 used full copies.
- Existing local-provider sessions remain outside idle VM suspension. MCP
  execution and egress remain separate; a new fs/network capability taxonomy and
  automatic workspace/cache eviction are explicitly deferred.

## Workspace-hook follow-up

- Replaced hook event `init` and environment setup commands with
  `workspace_prepare` and `workspace_start`. Startup hooks run for creation,
  resume, and environment refresh; `LOOM_START_REASON` identifies the trigger.
- Typecheck and lint passed. The full suite passed 1,039 tests and 127 steps
  with one stale timeout assertion; its corrected expectation and affected
  lifecycle tests passed separately. Async startup and preparation checks also
  passed after the final event-name correction.
- The updated real-KVM private-workspace fixture passed preparation, current
  host branch checkout, independent hard links/writes, and repeated startup.
  Preparation took 139.6 seconds; prepared mock workers became ready in
  approximately 1.4–1.6 seconds.
- A disposable clone of gridshare-edge at `41425ca42695` exercised its actual
  Nix environment and bootstrap hook. Cold Nix activation requested 623 paths
  (1.7 GiB compressed, 6.2 GiB unpacked). The bootstrap then failed with
  `ERR_PNPM_EMFILE`, and preparation correctly declined to publish the base
  after 963.6 seconds. Full-project startup/resume timings remain unverified.
- The guest descriptor limit was 1,048,576; the host launcher and normal user
  terminal both had soft/hard limits of 100,000. Separate disposable probes
  successfully created 130,000 files, including a probe using 8 GiB RAM and
  hard-link/stat operations. These results do not establish that the host
  limit caused the pnpm failure. No host-limit or pnpm-specific workaround was
  added to Loom.
- The project's `NIX_EXCLUDE_CHROMIUM=1` export occurs inside the bootstrap
  hook, after activation, so it does not prevent the cold shell from fetching
  Chromium.
