{
  description = "loom — per-repo agent-fleet daemon (dev shell + package)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  # This revision packages smolvm 1.8.1; upstream's v1.8.1 tag still packages 1.8.0.
  inputs.smolvm.url = "github:smol-machines/smolvm/703f12b038014fc832dc03f9b7d85669f496acdb";

  inputs.tilth.url = "github:jahala/tilth/f5c0afa97c6666a3d68dcbd965a4db5a44bc0905";

  outputs =
    { self, nixpkgs, smolvm, tilth }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Guests always run Linux, independently of the machine running Loom/smolvm.
      guestSystemFor = system: builtins.replaceStrings [ "-darwin" ] [ "-linux" ] system;
      guestRuntimes = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
        codex-session-runtime = import ./packaging/runtimes/codex.nix {
          pkgs = nixpkgs.legacyPackages.${system};
          loom = self.packages.${system}.loom.override { withTilth = false; };
        };
        aisdk-session-runtime = import ./packaging/runtimes/aisdk.nix {
          pkgs = nixpkgs.legacyPackages.${system};
          loom = self.packages.${system}.loom.override { withTilth = false; };
        };
        claude-session-runtime = import ./packaging/runtimes/claude.nix {
          pkgs = nixpkgs.legacyPackages.${system};
          loom = self.packages.${system}.loom.override { withTilth = false; };
        };
        tilth-runtime = (import ./packaging/runtimes/tilth.nix {
          inherit tilth system;
        }).tilth-runtime;
      });

      # Short commit for `loom --version` when built from a checkout; a tag
      # would surface as the full ref. The flake sandbox has no `.git`, so the
      # daemon/CLI can't `git describe` at runtime — we stamp it here instead
      # (see core/src/version.ts).
      revFor = "0.0.0-g" + (self.shortRev or self.dirtyShortRev or "unknown");
    in
    {
      lib.mkRuntime = import ./packaging/runtimes/mk-runtime.nix;
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
          ] ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
            smolvm.packages.${pkgs.stdenv.hostPlatform.system}.default
          ];

          shellHook = ''
            export COREPACK_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}/loom-corepack"
            echo "loom devshell — node $(node --version), pnpm $(pnpm --version 2>/dev/null || echo '(fetched on first use)'), deno $(deno --version | head -1 | cut -d' ' -f2)"
          '';
        };
      });

      packages = forAll (
        pkgs:
        let
          hostSystem = pkgs.stdenv.hostPlatform.system;
          guestSystem = guestSystemFor hostSystem;
          hostSmolvm = smolvm.packages.${hostSystem}.default;
          # Packaging aliases are not a declaration of macOS runtime support.
          bundleSupported = pkgs.stdenv.hostPlatform.isLinux;
        in rec {
          default = loom;
          inherit (guestRuntimes.${guestSystem}) claude-session-runtime aisdk-session-runtime codex-session-runtime tilth-runtime;
          bundledRuntimes = pkgs.writeText "loom-bundled-runtimes.json" (builtins.toJSON {
            tilth = {
              version = 1;
              source = "tilth";
              artifact = "${tilth-runtime}";
              smolvm = "${hostSmolvm}/bin/smolvm";
              preparedAt = "bundled";
            };
          });

          # A fixed-output derivation holding a populated `DENO_DIR`: every
          # npm tarball + esm module `deno.lock` pins, fetched once under a
          # hash of the lockfile's own content. `deno install --frozen`
          # refuses to touch the lockfile, so this is reproducible the same
          # way `fetchPnpmDeps` is — only the network-fetch step is allowed
          # to vary, not what it's allowed to produce.
          denoDeps = pkgs.stdenvNoCC.mkDerivation {
            pname = "loom-deno-deps";

            # A FOD's store path is derived from its output hash *and its
            # name*, so naming this after the git rev handed every commit a
            # fresh path: `nix profile upgrade` refetched ~550MB of tarballs
            # that were already in the store byte for byte. Name it after the
            # lockfile's digest instead, and feed it only the files that
            # decide what gets fetched — the lockfile and the workspace's
            # `deno.json`s — so commits that don't touch dependencies leave
            # both this derivation and its output path alone.
            version = "lock-${builtins.substring 0 8 (builtins.hashFile "sha256" ./deno.lock)}";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./deno.lock
                (pkgs.lib.fileset.fileFilter (f: f.name == "deno.json") ./.)
              ];
            };

            nativeBuildInputs = [ pkgs.deno pkgs.cacert ];
            dontConfigure = true;
            dontFixup = true;

            buildPhase = ''
              runHook preBuild
              export HOME="$TMPDIR"
              export DENO_DIR="$out"
              export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
              deno install --frozen

              # `deno install`'s dep/node analysis-cache SQLite databases
              # record real content, but their on-disk page layout varies
              # with fetch/task scheduling order between otherwise-identical
              # runs (verified: diffing two builds from the same deno.lock
              # showed only these two DBs — main file, -journal, -wal, -shm
              # sidecars alike — differing). They're a pure perf cache Deno
              # regenerates on demand, so drop them rather than chase
              # deterministic ordering out of Deno's own fetch pipeline. Same
              # category of fix as fetchPnpmDeps' own checkedAt-stripping
              # fixupPhase below.
              rm -f "$DENO_DIR"/dep_analysis_cache_v2* "$DENO_DIR"/node_analysis_cache_v2*

              # Deno also caches each top-level npm dep's *packument* (the
              # registry's whole version index) as npm/<registry>/<pkg>/
              # registry.json. Those are not pinned by deno.lock: they carry
              # the response's `_deno.etag`, npm's `time.modified`, and every
              # version published so far, so a single unrelated release —
              # anywhere in the dep's history — changes this output and
              # breaks the hash below, on a lockfile that never moved.
              # Nothing downstream needs them: `deno install --frozen
              # --cached-only` resolves from deno.lock plus the tarballs
              # already fetched here (verified: that install succeeds, and
              # refetches nothing, with every registry.json deleted).
              find "$DENO_DIR/npm" -name registry.json -delete
              runHook postBuild
            '';

            # DENO_DIR *is* $out; nothing else to place there.
            installPhase = "true";

            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-owMiJzg2obrdhloRDQ5TDEAwtZY0wrr5lLzFlmnKNm0=";
          };

          loom = pkgs.lib.makeOverridable ({ withTilth ? true }:
            pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
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

              # Dependencies are already installed under node_modules. Leave
              # DENO_DIR to Deno (or the caller): its runtime SQLite caches
              # must be writable, unlike the build-time dependency store.
              for bin in loom loomd; do
                makeWrapper ${pkgs.deno}/bin/deno $out/bin/$bin \
                  --add-flags "run -A --cached-only --node-modules-dir=manual" \
                  --add-flags "$out/libexec/loom/cli/src/$bin.ts" \
                  --set DENO_NO_UPDATE_CHECK 1 \
                  --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git ]} \
                  --set LOOM_BUILD_VER ${finalAttrs.version} \
                  ${if withTilth && bundleSupported
                    then "--set LOOM_BUNDLED_RUNTIMES ${bundledRuntimes}"
                    else "--unset LOOM_BUNDLED_RUNTIMES"}
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
          })) {};
        }
      );
    };
}
