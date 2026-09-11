# Official Debian rootfs, fetched at package-build time. Keep it archived so
# Linux filenames and ownership never pass through a macOS host filesystem.
{ pkgs, system ? pkgs.stdenv.hostPlatform.system }:
let
  images = {
    x86_64-linux = {
      arch = "amd64";
      imageDigest = "sha256:5ae3c39ebd15e229dcedd5cee596b2497182493d41ff162e824ba13fc1b2b867";
      hash = "sha256-psItnZ31Gxg04bQMXo/RW5AecbENfyACZCv7Dt+f0CM=";
    };
    aarch64-linux = {
      arch = "arm64";
      imageDigest = "sha256:6bd27d44e6c32a66bbd72d7cb2b76a8ae3497ec2e5274a81abd1b37f6013fa1f";
      hash = "sha256-fbgD/9vKMaxORPIebpgzJkXuk6lq1wpmC2jZwT8CZoA=";
    };
  };
in pkgs.dockerTools.pullImage ({
  imageName = "docker.io/library/debian";
  finalImageName = "debian";
  finalImageTag = "bookworm-slim";
  os = "linux";
} // images.${system})
