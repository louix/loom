/** One endpoint-scoped catalog request; credentials arrive on stdin, never argv. */
import { parseModelRows } from "../../../backend/daemon/src/daemon/model-catalog.ts";
import { FrameWriter, readFrames } from "./transport.ts";
const input = readFrames(Deno.stdin.readable, (value) => value);
const writer = new FrameWriter(Deno.stdout.writable);
try {
  const first = await input.next();
  if (first.done) Deno.exit(0);
  const { baseUrl, apiKey } = first.value as { baseUrl: string; apiKey: string };
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Catalog endpoint rejected request");
  await writer.send({ models: parseModelRows(await response.json()) });
} catch {
  await writer.send({ error: "Model catalog request failed; check the endpoint and credentials" });
}
Deno.exit(0);
