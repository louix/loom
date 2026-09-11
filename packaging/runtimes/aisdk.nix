# AISDK worker and workspace tools; no native provider executable required.
{ pkgs, loom }:
let
  package = pkgs.writeShellScriptBin "loom-aisdk-session" ''
    export HOME=/tmp/loom-home
    export XDG_CACHE_HOME=/tmp/loom-cache
    export DENO_DIR=/tmp/loom-deno
    export DENO_NO_UPDATE_CHECK=1
    export NIX_CONFIG='build-users-group =
    sandbox = true
    experimental-features = nix-command flakes
    accept-flake-config = false
    max-jobs = 1
    cores = 1'
    export LOOM_GUEST_CONTROL_PATH=""
    export LOOM_GUEST_SHELL=${pkgs.bash}/bin/bash
    export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
    export NODE_EXTRA_CA_CERTS=$SSL_CERT_FILE
    export PATH=${pkgs.lib.makeBinPath [ pkgs.bash pkgs.coreutils pkgs.findutils pkgs.gnugrep pkgs.gnused pkgs.curl pkgs.nix pkgs.git pkgs.gnutar pkgs.xz pkgs.deno ]}
    exec ${pkgs.deno}/bin/deno run -A --cached-only --node-modules-dir=manual \
      ${loom}/libexec/loom/runtime/src/session-vm/guest.ts
  '';
in import ./mk-runtime.nix { inherit pkgs package; executable = "loom-aisdk-session"; sessionVersion = 2; }
