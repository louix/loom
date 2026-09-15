import { z } from "zod";

/** Extra authority comes only from trusted host configuration. */
export const networkPresets = {
  nix: [
    "cache.nixos.org",
    "channels.nixos.org",
    "releases.nixos.org",
    "tarballs.nixos.org",
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "raw.githubusercontent.com",
    "release-assets.githubusercontent.com",
  ],
  // node-gyp downloads matching Node headers when building native dependencies.
  javascript: ["registry.npmjs.org", "jsr.io", "npm.jsr.io", "nodejs.org"],
  python: ["pypi.org", "files.pythonhosted.org"],
} as const;

export const networkPresetsSchema = z
  .array(z.enum(["nix", "javascript", "python"]))
  .max(16)
  .default([]);
export const extraHostsSchema = z
  .array(
    z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i),
  )
  .max(64)
  .default([]);

export const expandNetworkPresets = (value: unknown): string[] => {
  const result = networkPresetsSchema.safeParse(value);
  if (!result.success)
    throw new Error(`network_presets must contain only: ${Object.keys(networkPresets).join(", ")}`);
  return [...new Set(result.data.flatMap((v) => [...networkPresets[v]]))];
};

export const normalizeExtraHosts = (value: unknown): string[] => {
  const result = extraHostsSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      "extra_allowed_hosts must contain exact DNS names (HTTPS port 443 only; no URLs, IPs or wildcards)",
    );
  return [...new Set(result.data.map((host) => host.toLowerCase()))];
};
