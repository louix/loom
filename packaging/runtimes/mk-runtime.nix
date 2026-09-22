# A command MCP artifact contains executable data, never permission grants.
{ pkgs, package, executable, args ? [], sessionVersion ? null, extraRoots ? [] }:
let
  closure = pkgs.closureInfo { rootPaths = [ package ] ++ extraRoots; };
  imageClosure = if sessionVersion != null then pkgs.closureInfo { rootPaths = [ package ]; } else closure;
  metadata = pkgs.runCommand "loom-runtime-metadata" {} ''
    mkdir -p $out/opt/loom/runtime
    cp ${imageClosure}/registration ${imageClosure}/store-paths $out/opt/loom/runtime/
  '';
  guestImage = pkgs.dockerTools.buildLayeredImage {
    name = "loom-${executable}";
    tag = "runtime";
    fromImage = import ./guest-image.nix { inherit pkgs; };
    # Metadata references the entire selected Nix closure; dockerTools includes
    # those store paths without overlaying /bin or /usr from the Debian image.
    contents = [ metadata ];
    maxLayers = 3;
    config.Cmd = [ "/bin/true" ];
  };
  manifest = pkgs.writeText "loom-runtime.json" (builtins.toJSON ({
    version = 1;
    system = pkgs.stdenv.hostPlatform.system;
    backend = "smolvm";
    entrypoint = "${package}/bin/${executable}";
    inherit args;
  } // pkgs.lib.optionalAttrs (sessionVersion != null) {
    guestImage = "guest-image.tar";
    # Bump the epoch for incompatible preparation/restore or store-layout changes.
    environmentCompatibility = builtins.hashString "sha256" "loom-environment-5:${guestImage}";
  }));
in pkgs.runCommand "loom-${executable}-runtime" {} ''
  mkdir -p $out/nix/store
  while IFS= read -r path; do
    cp -a "$path" "$out/nix/store/"
  done < ${closure}/store-paths
  cp ${closure}/store-paths $out/store-paths
  ${pkgs.lib.optionalString (sessionVersion != null) ''
    cp ${guestImage} $out/guest-image.tar
    cp ${closure}/registration $out/registration
    echo 6 > $out/session-environment-version
  ''}
  ${pkgs.lib.optionalString (sessionVersion != null) "echo ${toString sessionVersion} > $out/claude-session-version"}
  cp ${manifest} $out/manifest.json
''
