# Build a pinned Linux runtime using native Apple Silicon smolvm.
# Build-time guests may fetch dependencies and receive no session credentials.
{ pkgs, smolvm, source, runtime, hash }:
let
  bootstrap = pkgs.fetchurl {
    url = "https://releases.nixos.org/nix/nix-2.28.1/nix-2.28.1-aarch64-linux.tar.xz";
    hash = "sha256-T6ND4cCcBehg5Tsfr7ri1lcBNgKGgaczDX00aU6ukPo=";
  };
  guestScript = pkgs.writeText "loom-build-runtime.sh" ''
    set -eu
    mkdir -p /tmp/nix-install /nix/store /nix/var/nix /root
    cd /tmp/nix-install
    tar -xJf /input/bootstrap.tar.xz
    cd nix-*-aarch64-linux
    cp -a store/* /nix/store/
    nix_bin=$(echo /nix/store/*-nix-2.28.1/bin)
    export PATH="$nix_bin:/usr/bin:/bin"
    export HOME=/root
    export NIX_CONFIG='build-users-group =
    sandbox = true
    experimental-features = nix-command flakes
    max-jobs = 2
    cores = 2'
    export SSL_CERT_FILE=$(echo /nix/store/*-nss-cacert-*/etc/ssl/certs/ca-bundle.crt)
    nix-store --load-db < .reginfo
    attempt=0
    until result=$(nix build 'path:/input/source#${runtime}' --no-link --print-out-paths); do
      attempt=$((attempt + 1))
      if [ "$attempt" -ge 3 ]; then exit 1; fi
      echo "Retrying runtime build after a failed attempt ($attempt/3)..." >&2
      sleep 2
    done
    image_tools=$(nix build --impure --no-link --print-out-paths --expr '
      let f = builtins.getFlake "path:/input/source";
          p = f.inputs.nixpkgs.legacyPackages.aarch64-linux;
      in p.symlinkJoin { name = "loom-image-tools"; paths = [ p.erofs-utils p.jq ]; }')
    mkdir -p /tmp/artifact/nix/store
    # Keep Linux case distinctions inside an immutable filesystem image.
    # A fixed timestamp, UUID and owner make the image reproducible.
    "$image_tools/bin/mkfs.erofs" --quiet -T 1 --all-root \
      -U 00000000-0000-0000-0000-000000000000 \
      /tmp/artifact/runtime.erofs "$result/nix/store"
    cp "$result/store-paths" /tmp/artifact/
    if [ -f "$result/session-environment-version" ]; then
      cp "$result/session-environment-version" "$result/registration" /tmp/artifact/
    fi
    if [ -f "$result/guest-image.tar" ]; then
      cp "$result/guest-image.tar" /tmp/artifact/
    fi
    if [ -f "$result/claude-session-version" ]; then
      cp "$result/claude-session-version" /tmp/artifact/
    fi
    "$image_tools/bin/jq" '. + {closureFormat: "erofs"}' "$result/manifest.json" > /tmp/artifact/manifest.json
    tar -cf /output/runtime.tar -C /tmp/artifact .
  '';
  # Also exposed to maintainers: populate the content-addressed store while
  # computing hashes, so updating a pin does not compile the runtime twice.
  prepare = pkgs.writeShellScriptBin "loom-build-runtime" ''
  set -eu
  export PATH=${pkgs.lib.makeBinPath [ smolvm pkgs.coreutils pkgs.gnutar pkgs.findutils ]}:/usr/bin:/bin
  out="$1"
  # Darwin's Unix socket limit includes the Nix build directory. Keep both
  # the derivation's name and private smolvm paths short.
  vm_tmp=$(mktemp -d "''${TMPDIR:-/tmp}/v.XXXXXX")
  export HOME="$vm_tmp/h"
  export XDG_CACHE_HOME="$vm_tmp/c"
  export XDG_DATA_HOME="$vm_tmp/d"
  export XDG_CONFIG_HOME="$vm_tmp/f"
  cleanup() {
    for attempt in 1 2 3 4 5; do
      smolvm machine stop --name b >/dev/null 2>&1 || true
      smolvm machine delete --name b --force >/dev/null 2>&1 || true
      if [ "$(smolvm machine ls --json)" = "[]" ]; then
        chmod -R u+w "$vm_tmp"
        rm -rf "$vm_tmp"
        return
      fi
      sleep 0.2
    done
    echo "Builder cleanup incomplete; state retained at $vm_tmp" >&2
    return 1
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$vm_tmp/i" "$vm_tmp/o"
  cp -a ${source} "$vm_tmp/i/source"
  cp ${bootstrap} "$vm_tmp/i/bootstrap.tar.xz"
  cp ${guestScript} "$vm_tmp/i/build.sh"
  smolvm machine create --name b --cpus 2 --mem 3072 --overlay 64 --net \
    -v "$vm_tmp/i:/input:ro" -v "$vm_tmp/o:/output"
  smolvm machine start --name b || { find "$vm_tmp" -name "*.log" -exec cat {} \; ; exit 1; }
  smolvm machine exec --name b --stream --timeout 60m -- /bin/sh /input/build.sh
  mkdir -p "$out"
  tar -xf "$vm_tmp/o/runtime.tar" -C "$out"
  '';
in pkgs.runCommand "lvm" {
  __darwinAllowLocalNetworking = true;
  outputHashMode = "recursive";
  outputHashAlgo = "sha256";
  outputHash = hash;
  # All binaries and absolute symlinks belong to the Linux guest store.
  dontFixup = true;
  preferLocalBuild = true;
  passthru = { inherit prepare; };
} ''
  ${prepare}/bin/loom-build-runtime "$out"
''
