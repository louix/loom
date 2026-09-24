import type { McpOAuthRelayState } from "../../../../core/src/mcp-worker.ts";
import { createMcpOAuthStore, type McpOAuthStore } from "./mcp-oauth-store.ts";
import {
  mcpOAuthIdentity,
  sameOAuthIdentity,
  type McpOAuthConfig,
  type McpOAuthState,
} from "./mcp-oauth-model.ts";
import {
  oauthUsable,
  refreshMcpOAuth,
  rejectMcpOAuth,
  acceptMcpOAuth,
} from "./mcp-oauth-tokens.ts";
import { registerOAuthOwner } from "./mcp-oauth-lease.ts";
import { mcpOAuthDiagnostic } from "./mcp-oauth-status.ts";
import { startMcpWorker, type ManagedMcp } from "./mcp-worker.ts";

const owners = new Map<string, OAuthOwner>();
class OAuthOwner {
  readonly store: McpOAuthStore;
  readonly identity;
  readonly workers = new Map<ManagedMcp, (message: string) => void>();
  lease: Awaited<ReturnType<typeof registerOAuthOwner>> | undefined;
  state: McpOAuthState = { version: 1, generation: 0 };
  chain: Promise<unknown> = Promise.resolve();
  timer: ReturnType<typeof setTimeout> | undefined;
  lastNotice = "";
  readonly name: string;
  readonly url: string;
  constructor(name: string, url: string, config: McpOAuthConfig) {
    this.name = name;
    this.url = url;
    this.store = createMcpOAuthStore(name);
    this.identity = mcpOAuthIdentity(name, url, config);
  }
  serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run);
    this.chain = result.catch(() => {});
    return result;
  }
  relay(state: McpOAuthState): McpOAuthRelayState {
    const c = state.credential;
    return {
      generation: state.generation,
      ...(c && sameOAuthIdentity(c.identity, this.identity) && oauthUsable(c)
        ? {
            accessToken: c.accessToken,
            ...(c.expiresAt === undefined ? {} : { expiresAt: c.expiresAt }),
          }
        : {}),
    };
  }
  async apply(state: McpOAuthState) {
    if (state.generation !== this.state.generation) {
      const relay = this.relay(state);
      const previous = this.state.credential;
      const replacement =
        !!state.credential &&
        !!previous &&
        (state.credential.loginId !== previous.loginId ||
          !sameOAuthIdentity(state.credential.identity, previous.identity) ||
          state.credential.client.id !== previous.client.id ||
          state.credential.issuer !== previous.issuer);
      for (const worker of this.workers.keys())
        await worker.updateOAuth!(relay, !state.credential || replacement);
      this.state = state;
    }
    await this.lease?.acknowledge(state.generation);
    const c = state.credential;
    let reason = "";
    if (c && !sameOAuthIdentity(c.identity, this.identity)) reason = "config_changed";
    else if (!this.relay(state).accessToken)
      reason = c?.retryAt ? "refresh_failed" : "login_required";
    if (reason !== this.lastNotice) {
      this.lastNotice = reason;
      if (reason)
        for (const notice of this.workers.values()) notice(mcpOAuthDiagnostic(this.name, reason));
    }
  }
  async sync() {
    await this.apply(await this.store.read());
    await this.apply(await refreshMcpOAuth(this.store, this.identity));
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.workers.size) return;
    this.timer = setTimeout(() => {
      void this.serial(async () => {
        try {
          await this.sync();
        } catch {
          // A store/relay failure cannot leave an untracked credential in use.
          await Promise.allSettled([...this.workers.keys()].map((worker) => worker.close()));
        }
        this.schedule();
      });
    }, 1000);
  }
  async mount(
    start: typeof startMcpWorker,
    notice: (message: string) => void,
  ): Promise<ManagedMcp> {
    return await this.serial(async () => {
      if (!this.lease) {
        await this.store.transact(async (state) => {
          this.lease = await registerOAuthOwner(this.store);
          this.state = state;
          return undefined;
        });
      }
      let mounting: ManagedMcp | undefined;
      try {
        await this.sync();
        if (!this.relay(this.state).accessToken)
          throw new Error(mcpOAuthDiagnostic(this.name, this.lastNotice));
        const worker = await start(this.name, { transport: "http", url: this.url }, undefined, {
          initial: this.relay(this.state),
          report: (kind, generation) => {
            void this.serial(async () => {
              if (kind === "unauthorized")
                await rejectMcpOAuth(this.store, this.identity, generation);
              else await acceptMcpOAuth(this.store, this.identity, generation);
              await this.sync();
            }).catch(async () => {
              await worker.close();
            });
          },
        });
        mounting = worker;
        this.workers.set(worker, notice);
        await this.lease!.setWorkers([...this.workers.keys()].map((w) => w.pid));
        // Logout may have raced with launch; synchronize before exposing the relay.
        await this.sync();
        this.schedule();
        let closed: Promise<void> | undefined;
        return {
          ...worker,
          close: () =>
            (closed ??= this.serial(async () => {
              await worker.close();
              this.workers.delete(worker);
              await this.lease?.setWorkers([...this.workers.keys()].map((w) => w.pid));
              if (!this.workers.size) {
                clearTimeout(this.timer);
                await this.lease?.close();
                this.lease = undefined;
                this.state = { version: 1, generation: 0 };
                this.lastNotice = "";
              }
            })),
        };
      } catch (error) {
        if (mounting) {
          await mounting.close();
          this.workers.delete(mounting);
        }
        if (!this.workers.size) {
          await this.lease?.close();
          this.lease = undefined;
          this.state = { version: 1, generation: 0 };
          this.lastNotice = "";
        }
        throw error;
      }
    });
  }
}
export const startOAuthMcp = (
  name: string,
  url: string,
  config: McpOAuthConfig,
  start = startMcpWorker,
  notice: (message: string) => void = () => {},
): Promise<ManagedMcp> => {
  const identity = mcpOAuthIdentity(name, url, config);
  const key = JSON.stringify([createMcpOAuthStore(name).directory, identity]);
  let owner = owners.get(key);
  if (!owner) {
    owner = new OAuthOwner(name, url, config);
    owners.set(key, owner);
  }
  return owner.mount(start, notice);
};
