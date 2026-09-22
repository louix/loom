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
   explicit environment init command. Configure package managers through project
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

- Plan recorded; repository integration investigation underway.
