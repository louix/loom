import { z } from "zod";

const port = z.int().min(1).max(65535);
const mapping = z.strictObject({ host: port, guest: port });
/** Trusted host configuration only. Numbers forward the same port on both sides. */
export const hostPortsSchema = z
  .array(z.union([port, mapping]))
  .max(64)
  .default([]);
export const guestPortsSchema = hostPortsSchema;
export type PortForward = z.output<typeof mapping>;
export type PortForwardInput = number | PortForward;

const normalize = (value: unknown, direction: "host_ports" | "guest_ports"): PortForward[] => {
  const listeners = new Map<number, PortForward>();
  for (const entry of hostPortsSchema.parse(value)) {
    const pair = typeof entry === "number" ? { host: entry, guest: entry } : entry;
    const listener = direction === "host_ports" ? pair.guest : pair.host;
    const previous = listeners.get(listener);
    if (previous && (previous.host !== pair.host || previous.guest !== pair.guest))
      throw new Error(`${direction}: conflicting mappings for listener port ${listener}`);
    listeners.set(listener, pair);
  }
  return [...listeners.values()];
};

const checkGuestPorts = (ports: PortForward[], direction: string, occupied: number[]) => {
  for (const { guest } of ports)
    if ([3128, 3129, ...occupied].includes(guest))
      throw new Error(`${direction}: guest port ${guest} conflicts with a Loom guest listener`);
};

export const normalizeHostPorts = (value: unknown, occupied: number[] = []): PortForward[] => {
  const ports = normalize(value, "host_ports");
  checkGuestPorts(ports, "host_ports", occupied);
  return ports;
};

export const normalizeGuestPorts = (value: unknown, occupied: number[] = []): PortForward[] => {
  const ports = normalize(value, "guest_ports");
  checkGuestPorts(ports, "guest_ports", occupied);
  return ports;
};

export const normalizePortForwards = (
  host: unknown,
  guest: unknown,
  occupied: number[] = [],
): { hostPorts: PortForward[]; guestPorts: PortForward[] } => {
  const hostPorts = normalizeHostPorts(host, occupied);
  const guestPorts = normalizeGuestPorts(guest, occupied);
  for (const exposed of guestPorts)
    if (hostPorts.some((target) => target.host === exposed.host || target.guest === exposed.guest))
      throw new Error(
        "host_ports and guest_ports overlap: a forwarded service cannot target another forward",
      );
  return { hostPorts, guestPorts };
};

/** Fixed diagnostic across the supervisor boundary; never forwards raw backend errors. */
export class GuestPortBindError extends Error {
  constructor(port: number, cause: unknown) {
    super(`Cannot publish guest_ports on host 127.0.0.1:${port}; port is occupied or unavailable`, {
      cause,
    });
  }
}
