/**
 * Corrective ESM load hook for @oxc-node (oxnode) 0.1.0.
 *
 * oxnode's ESM `load` hook decides module format from the nearest package.json
 * of the *current working directory* instead of the imported file's, so a
 * `.tsx` import resolves as `commonjs` (with a broken source) whenever the
 * process runs from a directory that is not inside a `"type": "module"`
 * package — e.g. any user project once `loom` is installed via nix. Node's CJS
 * loader then re-detects the file as ESM mid-compile and trips
 * ERR_REQUIRE_CYCLE_MODULE on the dynamic `import("@loom/tui/run")`.
 *
 * This hook sits outside oxnode's (sync hooks wrap async ones) and re-labels
 * only what oxnode mislabels: `.ts`/`.tsx` that come back as `commonjs`. In
 * this workspace every such file is first-party ESM; dependencies ship plain
 * `.js`, so they are never touched. When oxnode's decision is correct (format
 * `module`) the hook is a pass-through.
 */
import { registerHooks, createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { OxcTransformer } = require("@oxc-node/core");

// Anchor the transformer at this package root so its own package-type lookup
// resolves `"type": "module"` regardless of the process's working directory.
const transformer = new OxcTransformer(fileURLToPath(new URL("../..", import.meta.url)));

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (result?.format === "commonjs" && /\.(ts|tsx)$/.test(url)) {
      const file = fileURLToPath(url);
      const out = transformer.transform(file, readFileSync(file, "utf8"));
      let source = out.source();
      const map = out.sourceMap();
      if (map) {
        source +=
          "\n//# sourceMappingURL=data:application/json;charset=utf-8;base64," +
          Buffer.from(map, "utf8").toString("base64");
      }
      return { format: "module", source, shortCircuit: true };
    }
    return result;
  },
});
