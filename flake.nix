{
  description = "loom — per-repo agent-fleet daemon (dev shell + package)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  # SmolVM 1.23.0; its Nix recipe still needs the release override below.
  inputs.smolvm.url = "github:smol-machines/smolvm/6aae73101065ce22bfcff17ec0f57371b3a90e11";

  outputs =
    { self, nixpkgs, smolvm }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Split session runtimes need a code share in addition to the worktree,
      # Git metadata, credentials and profile. Since 1.23.0 the bundled libkrun
      # gives x86 virtio devices all 24 I/O APIC pins (smol-machines/libkrun#153),
      # which Loom used to patch in, so the release no longer runs out of IRQs
      # before attaching vsock.
      hostSmolvmFor = system:
        let
          upstream = smolvm.packages.${system};
          pkgs = smolvm.inputs.nixpkgs.legacyPackages.${system};
          # The release tags' Nix recipe lags the published tarballs.
          # Keep upstream's packaging, but use the published 1.23.0 assets.
          release = {
            x86_64-linux = { platform = "linux-x86_64"; hash = "sha256-4kMxACuO962Q+9/n53fm9rLlWFUrLRWcK7WuJKJ1glA="; };
            aarch64-linux = { platform = "linux-arm64"; hash = "sha256-NimL47iXath/wxu7A/CwwQWk3dMFoegzBTm3Szubqvk="; };
            aarch64-darwin = { platform = "darwin-arm64"; hash = "sha256-J2PouFE/kC0CNQZrVgWkkVKAKbZ4RBY9jYS5pgeqY6Q="; };
          }.${system};
        in upstream.default.overrideAttrs (_: rec {
          version = "1.23.0";
          sourceRoot = "smolvm-${version}-${release.platform}";
          src = pkgs.fetchurl {
            url = "https://github.com/smol-machines/smolvm/releases/download/v${version}/${sourceRoot}.tar.gz";
            inherit (release) hash;
          };
        });

      # Guests always run Linux, independently of the machine running Loom/smolvm.
      guestSystemFor = system: builtins.replaceStrings [ "-darwin" ] [ "-linux" ] system;
      guestRuntimes = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
        session-runtime = import ./packaging/runtimes/session.nix {
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "claude-code";
          };
          loom = self.packages.${system}.loom.override { withClaude = false; withCodex = false; withAisdk = false; };
        };
      });

      # What an Apple Silicon guest build sees, and so what decides its runtime
      # identity: the modules the guest loads (guest.ts, guest-worker.ts and their
      # import graph, listed by `deno task runtime:guest-source` and checked by
      # test/guest-source.test.ts), the workspace manifests and lockfile Deno
      # resolves them with, and the recipes that package them. Host-only code,
      # tests, docs and the output hashes stay out, so changing them neither
      # forms a source/hash cycle nor asks Macs to rebuild their runtime.
      guestSource = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions (
          [ ./deno.json ./deno.lock ./flake.nix ./flake.lock ./packaging/runtimes ]
          ++ map (member: ./. + "/${member}/deno.json")
            (builtins.fromJSON (builtins.readFile ./deno.json)).workspace
          ++ map (file: ./. + "/${file}")
            (builtins.fromJSON (builtins.readFile ./packaging/macos/guest-source.json)).modules);
      };
      # Names a guest runtime built on demand on a Mac: one per source and recipe.
      guestRuntimeIdentity = builtins.substring 0 32 (builtins.hashString "sha256"
        "loom-guest-runtime-1\n${builtins.unsafeDiscardStringContext (toString guestSource)}\n${self.lib.guestRuntimeRecipe}");
      # Short commit for `loom --version` when built from a checkout; a tag
      # would surface as the full ref. The flake sandbox has no `.git`, so the
      # daemon/CLI can't `git describe` at runtime — we stamp it here instead
      # (see core/src/version.ts).
      revFor = "0.0.0-g" + (self.shortRev or self.dirtyShortRev or "unknown");
    in
    {
      lib.guestRuntimeSource = guestSource;
      lib.guestRuntimeIdentity = guestRuntimeIdentity;
      lib.guestRuntimeRecipe = builtins.hashFile "sha256" ./packaging/macos/runtime.nix;
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
            pkgs.bash
            pkgs.ripgrep
            pkgs.deno
          ] ++ pkgs.lib.optionals (pkgs.stdenv.hostPlatform.isLinux || pkgs.stdenv.hostPlatform.system == "aarch64-darwin") [
            (hostSmolvmFor pkgs.stdenv.hostPlatform.system)
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
          hostSmolvm = hostSmolvmFor hostSystem;
          hostClaude = (import nixpkgs {
            system = hostSystem;
            config.allowUnfreePredicate = pkg: pkgs.lib.getName pkg == "claude-code";
          }).claude-code;
          # Apple Silicon builds its Linux guest runtime inside a smolvm VM. A
          # committed pin matching this source and recipe lets Nix build it as a
          # fixed-output derivation during installation. Without one (the usual
          # case after guest changes), Loom runs the same builder on first use
          # and caches the result under this source's identity.
          macosRecipe = hash: import ./packaging/macos/runtime.nix {
            inherit pkgs hash;
            runtime = "session-runtime";
            smolvm = hostSmolvm;
            source = guestSource;
          };
          macosPins =
            let file = ./packaging/macos/runtime-hashes.json;
            in if builtins.pathExists file then builtins.fromJSON (builtins.readFile file) else { };
          macosPinned = (macosPins.source or null) == toString guestSource
            && (macosPins.recipe or null) == self.lib.guestRuntimeRecipe
            && macosPins ? runtimes.session-runtime;
          # The guest runtime Nix provides, or null when Loom builds it on demand.
          hostRuntime =
            if hostSystem != "aarch64-darwin" then guestRuntimes.${guestSystem}.session-runtime
            else if macosPinned then macosRecipe macosPins.runtimes.session-runtime
            else null;
          # Read by runtime/src/packaged/artifact.ts (decodeRuntimeBuild).
          runtimeBuild = {
            version = 1;
            identity = guestRuntimeIdentity;
            builder = "${(macosRecipe pkgs.lib.fakeHash).prepare}/bin/loom-build-runtime";
          };
          # smolvm ships native binaries for Linux and Apple Silicon macOS.
          bundleSupported = pkgs.stdenv.hostPlatform.isLinux || hostSystem == "aarch64-darwin";
        in rec {
          default = loom;
          smolvm = hostSmolvm;
          session-runtime = if hostRuntime != null then hostRuntime else
            pkgs.runCommand "session-runtime-on-demand" { } ''
              echo "No pinned Apple Silicon guest runtime matches this source." >&2
              echo "Loom builds it on first use; run: loom runtime update" >&2
              exit 1
            '';

          # The standalone isolation CLI, packaged apart from loom/loomd and their
          # application graph; it defaults to the same session runtime and smolvm.
          loom-isolate = import ./packaging/loom-isolate.nix {
            inherit pkgs denoDeps;
            src = ./.;
            version = revFor;
            runtime = if bundleSupported then hostRuntime else null;
            runtimeBuild = if bundleSupported && hostRuntime == null
              then pkgs.writeText "loom-runtime-build.json" (builtins.toJSON runtimeBuild) else null;
            smolvm = if bundleSupported then hostSmolvm else null;
          };

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
            outputHash = {
              x86_64-linux = "sha256-JeIYu9P/hvvJsejrwiVw1nGobF5d9ZtHXZZv96Gopz0=";
              aarch64-linux = "sha256-x3tIH+zPXoL1hmzWZ+qU0WhBx/tUQULdq3Iduu4gC60=";
              aarch64-darwin = "sha256-MnOiIETqzptsamM3jNAyFXmTmvmhKVVGNUFM2TZCVRA=";
            }.${hostSystem};
          };

          loom = pkgs.lib.makeOverridable ({ withClaude ? true, withCodex ? true, withAisdk ? true }:
            let
              entry = source: {
                version = 1;
                inherit source;
                smolvm = "${hostSmolvm}/bin/smolvm";
              } // (if hostRuntime != null
                then { artifact = "${hostRuntime}"; preparedAt = "bundled"; }
                else { build = runtimeBuild; preparedAt = "on-demand"; });
              bundledRuntimes = pkgs.writeText "loom-bundled-runtimes.json" (builtins.toJSON (
                pkgs.lib.optionalAttrs withClaude { claude = entry "claude"; }
                // pkgs.lib.optionalAttrs withCodex { codex = entry "codex"; }
                // pkgs.lib.optionalAttrs withAisdk { aisdk = entry "aisdk"; }
              ));
            in
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
                  --add-flags "run -A --deny-net --cached-only --node-modules-dir=manual" \
                  --add-flags "$out/libexec/loom/cli/src/$bin.ts" \
                  --set DENO_NO_UPDATE_CHECK 1 \
                  --prefix PATH : ${pkgs.lib.makeBinPath ([ pkgs.git pkgs.bash pkgs.ripgrep pkgs.coreutils pkgs.nix ] ++ pkgs.lib.optional withClaude hostClaude ++ pkgs.lib.optional withCodex pkgs.codex)} \
                  --set LOOM_BUILD_VER ${finalAttrs.version} \
                  ${if (withClaude || withCodex || withAisdk) && bundleSupported
                    then "--set LOOM_BUNDLED_RUNTIMES ${bundledRuntimes}"
                    else "--unset LOOM_BUNDLED_RUNTIMES"}
              done

              runHook postInstall
            '';

            meta = {
              description = "Per-repo daemon that supervises a fleet of coding agents, each in its own git worktree";
              mainProgram = "loom";
              platforms = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
            };
          })) {};
        }
      );
    };
}
