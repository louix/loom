import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userConfigPath } from "./config-path.ts";
import { DEFAULT_CONFIG, HOOK_EVENTS } from "./config/config.ts";
import { configEditorSchema } from "./config/schema.ts";
export { userConfigPath } from "./config-path.ts";

export const exampleConfigPath = (): string =>
  join(import.meta.dirname!, "..", "config.example.jsonc");
export const exampleSchemaPath = (): string =>
  join(import.meta.dirname!, "..", "config.schema.json");
export const userSchemaPath = (): string => join(dirname(userConfigPath()), "config.schema.json");

/** Refresh editor support on launch and create a small starter on first run. */
export const scaffoldUserConfig = (): string | null => {
  const dest = userConfigPath();
  mkdirSync(dirname(dest), { recursive: true });
  const schema = JSON.stringify(configEditorSchema(DEFAULT_CONFIG, HOOK_EVENTS), null, 2) + "\n";
  if (!existsSync(userSchemaPath()) || readFileSync(userSchemaPath(), "utf8") !== schema)
    writeFileSync(userSchemaPath(), schema);
  try {
    writeFileSync(
      dest,
      "// Loom configuration. Comments and trailing commas are supported.\n" +
        JSON.stringify(
          {
            $schema: "./config.schema.json",
            providers: { claude: {} },
            session: {},
            repos: [],
          },
          null,
          2,
        ) +
        "\n",
      { flag: "wx", mode: 0o600 },
    );
    return dest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
};
