# Debian guest feasibility experiment

## Result (2026-09-11)

An unmodified Debian 12 slim root filesystem works with the pinned smolvm
1.14.6 on Linux x86_64. No backend patch or package-specific loader override was
needed. The image was 82 MiB unpacked in this experiment.

The offline acceptance test passed:

- Nix Node 24.19.0 (glibc 2.42) loading oxfmt 0.64.0's GNU native binding and
  formatting JavaScript. The fixture contains only the GNU binding, with no
  musl or WASI fallback.
- Loom's writable Nix overlay, using a read-only runtime closure as the lower
  layer and the guest's `/storage` disk as the upper layer.
- A host Unix socket published into the guest, with VM networking disabled.
- Immediate host visibility of workspace writes and persistent overlay data
  after stopping and starting the VM.

This addresses the observed libc detection mismatch: Debian's `/usr/bin/ldd`
identifies glibc, agreeing with Nix Node. Debian and Nix still provide different
glibc versions; this test is evidence for this workload, not universal binary
compatibility.

The initial experiment was a feasibility test. Bundled session runtimes now
select Debian via a package-owned `guest-image.tar`; the archive is unpacked
inside the VM rather than on the host. This does
not fix virtiofs descriptor pressure or shared-filesystem ownership semantics.
It has not been tested on Apple Silicon or against the private monorepo.

## Reproduce on Linux x86_64

Requires Nix, crane, Deno, and the pinned smolvm. Download the image on the host;
the test itself needs no registry access or guest network. Use a dedicated copy
of Node's closure, never mount the host `/nix/store` wholesale.

```sh
test_root=$(mktemp -d /tmp/loom-glibc-fixture-XXXXXX)
mkdir -p "$test_root/rootfs" "$test_root/runtime/store" \
  "$test_root/runtime/fixture/node_modules/@oxfmt"

crane export --platform linux/amd64 \
  debian@sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867 \
  "$test_root/rootfs.tar"
tar --no-same-owner -xf "$test_root/rootfs.tar" -C "$test_root/rootfs"

# Select the Linux Node package from this checkout's pinned nixpkgs.
nix build --no-link --print-out-paths --expr \
  '(builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.x86_64-linux.nodejs_24' \
  --impure > "$test_root/node-path"
node_package=$(cat "$test_root/node-path")
nix-store -qR "$node_package" > "$test_root/closure"
while IFS= read -r dependency; do
  cp -a "$dependency" "$test_root/runtime/store/"
done < "$test_root/closure"
```

Copy the oxfmt 0.64.0 package and its same-version GNU binding into
`runtime/fixture/node_modules/oxfmt` and
`runtime/fixture/node_modules/@oxfmt/binding-linux-x64-gnu`. For example, with
those versions already present in this checkout's Deno package cache:

```sh
cp -a node_modules/.deno/oxfmt@0.64.0/node_modules/oxfmt \
  "$test_root/runtime/fixture/node_modules/"
cp -a node_modules/.deno/@oxfmt+binding-linux-x64-gnu@0.64.0/node_modules/@oxfmt/binding-linux-x64-gnu \
  "$test_root/runtime/fixture/node_modules/@oxfmt/"
cat > "$test_root/runtime/fixture/test.mjs" <<'EOF'
import assert from 'node:assert/strict';
import { format } from 'oxfmt';
const result = await format('test.js', 'const answer=42');
assert.deepEqual(result.errors, []);
assert.equal(result.code, 'const answer = 42;\n');
console.log('Native oxfmt formatting passed');
EOF

deno run -A scripts/test-glibc-guest-vm.ts \
  /path/to/pinned/smolvm "$test_root/rootfs" "$test_root/runtime" \
  "$node_package/bin/node"
```

The script creates and deletes only its own VM. It retains VM state if deletion
fails. The supplied rootfs and fixture remain available for subsequent tests.

## Packaging and remaining validation

The image is fetched with Nix's `dockerTools.pullImage` using a per-architecture
digest and fixed-output hash. Nix adds the selected runtime closure as image
layers, avoiding a separate virtiofs device (which exceeded the x86 IRQ budget
in a full session). smolvm receives the local archive via `--image`;
it does not need unrestricted guest networking or host container tooling.

The supervisor stages a private archive copy with a stable timestamp. This lets
smolvm reuse the flattened image in cloned disks: its archive cache signature
includes mtime, which its copy fallback from root-owned store files otherwise
changes on each launch.

Validation requirements:

1. Linux amd64 and arm64 image archives have pinned hashes. The immutable runtime
   artifact path includes the image and is already recorded in disk identities.
   A regression test confirms an older base is skipped and preserved.
2. Loom's full prepared-environment test passed on Linux x86_64 with `--nix`,
   including a fresh session using cached dependencies without network, refresh,
   failure/cancellation preservation, and existing-session isolation. Native
   oxfmt loading and socket/overlay tests also passed against the packaged archive.
3. Validate the arm64 guest on Apple Silicon and update bundled runtime hashes.

Keep distribution maintenance upstream in Debian. Avoid adding oxfmt-specific
environment variables or changing its loader in Loom.
