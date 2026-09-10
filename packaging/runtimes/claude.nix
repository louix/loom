# Session runtime: the connector worker plus native Claude in a Linux guest.
{ pkgs, loom }:
let
  gitShim = import ./git-shim.nix { inherit pkgs; };
  package = pkgs.writeShellScriptBin "loom-claude-session" ''
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
    export LOOM_GUEST_CONTROL_PATH=${pkgs.lib.makeBinPath [ gitShim pkgs.claude-code ]}
    export LOOM_GUEST_SHELL=${pkgs.bash}/bin/bash
    export LOOM_GUEST_CLAUDE=${pkgs.claude-code}/bin/claude
    export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
    export NODE_EXTRA_CA_CERTS=$SSL_CERT_FILE
    export PATH=${pkgs.lib.makeBinPath [ gitShim pkgs.bash pkgs.coreutils pkgs.findutils pkgs.gnugrep pkgs.gnused pkgs.curl pkgs.nix pkgs.git pkgs.gnutar pkgs.xz pkgs.deno pkgs.claude-code ]}
    exec ${pkgs.deno}/bin/deno run -A --cached-only --node-modules-dir=manual \
      ${loom}/libexec/loom/runtime/src/session-vm/guest.ts
  '';
in import ./mk-runtime.nix { inherit pkgs package; executable = "loom-claude-session"; sessionVersion = 1; }
