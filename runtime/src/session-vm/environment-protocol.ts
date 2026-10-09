/** Readiness/lifetime channel for a guest environment, independent of agent protocols. */
const readyFrame = new TextEncoder().encode('{"loomEnvironmentReady":1}\n');

/** The only stdout message is readiness. Commands use separate smolvm exec streams. */
export const readEnvironmentOutput = async (
  stream: ReadableStream<Uint8Array>,
  ready: () => void | Promise<void>,
): Promise<void> => {
  let offset = 0;
  let announced = false;
  for await (const chunk of stream) {
    for (const byte of chunk) {
      if (offset >= readyFrame.length || byte !== readyFrame[offset])
        throw new Error("Invalid environment readiness output");
      offset++;
    }
    if (offset === readyFrame.length && !announced) {
      announced = true;
      await ready();
    }
  }
  if (offset !== readyFrame.length) throw new Error("Environment exited before readiness");
};

export const writeEnvironmentReady = async (stream: WritableStream<Uint8Array>) => {
  const writer = stream.getWriter();
  try {
    await writer.write(readyFrame);
  } finally {
    writer.releaseLock();
  }
};

/** The caller exits after this returns, closing any guest-owned relays. */
export const serveEnvironment = async (
  initialize: () => Promise<void>,
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
): Promise<void> => {
  await initialize();
  await writeEnvironmentReady(output);
  for await (const chunk of input) {
    if (chunk.length) throw new Error("Environment control channel does not accept commands");
  }
};
