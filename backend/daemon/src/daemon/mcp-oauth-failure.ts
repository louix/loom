import * as oauth from "oauth4webapi";
import { OAuthDiscoveryError } from "./mcp-oauth-challenge.ts";
import { OAuthTransportError } from "./mcp-oauth-endpoint.ts";
import { McpOAuthError } from "./mcp-oauth-model.ts";

const REASON_MAX_CHARS = 300;

/** Server-supplied text reaches a terminal: printable ASCII only, bounded. */
export const safeOAuthText = (text: string): string => {
  const printable = text.replace(/[^\x20-\x7e]/g, "?");
  return printable.length > REASON_MAX_CHARS
    ? printable.slice(0, REASON_MAX_CHARS) + "..."
    : printable;
};

/**
 * Safe cause of a failed OAuth step. oauth4webapi messages interpolate only labels, never
 * response values; other native errors can carry URLs or bodies, so only their name shows.
 */
export const showOAuthFailure = (error: unknown): string => {
  if (error instanceof McpOAuthError) return error.reason ?? error.code;
  if (error instanceof OAuthDiscoveryError) return "discovery " + error.code;
  if (error instanceof OAuthTransportError) return "transport " + error.code;
  if (error instanceof oauth.ResponseBodyError)
    return safeOAuthText(
      "HTTP " +
        error.status +
        " " +
        error.error +
        (error.error_description ? ": " + error.error_description : ""),
    );
  if (error instanceof oauth.WWWAuthenticateChallengeError)
    return safeOAuthText(
      "HTTP " +
        error.status +
        " challenge " +
        error.cause.map((c) => c.parameters.error ?? c.scheme).join(", "),
    );
  if (error instanceof oauth.OperationProcessingError)
    return safeOAuthText(
      (error.cause instanceof Response ? "HTTP " + error.cause.status + ": " : "") + error.message,
    );
  return "unexpected " + (error instanceof Error ? error.name : typeof error);
};
