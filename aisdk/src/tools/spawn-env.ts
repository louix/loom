/**
 * Environment for a tool subprocess: our own env with colour forced off. Tool
 * output lands in a transcript the model reads as plain text and our own
 * renderers re-colour, so ANSI escapes from `node --test`, `git`, linters etc.
 * are pure noise — and a stray `FORCE_COLOR` in the daemon's env would otherwise
 * defeat each tool's own TTY check. `NO_COLOR` is the cross-tool standard
 * (no-color.org).
 */
export const toolSpawnEnv = (): Record<string, string> => {
  const env: Record<string, string> = { ...Deno.env.toObject(), NO_COLOR: "1" };
  delete env["FORCE_COLOR"];
  delete env["CLICOLOR_FORCE"];
  return env;
};
