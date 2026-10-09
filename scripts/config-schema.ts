/** Regenerate the editor schemas whenever config validation changes. */
import { z } from "zod";
import { configEditorSchema } from "../backend/daemon/src/config/schema.ts";
import { DEFAULT_CONFIG, HOOK_EVENTS } from "../backend/daemon/src/config/config.ts";
import { environmentEditorSchemas } from "../environment-config/src/schema.ts";
const path = new URL("../backend/daemon/config.schema.json", import.meta.url);
const text = JSON.stringify(configEditorSchema(DEFAULT_CONFIG, HOOK_EVENTS), null, 2) + "\n";
await Deno.writeTextFile(path, text);
for (const [name, schema] of Object.entries(environmentEditorSchemas))
  await Deno.writeTextFile(
    new URL("../environment-config/" + name + ".schema.json", import.meta.url),
    JSON.stringify(z.toJSONSchema(schema, { target: "draft-07", io: "input" }), null, 2) + "\n",
  );
