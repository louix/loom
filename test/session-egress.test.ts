import assert from "node:assert/strict";
import { join } from "node:path";
import { startEgress } from "../runtime/src/session-vm/egress.ts";
Deno.test("session egress rejects alternate hosts, ports and IP addresses", async () => {
  const state = await Deno.makeTempDir({ dir: "/tmp" });
  const reports: Array<{ host: string; allowed: boolean }> = [];
  const proxy = startEgress(join(state, "proxy.sock"), (host, allowed) =>
    reports.push({ host, allowed }),
  );
  try {
    for (const target of [
      "example.com:443",
      "api.anthropic.com:80",
      "1.1.1.1:443",
      "api.anthropic.com.evil.test:443",
      "api.anthropic.com@evil.test:443",
      "[::1]:443",
    ]) {
      const client = await Deno.connect({ transport: "unix", path: join(state, "proxy.sock") });
      try {
        await client.write(
          new TextEncoder().encode(
            `CONNECT ${target} HTTP/1.1\r\nAuthorization: never-log-this\r\n\r\n`,
          ),
        );
        const bytes = new Uint8Array(1024);
        const n = await client.read(bytes);
        assert.match(new TextDecoder().decode(bytes.subarray(0, n!)), /403 Forbidden/);
      } finally {
        client.close();
      }
    }
    assert(reports.every((row) => !row.allowed));
    assert(!JSON.stringify(reports).includes("never-log-this"));
  } finally {
    await proxy.close();
    await Deno.remove(state, { recursive: true });
  }
});
