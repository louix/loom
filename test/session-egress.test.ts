import assert from "node:assert/strict";
import { join } from "node:path";
import { startEgress } from "../runtime/src/egress.ts";
Deno.test("session egress rejects alternate hosts, ports and IP addresses", async () => {
  const state = await Deno.makeTempDir({ dir: "/tmp" });
  const reports: Array<{ host: string; allowed: boolean }> = [];
  const proxy = startEgress(join(state, "proxy.sock"), ["api.anthropic.com"], (host, allowed) =>
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
    const proxy = startEgress(socket, ["api.anthropic.com"], () => {}, {
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

Deno.test("shared egress dials only the configured authority and forwards tunnel bytes", async () => {
  const state = await Deno.makeTempDir({ dir: "/tmp" });
  const socket = join(state, "proxy.sock");
  const received = Promise.withResolvers<string>();
  let selected = "";
  const proxy = startEgress(socket, ["api.example.com"], () => {}, {
    dial: async (_signal, host) => {
      selected = host;
      return {
        readable: new ReadableStream(),
        writable: new WritableStream({
          write(bytes) {
            received.resolve(new TextDecoder().decode(bytes));
          },
        }),
        close() {},
      };
    },
  });
  const client = await Deno.connect({ transport: "unix", path: socket });
  try {
    await client.write(
      new TextEncoder().encode("CONNECT API.EXAMPLE.COM:443 HTTP/1.1\r\n\r\nhello"),
    );
    const bytes = new Uint8Array(1024);
    const n = await client.read(bytes);
    assert.match(new TextDecoder().decode(bytes.subarray(0, n!)), /200 Connection Established/);
    assert.equal(selected, "api.example.com");
    assert.equal(await received.promise, "hello");
  } finally {
    client.close();
    await proxy.close();
    await Deno.remove(state, { recursive: true });
  }
});

Deno.test("empty egress policy grants no default destination", async () => {
  const state = await Deno.makeTempDir({ dir: "/tmp" });
  const socket = join(state, "proxy.sock");
  let dialed = false;
  const proxy = startEgress(socket, [], () => {}, {
    dial: async () => {
      dialed = true;
      throw new Error("unexpected dial");
    },
  });
  const client = await Deno.connect({ transport: "unix", path: socket });
  try {
    await client.write(new TextEncoder().encode("CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n"));
    const bytes = new Uint8Array(1024);
    const n = await client.read(bytes);
    assert.match(new TextDecoder().decode(bytes.subarray(0, n!)), /403 Forbidden/);
    assert.equal(dialed, false);
  } finally {
    client.close();
    await proxy.close();
    await Deno.remove(state, { recursive: true });
  }
});
