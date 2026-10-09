import { join } from "node:path";
import type { EnvironmentStorage } from "@loom/isolation/storage";
import { withStoppedVmState } from "./stopped-state.ts";

/**
 * Persistent VM state under one caller-owned root, one directory per environment.
 * The root must be canonical and outside every workspace; the launcher enforces the latter.
 */
export const directoryEnvironmentStorage = (root: string): EnvironmentStorage => {
  const directory = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid environment identity");
    return join(root, id);
  };
  return {
    directory,
    withStopped: (id, action) => withStoppedVmState(directory(id), () => action()),
  };
};
