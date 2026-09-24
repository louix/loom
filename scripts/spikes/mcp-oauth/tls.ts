/**
 * Opt-in public-network probe; no credentials or account required.
 * deno run --no-config --allow-net scripts/spikes/mcp-oauth/tls.ts
 * Broad net is for this public, credential-free probe only (DNS + resolved IP).
 */
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";

const hostname = "registry.npmjs.org";
const { address, family } = await lookup(hostname, { family: 4 });
let lookups = 0;
const probe = async (servername: string) => {
  return await new Promise<number>((resolve, reject) => {
    const req = request(
      {
        hostname,
        servername: hostname,
        ...(servername === hostname
          ? {}
          : {
              checkServerIdentity: (
                _host: string,
                cert: Parameters<typeof checkServerIdentity>[1],
              ) => checkServerIdentity(servername, cert),
            }),
        path: "/oauth4webapi/3.8.8",
        agent: false,
        family: 4,
        lookup(_host, _options, callback) {
          lookups++;
          callback(null, address, family);
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("probe timeout")));
    req.end();
  });
};
assert.equal(await probe(hostname), 200);
await assert.rejects(probe("wrong-hostname.invalid"), /certificate|cert|hostname|TLS/i);
assert.equal(lookups, 2);
console.log(
  "PASS: pinned HTTPS address, original hostname verification, mismatched hostname rejected",
);
