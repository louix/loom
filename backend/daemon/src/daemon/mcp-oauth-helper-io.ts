import { OAuthTransportError } from "./mcp-oauth-endpoint.ts";

/** Bounds apply to bytes before decoding/parsing. Also used on untrusted child output. */
export const readOAuthJson = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<unknown> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new OAuthTransportError("response_too_large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

export const writeOAuthJson = async (
  stream: WritableStream<Uint8Array>,
  value: unknown,
): Promise<void> => {
  const writer = stream.getWriter();
  try {
    await writer.write(new TextEncoder().encode(JSON.stringify(value)));
    await writer.close();
  } finally {
    writer.releaseLock();
  }
};

export const oauthRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OAuthTransportError("network_error");
  return value as Record<string, unknown>;
};
