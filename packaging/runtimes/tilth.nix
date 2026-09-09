# Shared by the Loom package and standalone runtime preparation.
{ tilth, system }: let
  pkgs = tilth.inputs.nixpkgs.legacyPackages.${system};
  gitShim = import ./git-shim.nix { inherit pkgs; };
  # Upstream's diff tests and runtime shell out to git.
  package = tilth.packages.${system}.default.overrideAttrs (old: {
    patches = (old.patches or []) ++ [ ./tilth-git-errors.patch ];
    nativeCheckInputs = (old.nativeCheckInputs or []) ++ [ pkgs.gitMinimal ];
    nativeBuildInputs = (old.nativeBuildInputs or []) ++ [ pkgs.makeWrapper ];
    postFixup = (old.postFixup or "") + ''
      wrapProgram $out/bin/tilth --prefix PATH : ${pkgs.lib.makeBinPath [ gitShim ]}
    '';
  });
in rec {
  default = tilth-runtime;
  tilth-runtime = import ./mk-runtime.nix {
    inherit pkgs package;
    executable = "tilth";
    args = [ "--mcp" "--edit" ];
  };
  tilth = package;
  # Explicit test artifact; never selected by normal runtime preparation.
  bridge-probe = import ./mk-runtime.nix {
    inherit pkgs;
    executable = "loom-bridge-probe";
    package = pkgs.runCommand "loom-bridge-probe" {
      nativeBuildInputs = [ pkgs.stdenv.cc ];
    } ''
      mkdir -p $out/bin
      cp ${./bridge-probe.c} bridge-probe.c
      cc -std=c11 -O2 -g0 -Wall -Wextra -Werror bridge-probe.c -o $out/bin/loom-bridge-probe
    '';
  };
}
