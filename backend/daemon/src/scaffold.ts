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

/**
 * Web search for agents without their own (AISDK, and Codex with builtin_web_search off),
 * defined but not selected. Brave's official server is npm-only (2.1.4, published
 * 2026-09-17); Tavily's official one is hosted and takes the key as a bearer token.
 */
export const SEARCH_MCP_SERVERS = {
  brave: {
    source: {
      kind: "command",
      command: "npx",
      args: ["--yes", "@brave/brave-search-mcp-server@2.1.4", "--transport", "stdio"],
      pass_env: ["BRAVE_API_KEY"],
    },
    default_for: ["web_search"],
  },
  tavily: {
    source: { kind: "http", url: "https://mcp.tavily.com/mcp/" },
    auth: { bearer_token_env: "TAVILY_API_KEY" },
    default_for: ["web_search", "web_fetch"],
  },
} as const;

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
        "// Web search: set BRAVE_API_KEY or TAVILY_API_KEY for the daemon, then add brave or\n" +
        '// tavily to session.mcp_servers, e.g. "session": { "mcp_servers": ["tavily"] }.\n' +
        "// brave runs on the host (npx), so VM sessions can only use tavily.\n" +
        JSON.stringify(
          {
            $schema: "./config.schema.json",
            providers: { claude: {} },
            session: {},
            mcp_servers: SEARCH_MCP_SERVERS,
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
