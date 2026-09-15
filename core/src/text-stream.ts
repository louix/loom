/** Decode UTF-8 incrementally, including characters split across byte chunks. */
export const decodeTextStream = async function* (
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const bytes of chunks) {
    const text = decoder.decode(bytes, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
};
