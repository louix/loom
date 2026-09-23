{
  description = "Example Tilth MCP package with Git support";
  inputs.tilth.url = "github:jahala/tilth/f5c0afa97c6666a3d68dcbd965a4db5a44bc0905";
  outputs = { tilth, ... }: let
    systems = [ "x86_64-linux" "aarch64-linux" ];
  in {
    packages = tilth.inputs.nixpkgs.lib.genAttrs systems (system: {
      default = import ./package.nix { inherit tilth system; };
    });
  };
}
