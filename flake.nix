{
  description = "loom — per-repo agent-fleet daemon (dev shell + package)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  # Packages smolvm 1.14.6, including host disk-resizing tools on macOS.
  inputs.smolvm.url = "github:smol-machines/smolvm/5098b07eddd12377fe12f257be7f5e92be7f5840";
  # Match the release's submodule when rebuilding its bundled libkrun.
  inputs.smolvm.inputs.libkrun-src.url = "github:smol-machines/libkrun/d3486f7a4ac99c64683e628dc6d297e29b3d381d";

  inputs.tilth.url = "github:jahala/tilth/f5c0afa97c6666a3d68dcbd965a4db5a44bc0905";

  outputs =
    { self, nixpkgs, smolvm, tilth }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Split session runtimes need a code share in addition to the worktree,
      # Git metadata, credentials and profile. libkrun's legacy x86 IRQ ceiling
      # (15) exhausts the device budget before attaching vsock. KVM's I/O APIC
      # has 24 pins; allow virtio devices to use the remaining GSIs through 23.
      # Keep the MP table in sync, as in firecracker-microvm/firecracker#2286.
      hostSmolvmFor = system:
        let
          upstream = smolvm.packages.${system};
          pkgs = smolvm.inputs.nixpkgs.legacyPackages.${system};
          # Link against the release's existing firmware; only libkrun changes.
          libkrunfw = pkgs.lib.makeOverridable ({ variant ? null }:
            assert variant == null;
            pkgs.runCommand "smolvm-libkrunfw" { meta.platforms = [ system ]; } ''
              mkdir -p $out/lib
              cp -a ${upstream.default}/libexec/smolvm/lib/libkrunfw.so* $out/lib/
            ''
          ) {};
          libkrun = (upstream.libkrun.override { inherit libkrunfw; }).overrideAttrs (old: {
            version = "2.0.0-dev";
            src = old.src;
            cargoDeps = pkgs.rustPlatform.fetchCargoVendor {
              inherit (old) src;
              hash = "sha256-Opf4QK5k5Lq0zYo5Bmo5teUvr1kBctnI2EOW+MxhMTI=";
            };
            # The guest cannot load the host's Nix dynamic linker. Build its
            # embedded PID 1 statically, separately from the host shared library.
            preBuild = (old.preBuild or "") + ''
              CARGO_ENCODED_RUSTFLAGS="-Ctarget-feature=+crt-static" \
                cargo build --offline --release -p krun-init --target ${pkgs.stdenv.hostPlatform.rust.rustcTarget}
              export KRUN_INIT_BINARY_PATH="$PWD/target/${pkgs.stdenv.hostPlatform.rust.rustcTarget}/release/krun-init"
            '';
            postPatch = (old.postPatch or "") + ''
              substituteInPlace src/arch/src/x86_64/layout.rs \
                --replace-fail 'pub const IRQ_MAX: u32 = 15;' 'pub const IRQ_MAX: u32 = 23;'
              substituteInPlace src/arch/src/x86_64/mptable.rs \
                --replace-fail 'mem::size_of::<MpcIntsrcWrapper>() * 16' \
                  'mem::size_of::<MpcIntsrcWrapper>() * (crate::IRQ_MAX as usize + 1)' \
                --replace-fail 'for i in 0..16 {' 'for i in 0..=crate::IRQ_MAX as u8 {'
            '';
          });
        in if system != "x86_64-linux" then upstream.default
        else upstream.default.overrideAttrs (old: {
          postInstall = (old.postInstall or "") + ''
            rm $out/libexec/smolvm/lib/libkrun.so*
            cp -a ${libkrun}/lib/libkrun.so* $out/libexec/smolvm/lib/
          '';
        });

      # Guests always run Linux, independently of the machine running Loom/smolvm.
      guestSystemFor = system: builtins.replaceStrings [ "-darwin" ] [ "-linux" ] system;
      guestRuntimes = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
        codex-session-runtime = import ./packaging/runtimes/codex.nix {
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "claude-code";
          };
          loom = self.packages.${system}.loom.override { withTilth = false; withClaude = false; withCodex = false; withAisdk = false; };
        };
        aisdk-session-runtime = import ./packaging/runtimes/aisdk.nix {
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "claude-code";
          };
          loom = self.packages.${system}.loom.override { withTilth = false; withClaude = false; withCodex = false; withAisdk = false; };
        };
        claude-session-runtime = import ./packaging/runtimes/claude.nix {
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfreePredicate = pkg: nixpkgs.lib.getName pkg == "claude-code";
          };
          loom = self.packages.${system}.loom.override { withTilth = false; withClaude = false; withCodex = false; withAisdk = false; };
        };
        tilth-runtime = (import ./packaging/runtimes/tilth.nix {
          inherit tilth system;
        }).tilth-runtime;
      });

      # Exclude output hashes to avoid a source/hash cycle. Tests, docs and
      # maintainer scripts are not part of the executable guest closure.
      guestSource = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions [
          ./aisdk ./backend ./cli ./client ./connectors ./core ./frontend
          ./harness ./runtime ./packaging/runtimes
          ./deno.json ./deno.lock ./flake.nix ./flake.lock
        ];
      };
      # Short commit for `loom --version` when built from a checkout; a tag
      # would surface as the full ref. The flake sandbox has no `.git`, so the
      # daemon/CLI can't `git describe` at runtime — we stamp it here instead
      # (see core/src/version.ts).
      revFor = "0.0.0-g" + (self.shortRev or self.dirtyShortRev or "unknown");
    in
    {
      lib.guestRuntimeSource = guestSource;
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
          runtimeHashes = builtins.fromJSON (builtins.readFile ./packaging/macos/runtime-hashes.json);
          hostRuntimes = if hostSystem == "aarch64-darwin" then
            if runtimeHashes.source != toString guestSource ||
               (runtimeHashes.recipe or "") != self.lib.guestRuntimeRecipe then
              throw "macOS guest runtime hashes are stale; run deno task runtime:hashes on Apple Silicon and commit the updated manifest"
            else pkgs.lib.mapAttrs (runtime: hash: import ./packaging/macos/runtime.nix {
              inherit pkgs runtime hash;
              smolvm = hostSmolvm;
              source = guestSource;
            }) runtimeHashes.runtimes
          else guestRuntimes.${guestSystem};
          # smolvm ships native binaries for Linux and Apple Silicon macOS.
          bundleSupported = pkgs.stdenv.hostPlatform.isLinux || hostSystem == "aarch64-darwin";
        in rec {
          default = loom;
          smolvm = hostSmolvm;
          session-runtime = hostRuntimes.claude-session-runtime;
          claude-session-runtime = hostRuntimes.claude-session-runtime;
          aisdk-session-runtime = hostRuntimes.aisdk-session-runtime;
          codex-session-runtime = hostRuntimes.codex-session-runtime;
          tilth-runtime = hostRuntimes.tilth-runtime;


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
              x86_64-linux = "sha256-vU5sR4DvPDZJyAOijOxVssHSZejpMW/510m6nnWC6QE=";
              aarch64-linux = "sha256-83AkbdVu6fSc/DpAbUPmO44C8VwQmZ60vFWzT4MxSiw=";
              aarch64-darwin = "sha256-xY4GU5iLa+xnZXwTifFyipQP5OVYh/yqxGoJIGqzEzI=";
            }.${hostSystem};
          };

          loom = pkgs.lib.makeOverridable ({ withTilth ? true, withClaude ? true, withCodex ? true, withAisdk ? true }:
            let
              entry = source: artifact: {
                version = 1;
                inherit source artifact;
                smolvm = "${hostSmolvm}/bin/smolvm";
                preparedAt = "bundled";
              };
              bundledRuntimes = pkgs.writeText "loom-bundled-runtimes.json" (builtins.toJSON (
                pkgs.lib.optionalAttrs withTilth { tilth = entry "tilth" "${tilth-runtime}"; }
                // pkgs.lib.optionalAttrs withClaude { claude = entry "claude" "${claude-session-runtime}"; }
                // pkgs.lib.optionalAttrs withCodex { codex = entry "codex" "${codex-session-runtime}"; }
                // pkgs.lib.optionalAttrs withAisdk { aisdk = entry "aisdk" "${aisdk-session-runtime}"; }
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
                  ${if (withTilth || withClaude || withCodex || withAisdk) && bundleSupported
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
