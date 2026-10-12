/**
 * Connections a VM capability serves at once. The guest relay and its host endpoint
 * share each limit, so a client over it is refused by the guest, which reports it.
 */

// Package managers keep idle keep-alive tunnels open while install scripts start new
// clients: pnpm 11.6 defaults to up to 96 concurrent requests, and 32 tunnels left
// node-gyp's header download queued until its connect timeout. A tunnel costs two
// descriptors on each side; Deno raises its soft descriptor limit to the hard one.
export const EGRESS_CONNECTION_LIMIT = 256;
export const MCP_CONNECTION_LIMIT = 32;
/** Above the host Git relay's own limit, whose refusal is a message Git prints. */
export const GIT_GUEST_CONNECTION_LIMIT = 32;
