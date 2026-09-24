/** Bounded OAuth HTTP operations. No DNS, proxies, redirects, cookies or retries. */
import { request as httpRequest, type IncomingMessage, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  OAuthTransportError,
  prepareOAuthEndpoint,
  type OAuthEndpointInput,
} from "./mcp-oauth-endpoint.ts";

export interface OAuthFetchOptions {
  /** Trusted development policy, never derived from metadata. */
  allowLoopback?: boolean;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}
/** oauth4webapi explicitly passes body: undefined on GET under exact optional types. */
export type OAuthFetch = (
  input: RequestInfo | URL,
  init?: Omit<RequestInit, "body"> & { body?: BodyInit | null | undefined },
) => Promise<Response>;

const limit = (value: number | undefined, fallback: number, ceiling: number): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > ceiling)
    throw new OAuthTransportError("invalid_request");
  return result;
};
const requestBody = (body: BodyInit | null | undefined, max: number): Uint8Array | undefined => {
  if (body == null) return;
  if (body instanceof URLSearchParams) body = body.toString();
  let bytes: Uint8Array;
  if (typeof body === "string") {
    if (body.length > max) throw new OAuthTransportError("request_too_large");
    bytes = new TextEncoder().encode(body);
  } else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  else if (ArrayBuffer.isView(body))
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  else throw new OAuthTransportError("invalid_request");
  if (bytes.byteLength > max) throw new OAuthTransportError("request_too_large");
  return bytes.slice();
};
const forbiddenHeaders = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "cookie",
  "accept-encoding",
  "expect",
]);

/**
 * Fetch subset used by oauth4webapi: URL/string inputs, GET/POST, buffered bodies.
 * Plans are copied and revalidated at construction. No ambient fetch/DNS fallback.
 * Each call uses the first validated address, a fresh socket and one attempt.
 */
export const createOAuthFetch = (
  inputs: readonly OAuthEndpointInput[],
  options: OAuthFetchOptions = {},
): OAuthFetch => {
  if (!inputs.length || inputs.length > 16) throw new OAuthTransportError("endpoint_denied");
  const plans = new Map(
    inputs.map((input) => {
      const plan = prepareOAuthEndpoint(input, options.allowLoopback);
      return [plan.url, plan] as const;
    }),
  );
  if (plans.size !== inputs.length) throw new OAuthTransportError("endpoint_denied");
  const timeoutMs = limit(options.timeoutMs, 30_000, 60_000);
  const maxRequest = limit(options.maxRequestBytes, 64 * 1024, 1024 * 1024);
  const maxResponse = limit(options.maxResponseBytes, 1024 * 1024, 8 * 1024 * 1024);

  return async (input, init) => {
    // oauth4webapi passes a URL string and RequestInit. Request streams are not supported.
    if (!(typeof input === "string" || input instanceof URL))
      throw new OAuthTransportError("invalid_request");
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new OAuthTransportError("endpoint_denied");
    }
    const plan = plans.get(url.href);
    if (!plan) throw new OAuthTransportError("endpoint_denied");
    const method = init?.method?.toUpperCase() ?? "GET";
    if (!["GET", "POST"].includes(method)) throw new OAuthTransportError("invalid_request");
    let headers: Headers;
    try {
      headers = new Headers(init?.headers);
    } catch {
      throw new OAuthTransportError("invalid_request");
    }
    for (const name of headers.keys())
      if (forbiddenHeaders.has(name)) throw new OAuthTransportError("invalid_request");
    const body = requestBody(init?.body, maxRequest);
    if (method === "GET" && body) throw new OAuthTransportError("invalid_request");
    headers.set("accept-encoding", "identity");
    if (body) headers.set("content-length", String(body.byteLength));
    const headerBytes = new TextEncoder().encode(
      [...headers].map(([key, value]) => key + ": " + value + "\r\n").join(""),
    ).byteLength;
    if (headerBytes > 16 * 1024) throw new OAuthTransportError("request_too_large");
    const signal = init?.signal;
    if (signal?.aborted) throw new OAuthTransportError("aborted");

    return await new Promise<Response>((resolve, reject) => {
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const fail = (error: OAuthTransportError) => {
        if (settled) return;
        settled = true;
        cleanup();
        response?.destroy();
        request?.destroy();
        reject(error);
      };
      const abort = () => fail(new OAuthTransportError("aborted"));
      // Covers connect, TLS, headers and the entire response body, not just inactivity.
      const timer = setTimeout(() => fail(new OAuthTransportError("timeout")), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      const selected = plan.addresses[0]!;
      try {
        request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
          {
            protocol: url.protocol,
            hostname: plan.hostname,
            port: plan.port,
            path: url.pathname + url.search,
            method,
            headers: Object.fromEntries(headers),
            agent: false,
            family: selected.family,
            maxHeaderSize: 16 * 1024,
            ...(url.protocol === "https:"
              ? {
                  rejectUnauthorized: true,
                  ...(!isIP(plan.hostname) ? { servername: plan.hostname } : {}),
                }
              : {}),
            lookup(_hostname, _options, callback) {
              callback(null, selected.address, selected.family);
            },
          },
          (incoming) => {
            response = incoming;
            incoming.on("error", () => fail(new OAuthTransportError("network_error")));
            incoming.on("aborted", () => fail(new OAuthTransportError("network_error")));
            if (settled) {
              incoming.destroy();
              return;
            }
            if (
              incoming.rawHeaders.reduce((n, value) => n + Buffer.byteLength(value) + 2, 0) >
              16 * 1024
            ) {
              fail(new OAuthTransportError("response_too_large"));
              return;
            }
            const status = incoming.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              fail(new OAuthTransportError("redirect_denied"));
              return;
            }
            const encoding = incoming.headers["content-encoding"];
            if (encoding && encoding.toLowerCase() !== "identity") {
              fail(new OAuthTransportError("encoding_denied"));
              return;
            }
            const length = incoming.headers["content-length"];
            if (length && (!/^\d+$/.test(length) || Number(length) > maxResponse)) {
              fail(new OAuthTransportError("response_too_large"));
              return;
            }
            const chunks: Uint8Array[] = [];
            let size = 0;
            incoming.on("data", (chunk: Uint8Array) => {
              if (settled) return;
              size += chunk.byteLength;
              if (size > maxResponse) {
                fail(new OAuthTransportError("response_too_large"));
                return;
              }
              chunks.push(chunk);
            });
            incoming.on("end", () => {
              if (settled) return;
              try {
                const bytes = new Uint8Array(size);
                let offset = 0;
                for (const chunk of chunks) {
                  bytes.set(chunk, offset);
                  offset += chunk.byteLength;
                }
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(incoming.headers)) {
                  if (Array.isArray(value))
                    for (const item of value) responseHeaders.append(name, item);
                  else if (value !== undefined) responseHeaders.set(name, value);
                }
                const result = new Response([204, 205, 304].includes(status) ? null : bytes, {
                  status,
                  headers: responseHeaders,
                });
                settled = true;
                cleanup();
                resolve(result);
              } catch {
                fail(new OAuthTransportError("network_error"));
              }
            });
          },
        );
        request.on("error", () => fail(new OAuthTransportError("network_error")));
        request.end(body);
      } catch {
        fail(new OAuthTransportError("network_error"));
      }
    });
  };
};
