# Compat shim so `nix-shell` also works. `nix develop` uses flake.nix directly.
(builtins.getFlake (toString ./.)).devShells.${builtins.currentSystem}.default
