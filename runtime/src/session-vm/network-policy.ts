/** Extra authority comes only from trusted host configuration. */
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
