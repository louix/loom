import assert from "node:assert/strict";
import { test } from "node:test";
import { deniedReview } from "../connectors/chatgpt/src/auto-review.ts";

test("denied reviews preserve terminal input identity and nested permission profiles", () => {
  const base = { reviewId: "r", turnId: "t", review: { status: "denied" } };
  const stdin = deniedReview({
    ...base,
    action: {
      type: "writeStdin",
      approvalId: "child",
      processId: "42",
      stdin: "yes\n",
      cwd: "/tmp",
    },
  });
  assert.deepEqual(stdin?.event["action"], {
    type: "write_stdin",
    approval_id: "child",
    process_id: "42",
    stdin: "yes\n",
    cwd: "/tmp",
  });
  assert.match(String(stdin?.input["reason"]), /No reason was provided/);
  const permissions = { fileSystem: { write: ["/tmp/file"] } };
  assert.deepEqual(
    deniedReview({
      ...base,
      action: {
        type: "requestPermissions",
        permissions,
      },
    })?.event["action"],
    { type: "request_permissions", permissions },
  );
});

test("non-denials and unrecognized or uncorrelated reviews cannot be approved", () => {
  const base = { reviewId: "r", turnId: "t", action: { type: "command" } };
  for (const status of ["approved", "timedOut", "aborted", "inProgress"])
    assert.equal(deniedReview({ ...base, review: { status } }), null);
  for (const override of [{ reviewId: "" }, { turnId: null }, { action: { type: "futureAction" } }])
    assert.equal(deniedReview({ ...base, review: { status: "denied" }, ...override }), null);
});
