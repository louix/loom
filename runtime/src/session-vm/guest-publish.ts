/** Guest-only: clone sessions publish their branch through the Git relay after each turn. */
import type { HarnessEvent } from "../../../core/src/events.ts";
import { checkoutSchema, publishCheckout, type Checkout } from "./checkout.ts";

export const readGuestCheckout = async (): Promise<Checkout | undefined> => {
  try {
    return checkoutSchema.parse(
      JSON.parse(await Deno.readTextFile("/run/loom/private/checkout.json")),
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};

/** The host ref is current before the daemon learns the turn ended. */
export const publishAfterTurn =
  (checkout: Checkout | undefined) =>
  async (event: HarnessEvent): Promise<HarnessEvent | void> => {
    if (!checkout || event.type !== "result") return;
    // The daemon republishes the spec after a rename; a failed push is retried next turn.
    try {
      await publishCheckout(
        checkoutSchema.parse(
          JSON.parse(await Deno.readTextFile("/run/loom/private/checkout.json")),
        ),
      );
    } catch {
      return {
        type: "error" as const,
        sessionId: event.sessionId,
        ts: Date.now(),
        fatal: false,
        message:
          "Git publication failed. Commits are still in this session's private checkout; the host branch may be out of date. Retry git push before removing the session.",
      };
    }
  };
