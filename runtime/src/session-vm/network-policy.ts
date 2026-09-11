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
} as const;

export const expandNetworkPresets = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    !value.every((v) => typeof v === "string" && Object.hasOwn(networkPresets, v))
  )
    throw new Error("network_presets must contain only nix or javascript");
  return [...new Set(value.flatMap((v) => networkPresets[v as keyof typeof networkPresets]))];
};

export const normalizeExtraHosts = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    !value.every(
      (host) =>
        typeof host === "string" &&
        host.length <= 253 &&
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
          host,
        ),
    )
  )
    throw new Error(
      "extra_allowed_hosts must contain exact DNS names (HTTPS port 443 only; no URLs, IPs or wildcards)",
    );
  return [...new Set(value.map((host: string) => host.toLowerCase()))];
};
