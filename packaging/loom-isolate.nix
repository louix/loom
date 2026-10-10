# loom-isolate alone: the standalone isolation CLI and only its module graph
# (see copy-isolate-cli.ts), with the session runtime and smolvm it defaults to.
# Without a Nix-built runtime (an unpinned Mac), it builds one on first use.
{ pkgs, src, denoDeps, version, runtime ? null, runtimeBuild ? null, smolvm ? null }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "loom-isolate";
  inherit src version;
  nativeBuildInputs = [ pkgs.deno pkgs.makeWrapper ];
  dontConfigure = true;
  dontPatchShebangs = true;
  dontCheckForBrokenSymlinks = true;
  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR"
    export DENO_DIR="${denoDeps}"
    deno install --frozen --cached-only
    deno run -A --cached-only packaging/copy-isolate-cli.ts "$TMPDIR/loom-isolate"
    cd "$TMPDIR/loom-isolate"
    deno install --frozen --cached-only
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec/loom-isolate
    cp -R . $out/libexec/loom-isolate
    makeWrapper ${pkgs.deno}/bin/deno $out/bin/loom-isolate \
      --add-flags "run -A --deny-net --cached-only --frozen --node-modules-dir=manual" \
      --add-flags "$out/libexec/loom-isolate/cli/src/loom-isolate.ts" \
      --set DENO_NO_UPDATE_CHECK 1 \
      --set LOOM_BUILD_VER ${version} \
      ${pkgs.lib.optionalString (runtime != null) "--set-default LOOM_ISOLATE_ARTIFACT ${runtime}"} \
      ${pkgs.lib.optionalString (runtimeBuild != null) "--set-default LOOM_ISOLATE_RUNTIME_BUILD ${runtimeBuild}"} \
      ${pkgs.lib.optionalString (smolvm != null) "--set-default LOOM_ISOLATE_SMOLVM ${smolvm}/bin/smolvm"} \
      --prefix PATH : ${pkgs.lib.makeBinPath ([ pkgs.git pkgs.coreutils ] ++ pkgs.lib.optional (runtimeBuild != null) pkgs.nix)}
    runHook postInstall
  '';
  meta = {
    description = "Run commands in a smolvm VM over a workspace, without the Loom daemon or agents";
    mainProgram = "loom-isolate";
    platforms = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
  };
}
