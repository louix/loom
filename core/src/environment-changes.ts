/** Export changes only: inherited daemon credentials never become session metadata. */
export interface EnvironmentChanges {
  set: Record<string, string>;
  unset: string[];
}

/** Launch-owned paths and credentials retain precedence over development shell exports. */
const protectedKey = (key: string) =>
  key.startsWith("LOOM_") ||
  [
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TEMPDIR",
    "NIX_BUILD_TOP",
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
    "DENO_DIR",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ].includes(key);

export const environmentChanges = (
  before: Record<string, string>,
  after: Record<string, string>,
): EnvironmentChanges => ({
  set: Object.fromEntries(
    Object.entries(after).filter(([key, value]) => !protectedKey(key) && before[key] !== value),
  ),
  unset: Object.keys(before).filter((key) => !protectedKey(key) && !(key in after)),
});

export const applyEnvironmentChanges = (
  base: Record<string, string>,
  changes?: EnvironmentChanges,
): Record<string, string> => {
  const result = { ...base, ...changes?.set };
  for (const key of changes?.unset ?? []) delete result[key];
  return result;
};
