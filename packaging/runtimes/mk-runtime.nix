# A command MCP artifact contains executable data, never permission grants.
{ pkgs, package, executable, args ? [], sessionVersion ? null }:
let
  gitShim = import ./git-shim.nix { inherit pkgs; };
  networkExec = pkgs.writeShellScriptBin "loom-network-exec" ''
    ${pkgs.socat}/bin/socat TCP4-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/loom/egress.sock &
    proxy=$!
    attempts=0
    until (: > /dev/tcp/127.0.0.1/3128) 2>/dev/null; do
      kill -0 "$proxy" || exit 1
      attempts=$((attempts + 1))
      [ "$attempts" -lt 100 ] || exit 1
      ${pkgs.coreutils}/bin/sleep 0.02
    done
    export HTTPS_PROXY=http://127.0.0.1:3128
    export HTTP_PROXY=$HTTPS_PROXY
    export https_proxy=$HTTPS_PROXY
    export http_proxy=$HTTPS_PROXY
    export NO_PROXY=localhost,127.0.0.1
    export no_proxy=$NO_PROXY
    exec "$@"
  '';
  closure = pkgs.closureInfo { rootPaths = [ package gitShim networkExec ]; };
  manifest = pkgs.writeText "loom-runtime.json" (builtins.toJSON {
    version = 1;
    system = pkgs.stdenv.hostPlatform.system;
    backend = "smolvm";
    entrypoint = "${package}/bin/${executable}";
    inherit args;
  });
in pkgs.runCommand "loom-${executable}-runtime" {} ''
  mkdir -p $out/nix/store
  while IFS= read -r path; do
    cp -a "$path" "$out/nix/store/"
  done < ${closure}/store-paths
  cp ${closure}/store-paths $out/store-paths
  mkdir -p $out/bin
  ln -s ${gitShim}/bin/git $out/bin/git
  ln -s ${networkExec}/bin/loom-network-exec $out/bin/loom-network-exec
  echo 1 > $out/egress-version
  echo 2 > $out/git-bridge-version
  ${pkgs.lib.optionalString (sessionVersion != null) "echo ${toString sessionVersion} > $out/claude-session-version"}
  cp ${manifest} $out/manifest.json
''
