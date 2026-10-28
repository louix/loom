import { GuestPortBindError } from "../../../core/src/host-ports.ts";
import { startGuestRelay } from "./guest-relay.ts";
import { MCP_CONNECTION_LIMIT } from "./relay-limits.ts";

/** Host-only listener: the private Unix socket leads to one fixed guest TCP port. */
export const startPublishedPort = (socket: string, port: number) => {
  let listener: Deno.TcpListener;
  try {
    listener = Deno.listen({ hostname: "127.0.0.1", port });
  } catch (cause) {
    throw new GuestPortBindError(port, cause);
  }
  return {
    addr: listener.addr,
    ...startGuestRelay(listener, socket, MCP_CONNECTION_LIMIT, { kind: "guest_port", index: port }),
  };
};
