/** POSIX native workers lead their own process group. Parent EOF must also
 * clean up ordinary descendants when the daemon is no longer alive to do it.
 * Detached descendants are outside this lifecycle mechanism, not confined. */
export const exitWorker = (code: number): never => {
  if (Deno.args.includes("--process-group")) {
    Deno.kill(-Deno.pid, "SIGKILL");
  }
  Deno.exit(code);
};

export const armWorkerShutdown = () => {
  if (Deno.args.includes("--process-group")) setTimeout(() => exitWorker(1), 5000);
};
