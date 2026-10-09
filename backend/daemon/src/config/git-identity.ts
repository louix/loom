/**
 * Session commit identity. Sessions commit as the user's ordinary Git identity
 * unless trusted config overrides it, globally (`git`) or for one repository
 * (`repos[].git`). Only identity values reach a session, as `GIT_AUTHOR_*` /
 * `GIT_COMMITTER_*`: never Git config, signing keys or signing settings, and
 * the user's own repository config is never rewritten.
 */
import { spawnSync } from "node:child_process";
import { z } from "zod";

const PLACEHOLDERS = ["model", "modelSlug", "profile"] as const;

const gitIdentityText = z
  .string()
  .min(1)
  .max(200)
  // oxlint-disable-next-line no-control-regex -- Git identities must not contain control bytes.
  .regex(/^[^\x00-\x1f\x7f<>]+$/);
const gitTemplate = gitIdentityText.refine(
  (v) =>
    [...v.matchAll(/\{([^{}]+)\}/g)].every(([, token]) => PLACEHOLDERS.some((p) => p === token)),
  "unknown placeholder; use {model}, {modelSlug} or {profile}",
);
const gitPerson = z.strictObject({
  name: gitTemplate.optional(),
  email: gitTemplate.optional(),
});
/** Same shape as main-new's `git` / `repos[].git`, so a converter can copy it verbatim. */
export const gitIdentitySchema = gitPerson
  .extend({
    author: gitPerson.optional().describe("Overrides name/email for the commit author only."),
    committer: gitPerson.optional().describe("Overrides name/email for the committer only."),
  })
  .describe(
    "Session commit identity. Omit to use your normal Git identity. name/email set both roles; author/committer override one role. Values may use {model}, {modelSlug} and {profile}.",
  );
export type GitIdentityConfig = z.output<typeof gitIdentitySchema>;

/** Launch-time values for the literal (never shell-evaluated) template placeholders. */
export interface GitIdentityContext {
  model?: string;
  /** The provider id (`claude`, `claude:work`, `codex`, …). */
  profile?: string;
}

/** `GIT_AUTHOR_NAME` … `GIT_COMMITTER_EMAIL`; a value Git could not resolve is absent. */
export type GitIdentityEnvironment = Record<string, string>;

export const expandGitIdentity = (template: string, context: GitIdentityContext): string =>
  template.replace(/\{([^{}]+)\}/g, (_, token: string) => {
    if (token === "model") return context.model || "unknown";
    if (token === "modelSlug")
      return (context.model || "unknown").replace(/[^a-zA-Z0-9._+-]/g, "-");
    if (token === "profile") return context.profile || "unknown";
    throw new Error("Unknown Git identity placeholder: {" + token + "}");
  });

/**
 * Per role and field: explicit Loom setting (role-specific, then shared) wins;
 * otherwise `GIT_<ROLE>_<FIELD>` from `environment`, then `<role>.<field>` and
 * `user.<field>` from Git config as seen from `repository`, then `EMAIL`.
 */
export const resolveGitIdentity = (
  repository: string,
  config: GitIdentityConfig | undefined,
  context: GitIdentityContext = {},
  environment: Record<string, string | undefined> = Deno.env.toObject(),
): GitIdentityEnvironment => {
  const read = (key: string): string | undefined => {
    const result = spawnSync("git", ["-C", repository, "config", "--get", key], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1)
      throw new Error("Could not read Git identity configuration: " + key);
    return result.status === 0 ? result.stdout.replace(/\n$/, "") || undefined : undefined;
  };
  const defaults: { name?: string | undefined; email?: string | undefined } = {};
  const result: GitIdentityEnvironment = {};
  for (const role of ["author", "committer"] as const) {
    for (const field of ["name", "email"] as const) {
      const key = `GIT_${role.toUpperCase()}_${field.toUpperCase()}`;
      const template = config?.[role]?.[field] ?? config?.[field];
      let value: string | undefined;
      if (template !== undefined) value = expandGitIdentity(template, context);
      else {
        value = environment[key] || read(`${role}.${field}`);
        if (!value) {
          if (!(field in defaults)) defaults[field] = read(`user.${field}`);
          value = defaults[field] || (field === "email" ? environment.EMAIL : undefined);
        }
      }
      if (value === undefined) continue;
      // Expansion and inherited values must not introduce invalid identity bytes either.
      if (!gitIdentityText.safeParse(value).success)
        throw new Error(
          `Invalid Git ${role} ${field}: use 1–200 characters without <, > or control characters`,
        );
      result[key] = value;
    }
  }
  return result;
};

/**
 * Host-only launch metadata: symbols survive wrapper spreads, but never cross
 * the worker wire. Set by the provider registry on every session launch.
 */
export const sessionGitIdentity = Symbol("sessionGitIdentity");
export type SessionGitIdentity = { [sessionGitIdentity]?: GitIdentityEnvironment };
