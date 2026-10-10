import assert from "node:assert/strict";
import { test } from "node:test";
import {
  guestModules,
  guestSourceManifest,
  readGuestSourceManifest,
} from "../scripts/guest-source.ts";

test("the Apple Silicon guest source lists exactly the modules the guest loads", async () => {
  const graph = await guestModules();
  const listed = await readGuestSourceManifest();
  const missing = graph.filter((path) => !listed.includes(path));
  const unused = listed.filter((path) => !graph.includes(path));
  assert.deepEqual(
    { missing, unused },
    { missing: [], unused: [] },
    `${guestSourceManifest} is out of date; run deno task runtime:guest-source and commit it`,
  );
  // The modules guest.ts starts by path, not only what it imports.
  assert.ok(graph.includes("runtime/src/session-vm/capture-environment.ts"));
});

test("host-only trees stay out of the guest source", async () => {
  // Changing them must not change the runtime identity every Mac rebuilds against.
  const host = (await readGuestSourceManifest()).filter((path) =>
    /^(?:backend|cli|client|frontend|harness|isolation|environment-config|scripts|test)\//.test(
      path,
    ),
  );
  assert.deepEqual(host, []);
});
