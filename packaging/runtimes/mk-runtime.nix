# A command MCP artifact contains executable data, never permission grants.
{ pkgs, package, executable, args ? [] }:
let
  gitShim = import ./git-shim.nix { inherit pkgs; };
  closure = pkgs.closureInfo { rootPaths = [ package gitShim ]; };
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
  echo 2 > $out/git-bridge-version
  cp ${manifest} $out/manifest.json
''
