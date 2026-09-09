# Test-only stdio MCP for production egress acceptance checks.
{ pkgs }:
let
  package = pkgs.runCommand "loom-network-probe" {} ''
    mkdir -p $out/bin $out/share
    cp ${./network-probe.py} $out/share/probe.py
    cat > $out/bin/loom-network-probe <<EOF_SCRIPT
    #!${pkgs.bash}/bin/bash
    export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
    exec ${pkgs.python3}/bin/python3 $out/share/probe.py ${pkgs.curl}/bin/curl
    EOF_SCRIPT
    chmod +x $out/bin/loom-network-probe
  '';
in import ./mk-runtime.nix { inherit pkgs package; executable = "loom-network-probe"; }
