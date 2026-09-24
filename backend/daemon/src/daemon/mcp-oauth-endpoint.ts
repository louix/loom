/** Network plans contain no credentials. Resolve DNS before constructing a plan. */
import { BlockList, isIP } from "node:net";

export type OAuthTransportCode =
  | "endpoint_denied"
  | "address_denied"
  | "invalid_request"
  | "request_too_large"
  | "response_too_large"
  | "redirect_denied"
  | "encoding_denied"
  | "timeout"
  | "aborted"
  | "network_error";

/** Never expose native errors: they can contain URLs, headers or response bodies. */
export class OAuthTransportError extends Error {
  readonly code: OAuthTransportCode;
  constructor(code: OAuthTransportCode) {
    super("OAuth transport: " + code);
    this.name = "OAuthTransportError";
    this.code = code;
  }
}

const ipv4Denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  ipv4Denied.addSubnet(address, prefix, "ipv4");
const ipv6Global = new BlockList();
ipv6Global.addSubnet("2000::", 3, "ipv6");
const ipv6Denied = new BlockList();
// Conservative special-use exclusions, including transition mechanisms.
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  ipv6Denied.addSubnet(address, prefix, "ipv6");
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const canonicalAddress = (address: string): string => {
  const family = isIP(address);
  if (!family || address.includes("%")) throw new OAuthTransportError("address_denied");
  return family === 6 ? new URL("https://[" + address + "]/").hostname.slice(1, -1) : address;
};
const isLoopback = (address: string): boolean =>
  loopback.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");

export interface OAuthEndpointInput {
  url: string;
  /** Complete DNS answer set, or the literal endpoint address. No hostnames. */
  addresses: readonly string[];
}
export interface OAuthEndpoint {
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  readonly addresses: readonly { readonly address: string; readonly family: 4 | 6 }[];
  /** Exact resolved IP/port permissions for the network helper. */
  readonly net: readonly string[];
}

/** Check URL policy before giving even the credential-free resolver a hostname. */
export const validateOAuthUrl = (input: string, allowLoopback = false): URL => {
  if (input.length > 8192) throw new OAuthTransportError("endpoint_denied");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OAuthTransportError("endpoint_denied");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.port === "0" ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !(allowLoopback === true && isIP(hostname) && isLoopback(hostname)))
  )
    throw new OAuthTransportError("endpoint_denied");
  return url;
};

/** Reject every unsafe answer, rather than selecting a safe answer from a mixed set. */
export const prepareOAuthEndpoint = (
  input: OAuthEndpointInput,
  allowLoopback = false,
): OAuthEndpoint => {
  const url = validateOAuthUrl(input.url, allowLoopback);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!input.addresses.length || input.addresses.length > 16)
    throw new OAuthTransportError("address_denied");
  const unique = [...new Set(input.addresses.map(canonicalAddress))];
  const addresses = unique.map((address) => {
    const family = isIP(address) as 4 | 6;
    // IPv4-mapped IPv6 never qualifies, including mapped loopback.
    const publicAddress =
      family === 4
        ? !ipv4Denied.check(address, "ipv4")
        : ipv6Global.check(address, "ipv6") && !ipv6Denied.check(address, "ipv6");
    const mapped = family === 6 && address.startsWith("::ffff:");
    if (mapped || (!publicAddress && !(allowLoopback === true && isLoopback(address))))
      throw new OAuthTransportError("address_denied");
    if (isIP(hostname) && address !== canonicalAddress(hostname))
      throw new OAuthTransportError("address_denied");
    return Object.freeze({ address, family });
  });
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return Object.freeze({
    url: url.href,
    hostname,
    port,
    addresses: Object.freeze(addresses),
    net: Object.freeze(
      addresses.map(
        ({ address, family }) => (family === 6 ? "[" + address + "]" : address) + ":" + port,
      ),
    ),
  });
};
