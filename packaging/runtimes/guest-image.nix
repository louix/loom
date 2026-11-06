# Official Debian rootfs, fetched at package-build time. Keep it archived so
# Linux filenames and ownership never pass through a macOS host filesystem.
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  images = {
    x86_64-linux = {
      arch = "amd64";
      imageDigest = "sha256:c67e92c8099ba22853ab4cfda7cfb494d253d6012ca82dee98ba8976772af018";
      hash = "sha256-w7nZ4JVH7FvxtJWjzVMXGh0fIJlg/VlEx4HieWKPD9c=";
    };
    aarch64-linux = {
      arch = "arm64";
      imageDigest = "sha256:ec8534cda2cb30f29f44f23e135297af7a1496f2990fd8e4e84aa36b081a757a";
      hash = "sha256-RvBF+Vjbx93ZObNZkzKfElRfCopimSm6946w7GrV3yQ=";
    };
  };
in pkgs.dockerTools.pullImage ({
  imageName = "docker.io/library/debian";
  finalImageName = "debian";
  finalImageTag = "bookworm-slim";
  os = "linux";
} // images.${system})
