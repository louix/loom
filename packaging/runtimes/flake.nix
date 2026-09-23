{
  description = "Server-independent Loom runtime packaging helper";
  outputs = { ... }: {
    lib.mkRuntime = import ./mk-runtime.nix;
  };
}
