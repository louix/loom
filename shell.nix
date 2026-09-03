# Compat shim so `nix-shell` also works. `nix develop` uses flake.nix directly.
# Use a git+file ref, not a bare path: the path fetcher copies the whole tree
# into the store (ignoring .gitignore) and dies on .loom/daemon.sock — a Unix
# socket — whenever the daemon is running. git+file only copies tracked files.
(builtins.getFlake ("git+file://" + toString ./.)).devShells.${builtins.currentSystem}.default
