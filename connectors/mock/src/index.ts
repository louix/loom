/**
 * `@loom/connector-mock` — the SDK-free scriptable provider the tests drive and
 * `loom run --provider fake` uses. A production install of `loom` does not
 * ship it; it is a devDependency.
 */
import type { ConnectorContext } from "@loom/core/connector";
import { FakeProvider } from "./fake.ts";

export { FakeProvider, fakeSessionId } from "./fake.ts";
export type { FakeSession } from "./fake.ts";

export const createProvider = (_ctx: ConnectorContext): FakeProvider => {
  return new FakeProvider();
};
