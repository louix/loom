/** Guest argv is data. Only these read-only forms become host Git arguments. */
const fail = (): never => {
  throw new Error("Unsupported read-only Git command");
};
export const gitRef = (value: string): boolean => {
  if (value.length > 200) return false;
  const parts = value.split(/\.\.\.?/);
  return (
    parts.length <= 2 &&
    parts.every((part) => {
      const name = part.replace(/(?:[~^][0-9]{0,3}){0,4}$/, "");
      return (
        /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(name) &&
        !name.includes("..") &&
        !name.includes("//") &&
        !name.endsWith(".") &&
        !name.endsWith("/") &&
        name.split("/").every((p) => !p.startsWith(".") && !p.endsWith(".lock"))
      );
    })
  );
};
const path = (p: string) =>
  p.length > 0 &&
  p.length < 1024 &&
  !p.startsWith("/") &&
  !p.includes("\0") &&
  !p.includes("\n") &&
  !p.split("/").some((s) => s === ".." || s === ".git");
export const readOnlyGitArgs = (input: unknown): string[] => {
  if (
    !Array.isArray(input) ||
    input.length > 32 ||
    !input.every((a) => typeof a === "string" && a.length < 2048 && !a.includes("\0"))
  )
    return fail();
  const args = [...input] as string[];
  // Tilth requests unquoted paths to parse unified diffs. No other config override is accepted.
  let quote = true;
  if (args[0] === "-c" && args[1] === "core.quotePath=false") {
    args.splice(0, 2);
    quote = false;
  }
  const command = args.shift();
  const prefix = quote ? [] : ["-c", "core.quotePath=false"];
  if (
    command === "status" &&
    args.every((a) =>
      ["--short", "-s", "--porcelain", "--porcelain=v1", "-b", "--branch"].includes(a),
    )
  )
    return [...prefix, "status", "--ignore-submodules=all", "--untracked-files=normal", ...args];
  if (command === "branch" && args.join(" ") === "--show-current")
    return ["branch", "--show-current"];
  if (
    command === "rev-parse" &&
    ["--show-toplevel", "--is-inside-work-tree", "--short HEAD"].includes(args.join(" "))
  )
    return ["rev-parse", ...args];
  if (command === "diff") {
    const split = args.indexOf("--");
    const opts = split < 0 ? args : args.slice(0, split);
    const paths = split < 0 ? [] : args.slice(split + 1);
    if (!paths.every(path)) return fail();
    let refs = 0;
    for (const arg of opts) {
      if (
        [
          "--staged",
          "--cached",
          "--stat",
          "--name-only",
          "--name-status",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
        ].includes(arg)
      )
        continue;
      if (!gitRef(arg) || ++refs > 2) return fail();
    }
    return [
      ...prefix,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--ignore-submodules=all",
      ...opts,
      "--",
      ...paths,
    ];
  }
  if (command === "log") {
    const out: string[] = [];
    let refs = 0;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (["--oneline", "--format=%h %s", "--format=%H %at %s%x00%an"].includes(a)) {
        out.push(a);
        continue;
      }
      if (a === "-n" || a === "--max-count") {
        const n = args[++i];
        if (!n || !/^[1-9][0-9]?$/.test(n) || +n > 50) return fail();
        out.push(`--max-count=${n}`);
        continue;
      }
      if (/^(?:-n|--max-count=)([1-9][0-9]?)$/.test(a)) {
        const n = Number(a.replace(/^-n|^--max-count=/, ""));
        if (n > 50) return fail();
        out.push(`--max-count=${n}`);
        continue;
      }
      if (!gitRef(a) || ++refs > 1) return fail();
      out.push(a);
    }
    return [
      "log",
      "--max-count=10",
      "--format=%h %s",
      "--no-color",
      "--no-decorate",
      "--no-show-signature",
      ...out,
      "--",
    ];
  }
  if (command === "show" && args.length === 1) {
    const spec = args[0]!;
    const colon = spec.indexOf(":");
    const ref = spec.slice(0, colon);
    if (colon < 0 || (ref && (!gitRef(ref) || ref.includes(".."))) || !path(spec.slice(colon + 1)))
      return fail();
    // cat-file reads a blob without interpreting it as a commit or invoking textconv.
    return ["cat-file", "blob", spec];
  }
  return fail();
};
