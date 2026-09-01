{
  description = "loom — per-repo agent-fleet daemon (dev shell + package)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # nixpkgs' own `pnpm` is 11.22 — one patch short of this repo's
      # `engines.pnpm >= 11.23.0` / `virtualStoreType: global` requirement.
      # `generic.nix` is parameterised by version + tarball hash, so a plain
      # `.override` tracks a newer pnpm without patching anything.
      pnpmFor = pkgs: pkgs.pnpm_11.override {
        version = "11.24.0";
        hash = "sha256-0eqyQzFyZhzDahjshfzpP3cdsZYnFzKcwB7JwoJMok8=";
      };

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
          ];

          shellHook = ''
            export COREPACK_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}/loom-corepack"
            echo "loom devshell — node $(node --version), pnpm $(pnpm --version 2>/dev/null || echo '(fetched on first use)')"
          '';
        };
      });

      packages = forAll (
        pkgs:
        let
          pnpm' = pnpmFor pkgs;
          # The offline `pnpm install` in pnpmConfigHook must run the *same*
          # pnpm as fetchPnpmDeps; mirror nixpkgs' own `pnpm.configHook`.
          pnpmConfigHook' = pkgs.pnpmConfigHook.overrideAttrs (prev: {
            propagatedBuildInputs = (prev.propagatedBuildInputs or [ ]) ++ [ pnpm' ];
          });
        in
        rec {
          default = loom;

          loom = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
            pname = "loom";
            version = revFor;
            src = ./.;

            pnpmDeps =
              (pkgs.fetchPnpmDeps {
                inherit (finalAttrs) pname version src;
                pnpm = pnpm';
                # pnpm_11 requires the v4 fetcher (v3 was dropped for pnpm 11).
                fetcherVersion = 4;
                hash = "sha256-M7mRof5jV0QA4BB6rG0C31q9YBXs2Ib6uiiD/gasmdg=";
              }).overrideAttrs
                (o: {
                  # The fetcher's fixupPhase runs `jq` over *every* *.json in the
                  # fetched store to strip `checkedAt` timestamps. Lots of deps
                  # (`@ljharb/*`, `@anthropic-ai/sdk`, …) publish JSONC
                  # `tsconfig.json` payload files with comments / trailing commas
                  # that jq can't parse, aborting the phase. Those files carry no
                  # `checkedAt` and aren't store metadata, so fall back to
                  # copying them through untouched.
                  fixupPhase = builtins.replaceStrings
                    [ ''jq --sort-keys "del(.. | .checkedAt?)" $f | sponge $f'' ]
                    [ ''{ jq --sort-keys "del(.. | .checkedAt?)" $f 2>/dev/null || cat $f; } | sponge $f'' ]
                    o.fixupPhase;
                });

            nativeBuildInputs = [
              pkgs.nodejs_24
              pnpm'
              pnpmConfigHook'
              pkgs.makeWrapper
            ];

            postPatch = ''
              # `virtualStoreType: global` (pnpm-workspace.yaml) makes pnpm
              # symlink node_modules into a CAS shared across the repo's many git
              # worktrees — deliberately outside the project tree, which a
              # self-contained Nix build can't relocate. Drop it so the offline
              # install materialises a normal, in-tree node_modules/.pnpm.
              sed -i '/^virtualStoreType:/d' pnpm-workspace.yaml
            '';

            # No compile step — .ts/.tsx run through @oxc-node at load time,
            # exactly as the repo's own `pnpm loom` script does.
            dontBuild = true;

            # Some deps ship intentionally-dangling symlinks (test fixtures);
            # the wrappers below don't touch them.
            dontCheckForBrokenSymlinks = true;

            installPhase = ''
              runHook preInstall

              mkdir -p $out/libexec/loom
              cp -R . $out/libexec/loom

              # oxnode's shebang -> a concrete node; make node discoverable too.
              patchShebangs $out/libexec/loom/node_modules/.bin

              for bin in loom loomd; do
                makeWrapper $out/libexec/loom/node_modules/.bin/oxnode $out/bin/$bin \
                  --add-flags $out/libexec/loom/cli/src/$bin.ts \
                  --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.nodejs_24 pkgs.git ]} \
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
