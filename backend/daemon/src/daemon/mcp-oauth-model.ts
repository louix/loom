import { z } from "zod";
import { createHash } from "node:crypto";
import { validateOAuthUrl } from "./mcp-oauth-endpoint.ts";

export type McpOAuthErrorCode =
  | "invalid_config"
  | "storage_unavailable"
  | "storage_corrupt"
  | "storage_unsafe"
  | "config_changed"
  | "stale_login"
  | "lock_timeout"
  | "cancelled"
  | "callback_unavailable"
  | "login_timeout"
  | "authorization_rejected"
  | "registration_required"
  | "registration_failed"
  | "client_auth_unsupported"
  | "secret_failed"
  | "exchange_failed"
  | "refresh_failed"
  | "login_required"
  | "invalidation_incomplete";
export class McpOAuthError extends Error {
  readonly code: McpOAuthErrorCode;
  constructor(code: McpOAuthErrorCode) {
    super("MCP OAuth: " + code);
    this.name = "McpOAuthError";
    this.code = code;
  }
}
const text = z
  .string()
  .min(1)
  .max(65536)
  // eslint-disable-next-line no-control-regex -- Reject control bytes in stored credentials.
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s));
export const oauthScopesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/),
  )
  .max(128);
export const mcpOAuthConfigSchema = z
  .strictObject({
    client_id: text.optional(),
    client_secret_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    client_secret_command: z
      .array(
        z
          .string()
          .max(8192)
          .refine((s) => !s.includes("\0")),
      )
      .min(1)
      .max(64)
      .refine((a) => !!a[0]?.trim())
      .optional(),
    redirect_port: z.number().int().min(1).max(65535).optional(),
    scopes: oauthScopesSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.client_secret_env && v.client_secret_command)
      ctx.addIssue({ code: "custom", message: "Choose one client secret source" });
    if ((v.client_secret_env || v.client_secret_command) && !v.client_id)
      ctx.addIssue({ code: "custom", message: "Client secret requires client_id" });
  });
export type McpOAuthConfig = z.infer<typeof mcpOAuthConfigSchema>;
export const parseMcpOAuthConfig = (value: unknown): McpOAuthConfig => {
  const parsed = mcpOAuthConfigSchema.safeParse(value);
  if (!parsed.success) throw new McpOAuthError("invalid_config");
  return parsed.data;
};
export const oauthHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const url = z
  .string()
  .max(8192)
  .refine((s) => {
    try {
      validateOAuthUrl(s, true);
      return true;
    } catch {
      return false;
    }
  });
const identitySchema = z.strictObject({
  name: z.string().min(1).max(256),
  resource: url,
  config: z.string().regex(/^[a-f0-9]{64}$/),
});
export type McpOAuthIdentity = z.infer<typeof identitySchema>;
export const mcpOAuthIdentity = (
  name: string,
  resource: string,
  value: unknown,
): McpOAuthIdentity => {
  const config = parseMcpOAuthConfig(value);
  const normalized = {
    client_id: config.client_id,
    client_secret_env: config.client_secret_env,
    client_secret_command: config.client_secret_command,
    redirect_port: config.redirect_port,
    scopes: config.scopes === undefined ? undefined : [...new Set(config.scopes)].sort(),
  };
  const result = identitySchema.safeParse({
    name,
    resource: validateOAuthUrl(resource, true).href,
    config: oauthHash(JSON.stringify(normalized)),
  });
  if (!result.success) throw new McpOAuthError("invalid_config");
  return result.data;
};
const callback = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return (
      u.protocol === "http:" &&
      u.hostname === "127.0.0.1" &&
      !!u.port &&
      u.port !== "0" &&
      u.pathname === "/callback" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
});
export const mcpOAuthCredentialSchema = z.strictObject({
  identity: identitySchema,
  issuer: url,
  endpoints: z.strictObject({
    authorization: url,
    token: url,
    registration: url.optional(),
    revocation: url.optional(),
  }),
  client: z
    .strictObject({
      id: text,
      secret: text.optional(),
      authMethod: z.enum(["none", "client_secret_basic", "client_secret_post"]),
      dynamic: z.boolean(),
      redirectUri: callback,
    })
    .refine((v) => (v.authMethod === "none" ? v.secret === undefined : v.secret !== undefined)),
  accessToken: text,
  refreshToken: text.optional(),
  expiresAt: z.number().finite().positive().optional(),
  issuedAt: z.number().finite().positive().optional(),
  loginId: z.string().uuid().optional(),
  rejected: z.boolean().optional(),
  recoveryPending: z.boolean().optional(),
  retryAt: z.number().finite().nonnegative().optional(),
  refreshFailures: z.number().int().nonnegative().max(8).optional(),
  lastForcedAt: z.number().finite().nonnegative().optional(),
  scopes: oauthScopesSchema.optional(),
});
export type McpOAuthCredential = z.infer<typeof mcpOAuthCredentialSchema>;
export const sameOAuthIdentity = (a: McpOAuthIdentity, b: McpOAuthIdentity): boolean =>
  a.name === b.name && a.resource === b.resource && a.config === b.config;
export const mcpOAuthStateSchema = z.strictObject({
  version: z.literal(1),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  credential: mcpOAuthCredentialSchema.optional(),
});
export type McpOAuthState = z.infer<typeof mcpOAuthStateSchema>;
