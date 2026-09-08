{
  description = "Optional packaged command MCP runtimes for Loom";
  inputs.tilth.url = "github:jahala/tilth/f5c0afa97c6666a3d68dcbd965a4db5a44bc0905";
  outputs = { tilth, ... }: let
    systems = [ "x86_64-linux" "aarch64-linux" ];
    forAll = tilth.inputs.nixpkgs.lib.genAttrs systems;
  in {
    lib.mkRuntime = import ./mk-runtime.nix;
    packages = forAll (system: import ./tilth.nix { inherit tilth system; });
  };
}
