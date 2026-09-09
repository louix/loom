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

for (const shutdown of [false, true]) {
  Deno.test(`session egress aborts pending dial on ${shutdown ? "shutdown" : "deadline"} and holds its connection slot`, async () => {
    const state = await Deno.makeTempDir({ dir: "/tmp" });
    const socket = join(state, "proxy.sock");
    const dialing = Promise.withResolvers<AbortSignal>();
    let dials = 0;
    const proxy = startEgress(socket, () => {}, {
      timeoutMs: shutdown ? 10_000 : 250,
      maxConnections: 1,
      dial: (signal) => {
        dials++;
        dialing.resolve(signal);
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    const clients: Deno.Conn[] = [];
    const request = async () => {
      const client = await Deno.connect({ transport: "unix", path: socket });
      clients.push(client);
      await client.write(
        new TextEncoder().encode("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n"),
      );
      return client;
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await request();
      const signal = await dialing.promise;
      const second = await request();
      try {
        assert.equal(await second.read(new Uint8Array(1024)), null);
      } catch (error) {
        if (!(error instanceof Deno.errors.ConnectionReset)) throw error;
      }
      assert.equal(dials, 1);
      await Promise.race([
        shutdown ? proxy.close() : first.read(new Uint8Array(1024)),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("dial did not abort")), 2000);
        }),
      ]);
      assert(signal.aborted);
      await proxy.close(); // idempotent
    } finally {
      clearTimeout(deadline);
      for (const client of clients) client.close();
      await proxy.close();
      await Deno.remove(state, { recursive: true });
    }
  });
}

Deno.test("extra hosts grant only exact HTTPS destinations and retain the provider endpoint", async () => {
  for (const extraAllowedHosts of [[], ["registry.npmjs.org"]]) {
    const state = await Deno.makeTempDir({ dir: "/tmp" });
    const socket = join(state, "proxy.sock");
    const dialed: string[] = [];
    const proxy = startEgress(socket, () => {}, {
      extraAllowedHosts,
      dial: async (_signal, host) => {
        dialed.push(host);
        return {
          readable: new ReadableStream(),
          writable: new WritableStream(),
          close() {},
        };
      },
    });
    try {
      for (const target of [
        "api.anthropic.com:443",
        "REGISTRY.NPMJS.ORG:443",
        "registry.npmjs.org:80",
        "evil.registry.npmjs.org:443",
        "registry.npmjs.org.evil.test:443",
        "1.1.1.1:443",
      ]) {
        const client = await Deno.connect({ transport: "unix", path: socket });
        try {
          await client.write(new TextEncoder().encode(`CONNECT ${target} HTTP/1.1\r\n\r\n`));
          const bytes = new Uint8Array(1024);
          const size = await client.read(bytes);
          const allowed =
            target === "api.anthropic.com:443" ||
            (extraAllowedHosts.length > 0 && target === "REGISTRY.NPMJS.ORG:443");
          assert.match(
            new TextDecoder().decode(bytes.subarray(0, size!)),
            allowed ? /200 Connection Established/ : /403 Forbidden/,
          );
        } finally {
          client.close();
        }
      }
      assert.deepEqual(dialed, ["api.anthropic.com", ...extraAllowedHosts]);
    } finally {
      await proxy.close();
      await Deno.remove(state, { recursive: true });
    }
  }
});
