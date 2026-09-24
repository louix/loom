export type OAuthDiscoveryCode =
  | "invalid_challenge"
  | "invalid_metadata"
  | "metadata_unavailable"
  | "issuer_mismatch"
  | "unsupported_authorization_server"
  | "scope_override_missing"
  | "discovery_limit";

export class OAuthDiscoveryError extends Error {
  readonly code: OAuthDiscoveryCode;
  constructor(code: OAuthDiscoveryCode) {
    super("MCP OAuth discovery: " + code);
    this.name = "OAuthDiscoveryError";
    this.code = code;
  }
}

export interface OAuthChallenge {
  resourceMetadata?: string;
  scope?: string;
}

const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const parameter = new RegExp(
  "^(" + token + ")\\s*=\\s*(" + token + '|"(?:[\\t !#-\\[\\]-~]|\\\\[\\t -~])*")$',
);
const scheme = new RegExp("^(" + token + ")(?:[ \\t]+(.*))?$");

/** Split only outside quoted strings; a comma inside realm/scope is data. */
export const parseOAuthChallenge = (header: string | null): OAuthChallenge => {
  if (!header) return {};
  const fail = (): never => {
    throw new OAuthDiscoveryError("invalid_challenge");
  };
  if (header.length > 16384 || /[^\t\x20-\x7e]/.test(header)) fail();
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (!quoted && c === ",") {
      parts.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quoted || escaped) fail();
  parts.push(header.slice(start).trim());
  let current = "";
  let bearer: Map<string, string> | undefined;
  for (const part of parts) {
    if (!part) continue; // HTTP list syntax permits empty members.
    let match = parameter.exec(part);
    if (!match) {
      const challenge = scheme.exec(part);
      if (!challenge) fail();
      current = challenge![1]!.toLowerCase();
      if (current === "bearer") {
        if (bearer) fail(); // Do not silently choose among conflicting Bearer challenges.
        bearer = new Map();
      }
      if (!challenge![2]) continue;
      match = parameter.exec(challenge![2]!);
      if (!match && current === "bearer") fail();
    }
    if (current === "bearer" && match) {
      const key = match[1]!.toLowerCase();
      if (bearer!.has(key)) fail();
      const raw = match[2]!;
      const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
      bearer!.set(key, value);
    } else if (!current) fail();
  }
  const result: OAuthChallenge = {};
  if (bearer?.has("resource_metadata")) result.resourceMetadata = bearer.get("resource_metadata")!;
  if (bearer?.has("scope")) result.scope = bearer.get("scope")!;
  return result;
};
