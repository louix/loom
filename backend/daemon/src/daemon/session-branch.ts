/**
 * Names of the branches Loom creates for sessions. A prefix is a list of ref
 * components, so having none is the empty list rather than a special string.
 * Which branch belongs to a session is only ever read from its row, never
 * inferred from a name: with no prefix, any branch could look like one.
 */
import { z } from "zod";

/** `["loom"]` names `loom/<name>`, `["me", "loom"]` `me/loom/<name>`, `[]` bare `<name>`. */
export type BranchPrefix = readonly string[];

// `git check-ref-format --branch`, per component. A component never ends a
// branch name here, so the whole-name rules (no trailing `.`, not `@`) need no
// per-component check beyond the one below.
const validComponent = (c: string): boolean =>
  c !== "" &&
  c !== "@" &&
  !c.startsWith(".") &&
  !c.startsWith("-") &&
  !c.endsWith(".lock") &&
  !c.includes("..") &&
  !c.includes("@{") &&
  // oxlint-disable-next-line no-control-regex -- git refuses control characters in refs
  !/[\x00-\x20\x7f~^:?*[\\]/.test(c);

const components = (value: string): BranchPrefix => value.split("/").filter((c) => c !== "");

/** `session.branch_prefix` as written: `"loom"`, `"me/loom"`, or `""` for none. */
export const branchPrefixSchema = z
  .string()
  .refine(
    (v) => components(v).join("/") === v && components(v).every(validComponent),
    'must be "" (no prefix) or Git ref components joined by single slashes, like loom or me/loom: no leading or trailing slash, no component starting with . or - or ending with .lock, and no .., @{, spaces, control characters or any of ~ ^ : ? * [ \\',
  )
  .transform(components);

/** The branch `name` under `prefix`. */
export const sessionBranch = (prefix: BranchPrefix, name: string): string =>
  [...prefix, name].join("/");

/**
 * The prefix `branch` was generated under while it is still `id`'s generic
 * name (`sessionBranch(prefix, <first 8 of id>)`, or the full id after a
 * collision); null once renamed. Session ids and title slugs contain no `/`.
 */
export const genericBranchPrefix = (id: string, branch: string | null): BranchPrefix | null => {
  const parts = branch?.split("/") ?? [];
  const name = parts.at(-1);
  return name === id.slice(0, 8) || name === id ? parts.slice(0, -1) : null;
};

/**
 * Whether advertising `ref` to a clone (hideRefs `!ref`) shows any branch
 * named under the components `name`. Git compares hideRefs by whole
 * components, after dropping trailing slashes: `refs/heads/lo` does not cover
 * `refs/heads/loom/x`, while `refs/heads/` covers every branch.
 */
export const advertisesBranchesUnder = (ref: string, name: BranchPrefix): boolean => {
  const [refs, heads, ...under] = ref.replace(/\/+$/, "").split("/");
  if (refs !== "refs" || heads !== "heads") return false;
  const shared = Math.min(under.length, name.length);
  return under.slice(0, shared).every((c, i) => c === name[i]);
};
