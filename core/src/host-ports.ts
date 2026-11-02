import { z } from "zod";

const port = z.int().min(1).max(65535);
const mapping = z.strictObject({ host: port, guest: port });
/** Trusted host configuration only. Numbers forward the same port on both sides. */
export const hostPortsSchema = z
  .array(z.union([port, mapping]))
  .max(64)
  .default([]);
/** Absent means loopback; `0.0.0.0` publishes on every host interface. */
const address = z.ipv4();
const guestMapping = mapping.extend({ host: port.optional(), address: address.optional() });
export const guestPortsSchema = z
  .array(z.union([port, guestMapping]))
  .max(64)
  .default([]);
// Not strict: a newer supervisor may record fields an older reader can skip.
const published = z.object({
  host: port,
  guest: port,
  address: address.optional(),
  /** For a `0.0.0.0` bind: the host's LAN addresses when it was bound. */
  lan: z.array(address).max(16).optional(),
});
export const resolvedPortsSchema = z.array(published).max(64);
export type PortForward = z.output<typeof mapping>;
export type PublishedPort = z.output<typeof published>;
export const showHostAddress = (p: PublishedPort) => {
  const bound = `${p.address ?? "127.0.0.1"}:${p.host}`;
  return p.lan?.length ? `${bound} (${p.lan.map((a) => `${a}:${p.host}`).join(", ")})` : bound;
};
/** One resolved `guest_ports` mapping, as agents read it. */
export const showGuestPort = (p: PublishedPort) =>
  `guest 127.0.0.1:${p.guest} → host ${showHostAddress(p)}`;
export type GuestPortForward = z.output<typeof guestMapping>;
export type PortForwardInput = number | PortForward;
export type GuestPortForwardInput = number | GuestPortForward;
/** Host ports for `{ guest }` entries: Linux's default ephemeral range, on every host OS. */
export const AUTO_HOST_PORTS = { min: 32768, max: 60999 } as const;
export const isAutoHostPort = (port: number) =>
  port >= AUTO_HOST_PORTS.min && port <= AUTO_HOST_PORTS.max;

const normalize = (value: unknown, direction: "host_ports" | "guest_ports"): GuestPortForward[] => {
  const listeners = new Map<string | number, GuestPortForward>();
  for (const entry of (direction === "host_ports" ? hostPortsSchema : guestPortsSchema).parse(
    value,
  )) {
    const pair: GuestPortForward =
      typeof entry === "number" ? { host: entry, guest: entry } : entry;
    const listener = direction === "host_ports" ? pair.guest : (pair.host ?? `auto:${pair.guest}`);
    const previous = listeners.get(listener);
    if (
      previous &&
      (previous.host !== pair.host ||
        previous.guest !== pair.guest ||
        previous.address !== pair.address)
    )
      throw new Error(`${direction}: conflicting mappings for listener port ${listener}`);
    listeners.set(listener, pair);
  }
  return [...listeners.values()];
};

const checkGuestPorts = (ports: GuestPortForward[], direction: string, occupied: number[]) => {
  for (const { guest } of ports)
    if ([3128, 3129, ...occupied].includes(guest))
      throw new Error(`${direction}: guest port ${guest} conflicts with a Loom guest listener`);
};

export const normalizeHostPorts = (value: unknown, occupied: number[] = []): PortForward[] => {
  const ports = normalize(value, "host_ports") as PortForward[];
  checkGuestPorts(ports, "host_ports", occupied);
  return ports;
};

export const normalizeGuestPorts = (
  value: unknown,
  occupied: number[] = [],
): GuestPortForward[] => {
  const ports = normalize(value, "guest_ports");
  checkGuestPorts(ports, "guest_ports", occupied);
  return ports;
};

export const normalizePortForwards = (
  host: unknown,
  guest: unknown,
  occupied: number[] = [],
): { hostPorts: PortForward[]; guestPorts: GuestPortForward[] } => {
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
    super(`Cannot publish guest_ports on host port ${port}; it is occupied or unavailable`, {
      cause,
    });
  }
}
