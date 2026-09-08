{
  description = "Pinned tilth runtime closure for the MCP microVM spike";
  inputs.tilth.url = "github:jahala/tilth/f5c0afa97c6666a3d68dcbd965a4db5a44bc0905";
  outputs = { self, tilth }: let
    systems = [ "x86_64-linux" "aarch64-linux" ];
    forAll = tilth.inputs.nixpkgs.lib.genAttrs systems;
  in {
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
      closure = pkgs.closureInfo { rootPaths = [ package ]; };
    in {
      default = pkgs.runCommand "tilth-vm-runtime" {} ''
        mkdir -p $out/nix/store
        while IFS= read -r path; do
          cp -a "$path" "$out/nix/store/"
        done < ${closure}/store-paths
        printf '%s\n' '${package}/bin/tilth' > $out/entrypoint
        cp ${closure}/store-paths $out/store-paths
      '';
      tilth = package;
    });
  };
}
