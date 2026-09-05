{
  description = "loom — per-repo agent-fleet daemon (dev shell + package)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Short commit for `loom --version` when built from a checkout; a tag
      # would surface as the full ref. The flake sandbox has no `.git`, so the
      # daemon/CLI can't `git describe` at runtime — we stamp it here instead
      # (see core/src/version.ts).
      revFor = "0.0.0-g" + (self.shortRev or self.dirtyShortRev or "unknown");
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          # `corepack` ships a `pnpm` shim that reads package.json's
          # `packageManager` field and materialises the exact `pnpm@11.24.0`
          # on first use (cached under COREPACK_HOME thereafter).
          packages = [
            pkgs.nodejs_24
            pkgs.corepack
            pkgs.git
            pkgs.deno
          ];

          shellHook = ''
            export COREPACK_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}/loom-corepack"
            echo "loom devshell — node $(node --version), pnpm $(pnpm --version 2>/dev/null || echo '(fetched on first use)'), deno $(deno --version | head -1 | cut -d' ' -f2)"
          '';
        };
      });

      packages = forAll (
        pkgs:
        rec {
          default = loom;

          # A fixed-output derivation holding a populated `DENO_DIR`: every
          # npm tarball + esm module `deno.lock` pins, fetched once under a
          # hash of the lockfile's own content. `deno install --frozen`
          # refuses to touch the lockfile, so this is reproducible the same
          # way `fetchPnpmDeps` is — only the network-fetch step is allowed
          # to vary, not what it's allowed to produce.
          denoDeps = pkgs.stdenvNoCC.mkDerivation {
            pname = "loom-deno-deps";
            version = revFor;
            src = ./.;

            nativeBuildInputs = [ pkgs.deno pkgs.cacert ];
            dontConfigure = true;
            dontFixup = true;

            buildPhase = ''
              runHook preBuild
              export HOME="$TMPDIR"
              export DENO_DIR="$out"
              export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
              deno install --frozen
              runHook postBuild
            '';

            # DENO_DIR *is* $out; nothing else to place there.
            installPhase = "true";

            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-+WMUoSbTd/Q+AVujXSXtmd2lIs08nEEMfgQ3eX/+oeE=";
          };

          loom = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
            pname = "loom";
            version = revFor;
            src = ./.;

            nativeBuildInputs = [ pkgs.deno pkgs.makeWrapper ];
            dontConfigure = true;

            # Some deps ship intentionally-dangling symlinks (test fixtures);
            # the wrappers below don't touch them.
            dontCheckForBrokenSymlinks = true;

            # These files are never executed via their shebang (makeWrapper
            # below calls `deno run` on them directly) — patchShebangs mangles
            # the `-S deno run -A` multi-arg form, dropping the interpreter
            # name entirely.
            dontPatchShebangs = true;

            # `nodeModulesDir: "auto"` (root deno.json) materialises a real
            # node_modules/ from DENO_DIR's cache — same shape `pnpm install
            # --offline` gave the old build, just sourced from `denoDeps`
            # instead of `pnpmDeps`. `--cached-only` keeps this build (unlike
            # `denoDeps` above) off the network entirely; it's not a fixed
            # output, so Nix's sandbox wouldn't allow it anyway.
            buildPhase = ''
              runHook preBuild
              export HOME="$TMPDIR"
              export DENO_DIR="${denoDeps}"
              deno install --frozen --cached-only
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/libexec/loom
              cp -R . $out/libexec/loom

              for bin in loom loomd; do
                makeWrapper ${pkgs.deno}/bin/deno $out/bin/$bin \
                  --add-flags "run -A --cached-only --node-modules-dir=manual" \
                  --add-flags "$out/libexec/loom/cli/src/$bin.ts" \
                  --set DENO_DIR ${denoDeps} \
                  --set DENO_NO_UPDATE_CHECK 1 \
                  --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git ]} \
                  --set LOOM_BUILD_VER ${finalAttrs.version}
              done

              runHook postInstall
            '';

            meta = {
              description = "Per-repo daemon that supervises a fleet of coding agents, each in its own git worktree";
              mainProgram = "loom";
              # Only x86_64-linux has actually been built/run; the deps fetch is
              # cross-platform (`--force`) so the others are plausible, untested.
              platforms = pkgs.lib.platforms.unix;
            };
          });
        }
      );
    };
}
