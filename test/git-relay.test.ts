import assert from "node:assert/strict";
import { join } from "node:path";
import { gitRelayFixture as fixture, packet, text } from "../scripts/lib/git-relay-fixture.ts";
import {
  gitPolicySchema,
  gitServiceArguments,
  parseGitRequest,
} from "../runtime/src/session-vm/git-relay.ts";

Deno.test("git request accepts two services on one fixed path", () => {
  const request = (line: string) => parseGitRequest(new TextEncoder().encode(line));
  assert.equal(request("git-upload-pack /repo\0host=127.0.0.1:3129\0"), "git-upload-pack");
  assert.equal(request("git-receive-pack /repo\0host=x\0\0version=2\0"), "git-receive-pack");
  assert.equal(request("git-upload-pack /repo\n"), "git-upload-pack");
  for (const line of [
    "git-upload-archive /repo\0",
    "git-upload-pack /repo/.git\0",
    "git-upload-pack /\0",
    "git-upload-pack /repo /etc\0",
    "git-upload-pack  /repo\0",
    "git-upload-pack --upload-pack=sh /repo\0",
    "upload-pack /repo\0",
    "",
  ])
    assert.equal(request(line), undefined, line);
});

Deno.test("git policy rejects names that could alter the host command", () => {
  const ok = (value: unknown) => gitPolicySchema.safeParse(value).success;
  assert.ok(ok({ branch: "loom/abc12345", base: "release/1.2", visible: ["refs/tags/"] }));
  for (const branch of ["", "-c", "a..b", "a b", "a\nb", "a/", "/a", "a//b", "a.lock", "a@{1}"])
    assert.ok(!ok({ branch, base: "main" }), branch);
  for (const visible of ["refs/", "heads/main", "!refs/heads/x", "^refs/heads/x", "refs/*"])
    assert.ok(!ok({ branch: "loom/a", base: "main", visible: [visible] }), visible);
  assert.ok(!ok({ branch: "loom/a", base: "main", extra: true }));
  const push = gitServiceArguments(
    "git-receive-pack",
    { branch: "b", base: "main", visible: [] },
    9,
  );
  assert.ok(!push.some((arg) => arg.includes("refs/heads/main")), "the base is never writable");
  assert.ok(push.includes("core.hooksPath=/dev/null"));
});

Deno.test("git relay refuses other requests without starting Git", async () => {
  const f = await fixture({ requestTimeoutMs: 200 });
  try {
    const ask = async (bytes: Uint8Array) => {
      const conn = await Deno.connect({ transport: "unix", path: f.socket });
      await conn.write(bytes);
      const chunks: Uint8Array[] = [];
      try {
        for await (const chunk of conn.readable) chunks.push(chunk);
      } catch (error) {
        // Dropping a request with unread bytes resets the connection instead of ending it.
        if (!(error instanceof Deno.errors.ConnectionReset)) throw error;
      }
      return text(new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer()));
    };
    assert.match(await ask(packet("git-upload-archive /repo\0host=x\0")), /ERR unsupported/);
    assert.match(await ask(packet(`git-upload-pack ${f.host}\0host=x\0`)), /ERR unsupported/);
    assert.equal(await ask(new TextEncoder().encode("ffff" + "x".repeat(64))), "");
    assert.equal(await ask(new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n")), "");
    // A client that never completes its request is dropped at the deadline.
    assert.equal(await ask(new TextEncoder().encode("00")), "");
    await f.setPolicy({ branch: "-c core.sshCommand=x", base: "main" });
    assert.match(await ask(packet("git-upload-pack /repo\0host=x\0")), /ERR session Git policy/);
  } finally {
    await f.close();
  }
});

Deno.test("guest reads only the parent branch and its own branch", async () => {
  const f = await fixture();
  try {
    for (const version of ["0", "2"]) {
      const refs = await f.git(f.root, "-c", `protocol.version=${version}`, "ls-remote", f.url);
      assert.deepEqual(
        refs.split("\n").map((line) => line.split("\t")[1]),
        ["refs/heads/loom/own", "refs/heads/main"],
      );
    }
    const guest = await f.clone();
    assert.equal(
      await f.git(guest, "branch", "-r", "--format=%(refname:short)"),
      "origin/loom/own\norigin/main",
    );
    for (const hidden of [f.secret, f.secretBlob])
      for (const version of ["0", "2"]) {
        const fetched = await f.run(guest, [
          "-c",
          `protocol.version=${version}`,
          "fetch",
          "origin",
          hidden,
        ]);
        assert.ok(!fetched.ok, `hidden object ${hidden} served under protocol ${version}`);
        assert.ok(!(await f.run(guest, ["cat-file", "-e", hidden])).ok);
      }
    for (const ref of [
      "refs/heads/secret",
      "refs/heads/loom/sibling",
      "refs/heads/mainline",
      "refs/tags/v1",
      "HEAD",
    ])
      assert.ok(!(await f.run(guest, ["fetch", "origin", ref])).ok, ref);

    // A filtered clone would later need by-hash wants, so the filter is not honoured.
    const filtered = await f.clone("--filter=blob:none", "--no-checkout");
    const blob = await f.git(f.host, "rev-parse", "main:file.txt");
    assert.ok((await f.run(filtered, ["cat-file", "-e", blob], { GIT_NO_LAZY_FETCH: "1" })).ok);

    await f.setPolicy({ branch: "loom/own", base: "main", visible: ["refs/tags/"] });
    assert.match(await f.git(f.root, "ls-remote", f.url), /refs\/tags\/v1$/m);
    assert.doesNotMatch(await f.git(f.root, "ls-remote", f.url), /secret|sibling|mainline|HEAD/);
  } finally {
    await f.close();
  }
});

Deno.test("guest moves only its own branch", async () => {
  const f = await fixture();
  try {
    const guest = await f.clone();
    await f.git(guest, "checkout", "-qB", "loom/own", "origin/loom/own");
    await Deno.writeTextFile(join(guest, "work.txt"), "work\n");
    await f.git(guest, "add", "work.txt");
    await f.git(guest, "commit", "-qm", "work");
    await f.git(guest, "push", "-q", "origin", "loom/own");
    assert.equal(await f.git(f.host, "log", "-1", "--format=%s", "loom/own"), "work");

    await f.git(guest, "commit", "-q", "--amend", "-m", "rewritten");
    await f.git(guest, "push", "-q", "origin", "+loom/own");
    assert.equal(await f.git(f.host, "log", "-1", "--format=%s", "loom/own"), "rewritten");

    const before = await f.git(f.host, "show-ref");
    for (const refspec of [
      "loom/own:main",
      "+loom/own:main",
      "loom/own:loom/sibling",
      "loom/own:secret",
      "loom/own:refs/heads/new",
      "loom/own:refs/tags/v2",
      "loom/own:refs/heads/loom/own/nested",
      "loom/own:refs/loom/other",
      ":loom/own",
      ":main",
    ]) {
      const pushed = await f.run(guest, ["push", "origin", refspec]);
      assert.ok(!pushed.ok, `${refspec} was accepted`);
    }
    assert.equal(await f.git(f.host, "show-ref"), before);

    // Looking at the session branch on the host must not let a push rewrite that checkout.
    await f.git(f.host, "checkout", "-q", "loom/own");
    await f.git(guest, "commit", "-q", "--allow-empty", "-m", "while checked out");
    assert.ok(!(await f.run(guest, ["push", "origin", "loom/own"])).ok);
    assert.equal(await f.git(f.host, "log", "-1", "--format=%s", "loom/own"), "rewritten");
    await f.git(f.host, "checkout", "-q", "secret");
    await f.git(guest, "push", "-q", "origin", "loom/own");

    await assert.rejects(Deno.stat(f.ran), Deno.errors.NotFound, "a repository hook ran");

    // A rename takes effect on the next connection without restarting the relay.
    await f.git(f.host, "branch", "-m", "loom/own", "loom/renamed");
    await f.setPolicy({ branch: "loom/renamed", base: "main" });
    assert.ok(!(await f.run(guest, ["push", "origin", "loom/own"])).ok);
    await f.git(guest, "commit", "-q", "--allow-empty", "-m", "after rename");
    await f.git(guest, "push", "-q", "origin", "loom/own:loom/renamed");
    assert.equal(await f.git(f.host, "log", "-1", "--format=%s", "loom/renamed"), "after rename");
  } finally {
    await f.close();
  }
});

Deno.test("push advertisement does not disclose hidden history", async () => {
  const f = await fixture();
  try {
    const conn = await Deno.connect({ transport: "unix", path: f.socket });
    await conn.write(packet("git-receive-pack /repo\0host=x\0"));
    let seen = "";
    const buffer = new Uint8Array(65536);
    while (!seen.includes("0000")) {
      const count = await conn.read(buffer);
      if (count === null) break;
      seen += text(buffer.subarray(0, count));
    }
    conn.close();
    assert.match(seen, /refs\/heads\/loom\/own/);
    assert.doesNotMatch(seen, /refs\/heads\/(main|secret|mainline)|sibling|HEAD|\.have/);
    assert.ok(!seen.includes(f.secret));
  } finally {
    await f.close();
  }
});

Deno.test("git relay bounds connections and shutdown ends running services", async () => {
  const f = await fixture({ maxConnections: 1 });
  try {
    const held = await Deno.connect({ transport: "unix", path: f.socket });
    await held.write(packet("git-upload-pack /repo\0host=x\0"));
    const first = new Uint8Array(4);
    await held.read(first);
    assert.match(text(first), /^[0-9a-f]{4}$/);

    const extra = await Deno.connect({ transport: "unix", path: f.socket });
    const reply = new Uint8Array(256);
    const count = await extra.read(reply);
    assert.match(text(reply.subarray(0, count ?? 0)), /ERR too many/);
    extra.close();

    await f.relay.close();
    await f.relay.close();
    const rest = new Uint8Array(65536);
    let ended = false;
    for (let i = 0; i < 64 && !ended; i++)
      ended = (await held.read(rest).catch(() => null)) === null;
    assert.ok(ended, "shutdown must disconnect a running service");
    held.close();
  } finally {
    await f.close();
  }
});

Deno.test("configured visible refs can never expose session branches", async () => {
  const { gitVisibleRefsSchema } = await import("../runtime/src/session-vm/git-relay.ts");
  assert.deepEqual(gitVisibleRefsSchema.parse(undefined), []);
  assert.ok(gitVisibleRefsSchema.safeParse(["refs/tags/", "refs/heads/develop"]).success);
  for (const value of [
    "refs/heads/",
    "refs/heads",
    "refs/heads/loom/",
    "refs/heads/loom/abc",
    "refs/",
  ])
    assert.ok(!gitVisibleRefsSchema.safeParse([value]).success, value);
});
