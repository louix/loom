# pnpm storage and isolated checkouts: spike

Measured 2026-09-22 on Linux x86_64, smolvm 1.16.1, pnpm 11.25.0,
Node 24.20.0, with the workspace on ext4. The VM measurements ran outside
the command sandbox with KVM. No production mount or checkout behavior changed.

## Result

A single virtiofs export containing both `checkout/` and `pnpm-store/`
supports actual pnpm hard links. Separate exports do not, even when the backing
directories are on the same host filesystem.

| Probe                                         | Store / installed device | Same inode | Link count | Result                                  |
| --------------------------------------------- | ------------------------ | ---------- | ---------- | --------------------------------------- |
| Host, sibling directories                     | 66306 / 66306            | yes        | 2          | Hard links                              |
| Guest, one export at `/probe`                 | 29 / 29                  | yes        | 2          | Hard links                              |
| Guest, checkout and store exported separately | 30 / 29                  | no         | 1 each     | Copies; direct `link()` returns `EXDEV` |

Device and inode numbers vary between runs. The equality checks matter.

Both guest installs succeeded with `--package-import-method=hardlink`.
**pnpm printed “Packages are hard linked” even in the separate-export case.**
Success and that log message do not prove that the payload was hard-linked.

The fixture is an offline local tarball containing a random 32 MiB payload and
256 small JavaScript files. The probe locates the matching payload in the pnpm
content-addressed store by size and SHA-256, compares device/inode/link count,
and attempts a direct hard link as an independent filesystem control.
Lifecycle scripts are disabled. pnpm's “downloaded 1” refers to the local tarball;
the VM has no network enabled.

## Sharing between sessions remains unresolved on this host

The single-export layout prevents a second payload copy between the private
store and `node_modules`. It does not prevent a full private store per session.

Strict `cp -a --reflink=always` failed with “Operation not supported” on this
host's ext4 filesystem. The spike explicitly recorded the full-copy fallback;
it does not count a successful ordinary copy as evidence of copy-on-write.

Two independently copied warm workspaces installed successfully with local hard
links. An in-place write to one installed payload did not change the other
workspace or the original seed store. Thus independence works, but cheap
cross-session sharing was **not** demonstrated.

Do not extrapolate the fixture's sub-two-second install measurements to a
multi-gigabyte monorepo. This is a filesystem semantics probe, not an installation
benchmark. macOS/APFS and reflink-capable Linux filesystems remain unmeasured.
The script deliberately reports the strict clone probe as unsupported on macOS;
it does not assume that a copy utility's success proves physical block sharing.

## Consequence for the design

For host-visible files, the candidate mount is:

```text
session-directory/
  workspace/           <- one guest mount
    checkout/          <- Git clone; tool working directory
    pnpm-store/        <- private pnpm store
  profile/
  git-policy.json      <- host-only, outside that mount
```

Never mount the entire session directory just to put the two data directories
on one device: the policy and supervisor state must stay outside the export.
Tool VMs must use compatible paths if they need to follow links out of the
checkout.

This layout is sufficient for within-session hard links. For portable storage
sharing between sessions, the next candidate is putting **both** checkout and
store on the same guest filesystem backed by a copy-on-write session disk.
Loom already has session disk overlays, but using them for the checkout requires
a separate solution for tool-VM and host file access. This spike does not validate
that integration. Reflinked private workspace directories are another candidate
on supporting host filesystems.

## Implementation follow-up

The probe now exercises `copyWorkspace`, Loom's production private workspace
copier, for both host copies. A repeat on the same ext4 host passed independent
writes and the guest single/split-mount checks. The 32 MiB fixture copy took
83 ms, warm host installs 1.1–1.2 seconds, and the single-mount guest install
1.85 seconds excluding VM boot. Reflinks remained unsupported.

`scripts/test-private-workspace-vm.ts` separately exercises real session runtime
preparation, publication, seeding two private workspaces, fetching an updated
host branch, generic init and resume. Its dependency fixture verifies preserved
hard links directly; the pnpm probe verifies package-manager behavior.

## Reproduce

Host probe (requires Node, pnpm, tar, and cp):

```sh
deno run -A scripts/spike-pnpm-storage.ts
```

Build the same minimal guest image from this repository's pinned nixpkgs:

```sh
nix build --impure --no-link --print-out-paths --expr '
  let
    flake = builtins.getFlake (toString ./.);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in pkgs.dockerTools.buildLayeredImage {
    name = "loom-pnpm-storage-spike";
    tag = "local";
    contents = [ pkgs.nodejs_24 pkgs.pnpm pkgs.coreutils pkgs.bash ];
    config.Env = [ "PATH=/bin" "HOME=/tmp" ];
  }
'
```

Pass the resulting archive path, and optionally the pinned smolvm executable:

```sh
deno run -A scripts/spike-pnpm-storage.ts \
  --image /nix/store/REPLACE-with-image.tar.gz \
  --smolvm /nix/store/REPLACE-with-smolvm/bin/smolvm
```

The guest image must contain working `node` and `pnpm` executables; a Corepack
shim that needs a network download is insufficient. Run with KVM access on Linux.

The script emits JSON, asserts the single-export and separate-export results,
and reaps the disposable VMs. `--parent DIR` selects the filesystem under test;
`--keep` retains fixture data. VM state uses short temporary paths for Unix
socket limits and is removed after confirmed cleanup. Failed VM cleanup retains
both state and fixture data. No existing repository or package cache is mounted
into the probe guests.
