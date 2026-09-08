/** Private daemon → external MCP worker bootstrap; never supplied by a connector. */
export const MCP_WORKER_VERSION = 1;
export interface McpWorkerBinding {
  version: typeof MCP_WORKER_VERSION;
  url: string;
  headers: Record<string, string>;
  token: string;
}
export const decodeMcpBinding = (value: unknown): McpWorkerBinding => {
  if (!value || typeof value !== "object") throw new Error("invalid MCP binding");
  const v = value as Record<string, unknown>;
  if (
    v.version !== MCP_WORKER_VERSION ||
    typeof v.url !== "string" ||
    typeof v.token !== "string" ||
    v.token.length < 32 ||
    !v.headers ||
    typeof v.headers !== "object" ||
    Array.isArray(v.headers) ||
    !Object.values(v.headers).every((s) => typeof s === "string")
  ) {
    throw new Error("invalid MCP binding");
  }
  const url = new URL(v.url);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("invalid MCP endpoint");
  }
  // Validate header syntax before accepting the binding.
  new Headers(v.headers as Record<string, string>);
  return v as unknown as McpWorkerBinding;
};
