/** Attempt every revocation even if VM cleanup fails; retain diagnostics, not credentials. */
export const cleanupSessionVm = async (steps: {
  stop: () => Promise<unknown>;
  reap: () => Promise<unknown>;
  egress: () => Promise<unknown>;
  git: () => Promise<unknown>;
  credentials: () => Promise<unknown>;
  state: () => Promise<unknown>;
}) => {
  const errors: unknown[] = [];
  for (const step of [steps.stop, steps.egress, steps.credentials, steps.reap, steps.git]) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!errors.length) {
    try {
      await steps.state();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Session VM cleanup incomplete; state retained; see cleanup errors",
    );
};
