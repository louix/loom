{ pkgs }:
pkgs.runCommand "loom-git-shim" {
  nativeBuildInputs = [ pkgs.stdenv.cc ];
  buildInputs = [ pkgs.jansson ];
} ''
  mkdir -p $out/bin
  cp ${./git-shim.c} git-shim.c
  cc -std=c11 -O2 -g0 -Wall -Wextra -Werror git-shim.c -ljansson -o $out/bin/git
''
