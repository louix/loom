/** Runtime releases share bases only when packaging declares a stable guest layout. */
import { join } from "node:path";
import { decodeManifest } from "../packaged/artifact.ts";

export const environmentIdentity = async (artifact: string): Promise<string> => {
  let text: string;
  try {
    text = await Deno.readTextFile(join(artifact, "manifest.json"));
  } catch (error) {
    // Preserve exact-path compatibility for legacy artifacts.
    if (error instanceof Deno.errors.NotFound) return artifact;
    throw error;
  }
  const manifest = decodeManifest(JSON.parse(text));
  return manifest.environmentCompatibility
    ? `environment:${manifest.environmentCompatibility}`
    : artifact;
};
