{
  description = "Optional packaged command MCP runtimes for Loom";
  inputs.tilth.url = "github:jahala/tilth/f5c0afa97c6666a3d68dcbd965a4db5a44bc0905";
  outputs = { tilth, ... }: let
    systems = [ "x86_64-linux" "aarch64-linux" ];
    forAll = tilth.inputs.nixpkgs.lib.genAttrs systems;
  in {
    lib.mkRuntime = import ./mk-runtime.nix;
    packages = forAll (system: let
      pkgs = tilth.inputs.nixpkgs.legacyPackages.${system};
      # Upstream's diff tests and runtime shell out to git.
      package = tilth.packages.${system}.default.overrideAttrs (old: {
        nativeCheckInputs = (old.nativeCheckInputs or []) ++ [ pkgs.gitMinimal ];
        nativeBuildInputs = (old.nativeBuildInputs or []) ++ [ pkgs.makeWrapper ];
        postFixup = (old.postFixup or "") + ''
          wrapProgram $out/bin/tilth --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.gitMinimal ]}
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
    });
  };
}
