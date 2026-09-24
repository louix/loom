import { McpOAuthError } from "./mcp-oauth-model.ts";

export interface OAuthCallback {
  redirectUri: string;
  result: Promise<URLSearchParams>;
  close(): Promise<void>;
}
/** Bind before opening the browser. Invalid requests never consume the attempt. */
export const listenOAuthCallback = (options: {
  issuer: string;
  state: string;
  requireIssuer: boolean;
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): OAuthCallback => {
  if (options.signal?.aborted) throw new McpOAuthError("cancelled");
  const timeoutMs = options.timeoutMs ?? 600000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600000 ||
    (options.port !== undefined &&
      (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535))
  )
    throw new McpOAuthError("invalid_config");
  let resolve!: (params: URLSearchParams) => void;
  let reject!: (error: McpOAuthError) => void;
  const result = new Promise<URLSearchParams>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void result.catch(() => {});
  let settled = false;
  const fail = (code: "cancelled" | "login_timeout" | "authorization_rejected") => {
    if (!settled) {
      settled = true;
      reject(new McpOAuthError(code));
    }
  };
  let server: Deno.HttpServer<Deno.NetAddr>;
  const response = (ok: boolean) =>
    new Response(
      ok ? "Authorization response received. Return to Loom." : "Invalid authorization response.",
      {
        status: ok ? 200 : 400,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
          "referrer-policy": "no-referrer",
        },
      },
    );
  try {
    server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: options.port ?? 0,
        onListen() {},
        onError: () => response(false),
      },
      (req) => {
        if (
          settled ||
          req.method !== "GET" ||
          req.url.length > 8192 ||
          req.headers.get("host") !== "127.0.0.1:" + server.addr.port
        )
          return response(false);
        const url = new URL(req.url);
        const params = url.searchParams;
        if (
          url.pathname !== "/callback" ||
          url.hash ||
          new Set(params.keys()).size !== [...params.keys()].length ||
          params.get("state") !== options.state ||
          (options.requireIssuer && !params.has("iss")) ||
          (params.has("iss") && params.get("iss") !== options.issuer) ||
          params.has("code") === params.has("error") ||
          !(params.get("code") || params.get("error"))
        )
          return response(false);
        if (params.has("error")) fail("authorization_rejected");
        else {
          settled = true;
          resolve(params);
        }
        return response(true);
      },
    );
  } catch {
    throw new McpOAuthError("callback_unavailable");
  }
  const timer = setTimeout(() => fail("login_timeout"), timeoutMs);
  const abort = () => fail("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let closing: Promise<void> | undefined;
  const close = () => {
    if (!closing) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      fail("cancelled");
      closing = server.shutdown();
    }
    return closing;
  };
  // Closing happens for success, rejection, timeout and cancellation.
  void result.then(close, close);
  return { redirectUri: "http://127.0.0.1:" + server.addr.port + "/callback", result, close };
};
