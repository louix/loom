import { join } from "node:path";
import {
  AUTO_HOST_PORTS,
  GuestPortBindError,
  isAutoHostPort,
  resolvedPortsSchema,
  type GuestPortForward,
  type PublishedPort,
} from "../../../core/src/host-ports.ts";
import { startGuestRelay } from "./guest-relay.ts";
import { MCP_CONNECTION_LIMIT } from "./relay-limits.ts";

/** Host listener, loopback unless `address` says otherwise; the private Unix socket leads to one fixed guest TCP port. */
export const startPublishedPort = (
  socket: string | ((port: number) => string),
  port: number,
  address?: string,
) => {
  let listener: Deno.TcpListener;
  try {
    listener = Deno.listen({ hostname: address ?? "127.0.0.1", port });
  } catch (cause) {
    throw new GuestPortBindError(port, cause);
  }
  const path = typeof socket === "string" ? socket : socket(listener.addr.port);
  return {
    addr: listener.addr,
    socket: path,
    ...startGuestRelay(listener, path, MCP_CONNECTION_LIMIT, {
      kind: "guest_port",
      index: listener.addr.port,
    }),
  };
};

/** Previous addresses are preferences only. Current grants always decide what is published. */
export const readPublishedPorts = async (directory: string): Promise<PublishedPort[]> => {
  try {
    return resolvedPortsSchema.parse(
      JSON.parse(await Deno.readTextFile(join(directory, "guest-ports.json"))),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
};

/** Bind fixed ports first, then probe AUTO_HOST_PORTS for each automatic listener. */
export const startPublishedPorts = async (
  state: string,
  ports: GuestPortForward[],
  previous: PublishedPort[] = [],
  excluded: number[] = [],
) => {
  const started: Array<{ mapping: PublishedPort; relay: ReturnType<typeof startPublishedPort> }> =
    [];
  const unavailable = new Set([
    ...excluded,
    ...ports.flatMap((p) => (p.host === undefined ? [] : [p.host])),
  ]);
  const socket = (port: number) => join(state, `guest-port-${port}.sock`);
  const tryBind = (port: number, address: string | undefined) => {
    try {
      return startPublishedPort(socket, port, address);
    } catch (error) {
      if (!(error instanceof GuestPortBindError)) throw error;
    }
  };
  const span = AUTO_HOST_PORTS.max - AUTO_HOST_PORTS.min + 1;
  try {
    for (const entry of [...ports].sort(
      (a, b) => Number(b.host !== undefined) - Number(a.host !== undefined),
    )) {
      let relay: ReturnType<typeof startPublishedPort> | undefined;
      if (entry.host !== undefined) relay = startPublishedPort(socket, entry.host, entry.address);
      else {
        // A preference outside the range is a leftover fixed mapping, not an allocation.
        const preferred = previous.find(
          (p) => p.guest === entry.guest && p.address === entry.address,
        )?.host;
        if (preferred !== undefined && isAutoHostPort(preferred) && !unavailable.has(preferred))
          relay = tryBind(preferred, entry.address);
        for (let attempt = 0; !relay && attempt < 256; attempt++) {
          const candidate = AUTO_HOST_PORTS.min + Math.floor(Math.random() * span);
          if (!unavailable.has(candidate)) relay = tryBind(candidate, entry.address);
        }
        if (!relay)
          throw new GuestPortBindError(
            AUTO_HOST_PORTS.min,
            new Error(`no free port in ${AUTO_HOST_PORTS.min}-${AUTO_HOST_PORTS.max}`),
          );
      }
      unavailable.add(relay.addr.port);
      started.push({
        mapping: {
          guest: entry.guest,
          host: relay.addr.port,
          ...(entry.address ? { address: entry.address } : {}),
          ...(entry.address === "0.0.0.0" ? { lan: lanAddresses() } : {}),
        },
        relay,
      });
    }
    return started;
  } catch (error) {
    await Promise.all(started.map((p) => p.relay.close()));
    throw error;
  }
};

/** What a phone or another machine can type in; interfaces added later are not listed. */
const lanAddresses = () =>
  [
    ...new Set(
      Deno.networkInterfaces()
        .filter((i) => i.family === "IPv4" && !i.address.startsWith("127."))
        .map((i) => i.address),
    ),
  ].slice(0, 16);
