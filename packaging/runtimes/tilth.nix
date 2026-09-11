# Shared by the Loom package and standalone runtime preparation.
{ tilth, system }: let
  pkgs = tilth.inputs.nixpkgs.legacyPackages.${system};
  # The registry's API download endpoint can reject archived versions (403).
  # Use the canonical static archives, retaining every Cargo.lock checksum.
  cargoDeps = (pkgs.callPackage "${pkgs.path}/pkgs/build-support/rust/import-cargo-lock.nix" {
    fetchurl = args:
      let crate = builtins.match "https://crates.io/api/v1/crates/([^/]+)/([^/]+)/download" args.url;
      in pkgs.fetchurl (args // pkgs.lib.optionalAttrs (crate != null) {
        url = "https://static.crates.io/crates/${builtins.elemAt crate 0}/${builtins.elemAt crate 0}-${builtins.elemAt crate 1}.crate";
      });
  }) { lockFile = "${tilth.outPath}/Cargo.lock"; };
  # Upstream's diff tests and runtime shell out to git.
  package = tilth.packages.${system}.default.overrideAttrs (old: {
    inherit cargoDeps;
    patches = (old.patches or []) ++ [ ./tilth-git-errors.patch ];
    nativeCheckInputs = (old.nativeCheckInputs or []) ++ [ pkgs.gitMinimal ];
    nativeBuildInputs = (old.nativeBuildInputs or []) ++ [ pkgs.makeWrapper ];
    postFixup = (old.postFixup or "") + ''
      wrapProgram $out/bin/tilth --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git ]}
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
}
