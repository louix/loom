import { z } from "zod";

/** Trusted host configuration only. Each guest port forwards to the same host port. */
export const hostPortsSchema = z.array(z.int().min(1).max(65535)).max(64).default([]);

export const normalizeHostPorts = (value: unknown, occupied: number[] = []): number[] => {
  const ports = [...new Set(hostPortsSchema.parse(value))];
  for (const port of ports)
    if ([3128, 3129, ...occupied].includes(port))
      throw new Error(`host_ports: port ${port} conflicts with a Loom guest listener`);
  return ports;
};
