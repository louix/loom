/** Regenerate the editor schema whenever config validation changes. */
import { configEditorSchema } from "../backend/daemon/src/config/schema.ts";
import { DEFAULT_CONFIG, HOOK_EVENTS } from "../backend/daemon/src/config/config.ts";
const path = new URL("../backend/daemon/config.schema.json", import.meta.url);
const text = JSON.stringify(configEditorSchema(DEFAULT_CONFIG, HOOK_EVENTS), null, 2) + "\n";
await Deno.writeTextFile(path, text);
